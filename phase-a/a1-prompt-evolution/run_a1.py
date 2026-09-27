"""Run the preregistered A1 prompt-only recursive evolution experiment."""

from __future__ import annotations

import argparse
import copy
import datetime
import difflib
import hashlib
import json
import os
import random
import signal
import sys
from pathlib import Path
from typing import Any

import mlflow


ROOT = Path(__file__).resolve().parents[2]
A0_CODE = ROOT / "phase-a/a0-infrastructure"
A1_ROOT = ROOT / "phase-a/a1-prompt-evolution"
A1_CONFIG = A1_ROOT / "config.json"
A0_CONFIG = A0_CODE / "config.json"
RUNS_ROOT = ROOT / "runs/a1"

# The A0 implementation is the frozen evaluator and model adapter. Importing
# it rather than copying it ensures A1 uses the exact same generation and
# official IFEval scoring paths.
sys.path.insert(0, str(A0_CODE))
import run_a0 as a0  # noqa: E402


MUTATION_OPERATORS = [
    {
        "id": "constraint_inventory",
        "rationale": "Inventory every explicit condition before composing the answer.",
        "instruction": "Before answering, silently list every explicit user constraint and treat each one as mandatory.",
    },
    {
        "id": "exact_counts",
        "rationale": "Improve exact paragraph, sentence, word, bullet, and keyword counts.",
        "instruction": "For exact counts, plan the required structure first and silently recount it before returning the response.",
    },
    {
        "id": "negative_constraints",
        "rationale": "Reduce failures on forbidden words, punctuation, and other exclusions.",
        "instruction": "For every prohibition, silently scan the complete draft and remove each forbidden word, character, or pattern.",
    },
    {
        "id": "format_skeleton",
        "rationale": "Make titles, sections, lists, JSON, openings, and endings explicit.",
        "instruction": "Construct the requested output skeleton before writing content, including required titles, sections, lists, openings, and endings.",
    },
    {
        "id": "final_audit",
        "rationale": "Catch a single missed condition in otherwise correct multi-constraint responses.",
        "instruction": "Silently audit the final draft against every constraint and repair any violation before sending only the answer.",
    },
    {
        "id": "literal_priority",
        "rationale": "Prioritize verifier-visible compliance when helpful prose conflicts with literal requirements.",
        "instruction": "When helpful elaboration conflicts with a literal formatting or content constraint, follow the literal constraint exactly.",
    },
]


def utc_now() -> str:
    """Return an explicit timestamp for every durable ledger event."""
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def read_json(path: Path, default: Any = None) -> Any:
    """Read JSON while allowing resumable state files to be absent."""
    return json.loads(path.read_text()) if path.exists() else default


def write_json(path: Path, value: Any) -> None:
    """Atomically replace JSON so the dashboard never observes half a write."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def stable_panel(rows: list[dict[str, Any]], size: int, seed: int) -> list[dict[str, Any]]:
    """Choose a deterministic panel whose smaller form nests in larger forms."""
    ordered = sorted(
        rows,
        key=lambda row: hashlib.sha256(f"{seed}:{row['key']}".encode()).hexdigest(),
    )
    return ordered[: min(size, len(ordered))]


def prompt_diff(parent: str, child: str) -> str:
    """Return a reviewable unified diff for the immutable mutation ledger."""
    return "\n".join(difflib.unified_diff(
        parent.splitlines(), child.splitlines(),
        fromfile="parent_prompt", tofile="candidate_prompt", lineterm="",
    ))


def propose_candidates(
    run_dir: Path,
    parent_id: str,
    parent_prompt: str,
    generation: int,
    count: int,
    seed: int,
    maximum_added_words: int,
) -> list[dict[str, Any]]:
    """Create deterministic children of the current prompt and persist lineage."""
    rng = random.Random(seed + generation)
    operators = list(MUTATION_OPERATORS)
    rng.shuffle(operators)
    candidates = []
    for index in range(count):
        candidate_id = f"g{generation:02d}-c{index + 1:02d}"
        path = run_dir / "candidates" / candidate_id / "candidate.json"
        existing = read_json(path)
        if existing:
            candidates.append(existing)
            continue

        # Later candidates combine two atomic operators. The cap is checked
        # against newly added words so mutation complexity remains bounded.
        chosen = [operators[index % len(operators)]]
        if index >= len(operators) // 2:
            chosen.append(operators[(index + generation + 1) % len(operators)])
        additions = " ".join(item["instruction"] for item in chosen)
        additions = " ".join(additions.split()[:maximum_added_words])
        child_prompt = parent_prompt.rstrip() + " " + additions
        candidate = {
            "candidate_id": candidate_id,
            "parent_id": parent_id,
            "generation": generation,
            "operators": [item["id"] for item in chosen],
            "rationale": " ".join(item["rationale"] for item in chosen),
            "prompt": child_prompt,
            "prompt_sha256": hashlib.sha256(child_prompt.encode()).hexdigest(),
            "prompt_words": len(child_prompt.split()),
            "added_words": len(child_prompt.split()) - len(parent_prompt.split()),
            "diff": prompt_diff(parent_prompt, child_prompt),
            "created_at": utc_now(),
            "status": "proposed",
        }
        write_json(path, candidate)
        candidates.append(candidate)
    return candidates


def baseline_records(run_id: str, split: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Reuse approved A0 responses for paired comparisons without regeneration."""
    path = ROOT / "runs/a0/experiments" / run_id / split / "raw_responses.jsonl"
    records = a0.load_rows(path)
    wanted = {row["key"] for row in rows}
    by_key = {record["key"]: record for record in records}
    missing = wanted - by_key.keys()
    if missing:
        raise RuntimeError(f"A0 baseline is missing {len(missing)} required responses")
    return [by_key[row["key"]] for row in rows]


def score_key(metrics: dict[str, Any], prompt_words: int, candidate_id: str) -> tuple[Any, ...]:
    """Apply the preregistered selection metric and deterministic tie breakers."""
    strict = metrics["strict"]
    return (
        strict["prompt_accuracy"],
        strict["instruction_accuracy"],
        -prompt_words,
        # Reverse lexical order is avoided by converting the stable id to a
        # negative numeric suffix. Earlier ids win the final tie.
        -int(candidate_id.split("c")[-1]) if "c" in candidate_id else 0,
    )


def seed_nested_panel_cache(candidate_dir: Path, output_path: Path, rows: list[dict[str, Any]]) -> None:
    """Reuse durable responses when a later evolution panel contains earlier rows.

    Screening, confirmation, and full evolution panels are nested. Copying
    matching completed records into the new stage avoids generating an
    identical deterministic response twice. Validation and held-out keys are
    disjoint, so they cannot be copied into evolution or into each other.
    """
    if output_path.exists():
        return
    wanted = {row["key"] for row in rows}
    reusable: dict[str, dict[str, Any]] = {}
    for prior_path in candidate_dir.glob("evaluations/*/raw_responses.jsonl"):
        for record in a0.load_rows(prior_path):
            if record["key"] in wanted:
                reusable[record["key"]] = record
    if not reusable:
        return
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w") as handle:
        for row in rows:
            if row["key"] in reusable:
                handle.write(json.dumps(reusable[row["key"]], sort_keys=True) + "\n")


def evaluate_candidate(
    run_dir: Path,
    candidate: dict[str, Any],
    rows: list[dict[str, Any]],
    stage_name: str,
    a0_config: dict[str, Any],
    evaluator_dir: Path,
    baseline_run_id: str,
    device: str,
    split_name: str = "evolution",
) -> dict[str, Any]:
    """Generate and officially score one prompt on one frozen example panel."""
    output_dir = run_dir / "candidates" / candidate["candidate_id"] / "evaluations" / stage_name
    metrics_path = output_dir / "metrics.json"
    if metrics_path.exists():
        return read_json(metrics_path)

    output_dir.mkdir(parents=True, exist_ok=True)
    if candidate["candidate_id"] == "a0-baseline":
        records = baseline_records(baseline_run_id, split_name, rows)
    else:
        candidate_config = copy.deepcopy(a0_config)
        candidate_config["model"]["system_prompt"] = candidate["prompt"]
        response_path = output_dir / "raw_responses.jsonl"
        seed_nested_panel_cache(output_dir.parents[1], response_path, rows)
        records = a0.build_responses(
            rows,
            candidate_config,
            response_path,
            output_dir / "progress.json",
            device=device,
        )
    metrics = a0.score_split(rows, records, output_dir, evaluator_dir)
    write_json(metrics_path, metrics)
    return metrics


def bootstrap_paired_interval(
    baseline_results: list[dict[str, Any]],
    candidate_results: list[dict[str, Any]],
    seed: int,
    samples: int = 5000,
) -> list[float]:
    """Estimate a deterministic paired 95 percent interval for prompt delta."""
    if len(baseline_results) != len(candidate_results) or not baseline_results:
        raise ValueError("Paired bootstrap inputs must have the same non-zero length")
    differences = [
        int(candidate["follow_all_instructions"]) - int(baseline["follow_all_instructions"])
        for baseline, candidate in zip(baseline_results, candidate_results)
    ]
    rng = random.Random(seed)
    estimates = []
    for _ in range(samples):
        estimates.append(sum(rng.choice(differences) for _ in differences) / len(differences))
    estimates.sort()
    return [estimates[int(.025 * samples)], estimates[int(.975 * samples)]]


def strict_results(path: Path) -> list[dict[str, Any]]:
    """Read ordered official results used for paired uncertainty estimates."""
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def record_comparison(
    run_dir: Path,
    stage: str,
    baseline_dir: Path,
    candidate_dir: Path,
    baseline_metrics: dict[str, Any],
    candidate_metrics: dict[str, Any],
    seed: int,
) -> dict[str, Any]:
    """Persist paired deltas and uncertainty without hiding metric components."""
    baseline_strict = strict_results(baseline_dir / "eval_results_strict.jsonl")
    candidate_strict = strict_results(candidate_dir / "eval_results_strict.jsonl")
    comparison = {
        "stage": stage,
        "baseline_strict_prompt_accuracy": baseline_metrics["strict"]["prompt_accuracy"],
        "candidate_strict_prompt_accuracy": candidate_metrics["strict"]["prompt_accuracy"],
        "strict_prompt_delta": candidate_metrics["strict"]["prompt_accuracy"] - baseline_metrics["strict"]["prompt_accuracy"],
        "strict_prompt_delta_ci95": bootstrap_paired_interval(baseline_strict, candidate_strict, seed),
        "baseline_strict_instruction_accuracy": baseline_metrics["strict"]["instruction_accuracy"],
        "candidate_strict_instruction_accuracy": candidate_metrics["strict"]["instruction_accuracy"],
        "created_at": utc_now(),
    }
    write_json(run_dir / "comparisons" / f"{stage}.json", comparison)
    return comparison


def start_mlflow(run_dir: Path, run_id: str, config: dict[str, Any]) -> None:
    """Create or resume the local A1 tracking entry."""
    tracking_uri = f"sqlite:///{(ROOT / 'runs/a0/mlflow.db').as_posix()}"
    mlflow.set_tracking_uri(tracking_uri)
    mlflow.set_experiment("rrsi-a1")
    ledger_path = run_dir / "mlflow.json"
    ledger = read_json(ledger_path, {})
    if ledger.get("run_id"):
        mlflow.start_run(run_id=ledger["run_id"])
        return
    active = mlflow.start_run(run_name=run_id, tags={"rrsi.phase": "a1", "rrsi.local_run_id": run_id})
    mlflow.log_params({
        "baseline_run_id": config["experiment"]["baseline_run_id"],
        "generations": config["search"]["generations"],
        "candidates_per_generation": config["search"]["candidates_per_generation"],
        "screen_examples": config["search"]["screen_examples"],
        "confirmation_examples": config["search"]["confirmation_examples"],
        "mutable_component": "system_prompt",
    })
    write_json(ledger_path, {"run_id": active.info.run_id, "experiment_id": active.info.experiment_id, "tracking_uri": tracking_uri})


def run_search(run_dir: Path, config: dict[str, Any], rows: dict[str, list[dict[str, Any]]], a0_config: dict[str, Any]) -> None:
    """Execute the recursive proposal, evaluation, and acceptance loop."""
    search = config["search"]
    baseline_run_id = config["experiment"]["baseline_run_id"]
    evaluator_dir = ROOT / "runs/a0/source/google-research/instruction_following_eval"
    baseline = {
        "candidate_id": "a0-baseline",
        "parent_id": None,
        "generation": 0,
        "prompt": a0_config["model"]["system_prompt"],
        "prompt_words": len(a0_config["model"]["system_prompt"].split()),
        "status": "baseline",
    }
    write_json(run_dir / "candidates/a0-baseline/candidate.json", baseline)
    state_path = run_dir / "search_state.json"
    state = read_json(state_path, {
        "status": "running",
        "incumbent_id": baseline["candidate_id"],
        "incumbent_prompt": baseline["prompt"],
        "completed_generations": [],
        "started_at": utc_now(),
    })
    state["status"] = "running"
    write_json(state_path, state)

    evolution = rows["evolution"]
    screen_rows = stable_panel(evolution, search["screen_examples"], config["experiment"]["seed"])
    confirmation_rows = stable_panel(evolution, search["confirmation_examples"], config["experiment"]["seed"])

    for generation in range(1, search["generations"] + 1):
        if generation in state["completed_generations"]:
            continue
        parent = read_json(run_dir / "candidates" / state["incumbent_id"] / "candidate.json")
        candidates = propose_candidates(
            run_dir, parent["candidate_id"], parent["prompt"], generation,
            search["candidates_per_generation"], config["experiment"]["seed"],
            config["mutable"]["maximum_added_words_per_mutation"],
        )
        device = config["locked"]["device"]
        parent_screen = evaluate_candidate(run_dir, parent, screen_rows, f"g{generation:02d}-screen", a0_config, evaluator_dir, baseline_run_id, device)
        screen_scores = []
        for candidate in candidates:
            metrics = evaluate_candidate(run_dir, candidate, screen_rows, f"g{generation:02d}-screen", a0_config, evaluator_dir, baseline_run_id, device)
            screen_scores.append((score_key(metrics, candidate["prompt_words"], candidate["candidate_id"]), candidate, metrics))
        finalists = [item[1] for item in sorted(screen_scores, key=lambda item: item[0], reverse=True)[:search["screen_finalists"]]]

        parent_confirmation = evaluate_candidate(run_dir, parent, confirmation_rows, f"g{generation:02d}-confirmation", a0_config, evaluator_dir, baseline_run_id, device)
        confirmation_scores = []
        for candidate in finalists:
            metrics = evaluate_candidate(run_dir, candidate, confirmation_rows, f"g{generation:02d}-confirmation", a0_config, evaluator_dir, baseline_run_id, device)
            confirmation_scores.append((score_key(metrics, candidate["prompt_words"], candidate["candidate_id"]), candidate, metrics))
        best_key, best, best_metrics = max(confirmation_scores, key=lambda item: item[0])
        delta = best_metrics["strict"]["prompt_accuracy"] - parent_confirmation["strict"]["prompt_accuracy"]
        accepted = delta > search["minimum_acceptance_delta"]
        decision = {
            "generation": generation,
            "parent_id": parent["candidate_id"],
            "screen_finalists": [item["candidate_id"] for item in finalists],
            "selected_candidate_id": best["candidate_id"],
            "strict_prompt_delta": delta,
            "accepted": accepted,
            "reason": "positive paired confirmation delta" if accepted else "confirmation delta did not exceed the acceptance threshold",
            "decided_at": utc_now(),
        }
        write_json(run_dir / "generations" / f"g{generation:02d}.json", decision)
        for candidate in candidates:
            candidate["status"] = "accepted" if accepted and candidate["candidate_id"] == best["candidate_id"] else "rejected"
            write_json(run_dir / "candidates" / candidate["candidate_id"] / "candidate.json", candidate)
        if accepted:
            state["incumbent_id"] = best["candidate_id"]
            state["incumbent_prompt"] = best["prompt"]
        state["completed_generations"].append(generation)
        write_json(state_path, state)
        mlflow.log_metric("search.incumbent_confirmation_accuracy", best_metrics["strict"]["prompt_accuracy"], step=generation)
        mlflow.log_metric("search.accepted", int(accepted), step=generation)

    winner = read_json(run_dir / "candidates" / state["incumbent_id"] / "candidate.json")
    final_metrics = evaluate_candidate(run_dir, winner, evolution, "final-evolution", a0_config, evaluator_dir, baseline_run_id, config["locked"]["device"])
    baseline_metrics = evaluate_candidate(run_dir, baseline, evolution, "final-evolution", a0_config, evaluator_dir, baseline_run_id, config["locked"]["device"])
    record_comparison(
        run_dir, "evolution",
        run_dir / "candidates/a0-baseline/evaluations/final-evolution",
        run_dir / "candidates" / winner["candidate_id"] / "evaluations/final-evolution",
        baseline_metrics, final_metrics, config["experiment"]["seed"],
    )
    state.update({"status": "complete", "winner_id": winner["candidate_id"], "finished_at": utc_now()})
    write_json(state_path, state)


def run_transfer_stage(run_dir: Path, stage: str, config: dict[str, Any], rows: dict[str, list[dict[str, Any]]], a0_config: dict[str, Any]) -> None:
    """Evaluate the frozen search winner on validation or held-out exactly once."""
    state = read_json(run_dir / "search_state.json", {})
    if state.get("status") != "complete" or not state.get("winner_id"):
        raise RuntimeError("Complete the A1 evolution search before transfer evaluation")
    if stage == "heldout_test" and not (run_dir / "comparisons/validation.json").exists():
        raise RuntimeError("Complete validation before held-out evaluation")
    evaluator_dir = ROOT / "runs/a0/source/google-research/instruction_following_eval"
    baseline_run_id = config["experiment"]["baseline_run_id"]
    baseline = read_json(run_dir / "candidates/a0-baseline/candidate.json")
    winner = read_json(run_dir / "candidates" / state["winner_id"] / "candidate.json")
    panel = rows[stage]
    device = config["locked"]["device"]
    baseline_metrics = evaluate_candidate(run_dir, baseline, panel, f"final-{stage}", a0_config, evaluator_dir, baseline_run_id, device, stage)
    winner_metrics = evaluate_candidate(run_dir, winner, panel, f"final-{stage}", a0_config, evaluator_dir, baseline_run_id, device, stage)
    comparison = record_comparison(
        run_dir, stage,
        run_dir / "candidates/a0-baseline/evaluations" / f"final-{stage}",
        run_dir / "candidates" / winner["candidate_id"] / "evaluations" / f"final-{stage}",
        baseline_metrics, winner_metrics, config["experiment"]["seed"],
    )
    mlflow.log_metrics({
        f"{stage}.winner_strict_prompt_accuracy": winner_metrics["strict"]["prompt_accuracy"],
        f"{stage}.paired_delta": comparison["strict_prompt_delta"],
    })


def main() -> None:
    """Validate frozen inputs and execute one resumable A1 protocol stage."""
    signal.signal(signal.SIGTERM, a0.stop_signal_handler)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=f"a1-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}")
    parser.add_argument("--stage", choices=("search", "validation", "heldout_test"), default="search")
    args = parser.parse_args()
    config = read_json(A1_CONFIG)
    a0_config = read_json(A0_CONFIG)
    gate = read_json(ROOT / "runs/a0/experiments" / config["experiment"]["baseline_run_id"] / "gate_decision.json", {})
    if gate.get("decision") != "approved":
        raise RuntimeError("The canonical A0 gate is not approved")
    source = ROOT / a0_config["benchmark"]["source_file"]
    if a0.sha256_file(source) != config["locked"]["dataset_sha256"]:
        raise RuntimeError("The frozen IFEval source fingerprint changed")

    # Reconstruct the exact A0 split membership with the original registered
    # configuration. A1 must not introduce a new split by accident.
    a0.ACTIVE_CONFIG = a0_config
    rows = a0.stratified_split(a0.load_rows(source), config["locked"]["split_seed"])
    # A0 adds this runtime field immediately after splitting because response
    # records include their split for provenance. Reproduce the same adapter
    # contract before passing any A1 panel to the frozen A0 generator.
    for split_name, split_rows in rows.items():
        for row in split_rows:
            row["split"] = split_name
    run_dir = RUNS_ROOT / "experiments" / args.run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("NLTK_DATA", str(ROOT / "runs/a0/nltk_data"))
    manifest = {
        "run_id": args.run_id,
        "experiment": "a1-prompt-evolution",
        "config": config,
        "a0_config_sha256": a0.sha256_file(A0_CONFIG),
        "a1_config_sha256": a0.sha256_file(A1_CONFIG),
        "preregistration_sha256": a0.sha256_file(A1_ROOT / "preregistration.md"),
        "created_at": utc_now(),
    }
    if not (run_dir / "manifest.json").exists():
        write_json(run_dir / "manifest.json", manifest)
    start_mlflow(run_dir, args.run_id, config)
    try:
        if args.stage == "search":
            run_search(run_dir, config, rows, a0_config)
        else:
            run_transfer_stage(run_dir, args.stage, config, rows, a0_config)
        mlflow.log_artifacts(str(run_dir), artifact_path="evidence")
        mlflow.end_run(status="FINISHED")
        print(f"A1 {args.stage} artifacts saved to {run_dir.relative_to(ROOT)}")
    except BaseException as error:
        if args.stage == "search":
            search_state_path = run_dir / "search_state.json"
            search_state = read_json(search_state_path, {})
            search_state.update({
                "status": "interrupted" if isinstance(error, KeyboardInterrupt) else "failed",
                "error_type": type(error).__name__,
                "error": str(error),
                "failed_at": utc_now(),
            })
            write_json(search_state_path, search_state)
        mlflow.set_tag("rrsi.error_type", type(error).__name__)
        mlflow.set_tag("rrsi.error", str(error)[:1000])
        mlflow.end_run(status="KILLED" if isinstance(error, KeyboardInterrupt) else "FAILED")
        raise


if __name__ == "__main__":
    main()

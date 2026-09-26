"""Build the frozen A0 baseline with lineage-rich local artifacts.

This script deliberately keeps dataset text, model responses, split members,
and evaluator outputs under the ignored runs/ directory. The checked-in
configuration contains only source identifiers, hashes, and fixed protocol
settings. Every consequential operation is commented so the experiment can
be audited and adapted without treating the runner as a black box.
"""

from __future__ import annotations

import argparse
import collections
import datetime
import hashlib
import importlib.metadata
import json
import os
import platform
import random
import sys
import time
from pathlib import Path
from typing import Any

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer


# Resolve the repository root from this file so invocation does not depend on
# the shell's current working directory.
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "phase-a/a0-infrastructure/config.json"
ACTIVE_CONFIG: dict[str, Any] = json.loads(DEFAULT_CONFIG.read_text())


def sha256_file(path: Path) -> str:
    """Return a stable content fingerprint for a file."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    """Write readable, deterministic JSON used in the run evidence pack."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def load_rows(path: Path) -> list[dict[str, Any]]:
    """Read JSONL and normalize example keys to strings for stable joins."""
    rows = [json.loads(line) for line in path.read_text().splitlines() if line]
    for row in rows:
        row["key"] = str(row["key"])
    return rows


def stratified_split(rows: list[dict[str, Any]], seed: int) -> dict[str, list[dict[str, Any]]]:
    """Assign examples using deterministic iterative multilabel stratification.

    IFEval examples can carry several instruction types. The procedure chooses
    the rarest remaining label first, then assigns its examples to the split
    with the largest remaining quota for that label. A seeded order breaks
    ties. This is a transparent greedy approximation, not a claim of globally
    optimal stratification. The manifest records actual counts for review.
    """
    # Read the registered proportions from the checked-in protocol. Keeping
    # them in one source prevents accidental drift between docs and code.
    proportions = ACTIVE_CONFIG["split"]["proportions"]
    names = list(proportions)
    # Largest-remainder rounding preserves the exact total of 541 examples.
    exact = {name: len(rows) * ratio for name, ratio in proportions.items()}
    capacities = {name: int(exact[name]) for name in names}
    for name in sorted(names, key=lambda item: (-(exact[item] - capacities[item]), names.index(item))):
        if sum(capacities.values()) < len(rows):
            capacities[name] += 1

    rng = random.Random(seed)
    randomized = list(rows)
    rng.shuffle(randomized)
    label_members: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for row in randomized:
        for label in set(row["instruction_id_list"]):
            label_members[label].append(row)

    # The rarest labels are processed first to protect coverage of uncommon
    # instruction types. The key tie-break makes the result deterministic.
    ordered_labels = sorted(label_members, key=lambda label: (len(label_members[label]), label))
    assignment: dict[str, str] = {}
    remaining_capacity = dict(capacities)
    remaining_label_demand = {
        label: {name: len(label_members[label]) * proportions[name] for name in names}
        for label in ordered_labels
    }

    for label in ordered_labels:
        candidates = [row for row in label_members[label] if row["key"] not in assignment]
        # Seeded order avoids always favoring the same original dataset rows.
        rng.shuffle(candidates)
        for row in candidates:
            available = [name for name in names if remaining_capacity[name] > 0]
            if not available:
                raise RuntimeError("Split capacities were exhausted before all examples were assigned")
            # Prefer the split with the largest proportional deficit for this
            # rare label, then the largest remaining overall capacity.
            chosen = max(
                available,
                key=lambda name: (
                    remaining_label_demand[label][name] / max(remaining_capacity[name], 1),
                    remaining_capacity[name] / capacities[name],
                    -names.index(name),
                ),
            )
            assignment[row["key"]] = chosen
            remaining_capacity[chosen] -= 1
            for other_label in row["instruction_id_list"]:
                if other_label in remaining_label_demand:
                    remaining_label_demand[other_label][chosen] -= 1

    # Examples that have only labels already satisfied are placed by remaining
    # split capacity while preserving the same seeded deterministic order.
    for row in randomized:
        if row["key"] not in assignment:
            available = [name for name in names if remaining_capacity[name] > 0]
            chosen = max(available, key=lambda name: (remaining_capacity[name], -names.index(name)))
            assignment[row["key"]] = chosen
            remaining_capacity[chosen] -= 1

    return {
        name: [row for row in rows if assignment[row["key"]] == name]
        for name in names
    }


def summarize_splits(splits: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """Create counts and membership hashes without copying prompts to the manifest."""
    summary: dict[str, Any] = {}
    for name, rows in splits.items():
        type_counts: collections.Counter[str] = collections.Counter()
        for row in rows:
            type_counts.update(set(row["instruction_id_list"]))
        member_text = "\n".join(sorted(row["key"] for row in rows))
        summary[name] = {
            "example_count": len(rows),
            "membership_sha256": hashlib.sha256(member_text.encode()).hexdigest(),
            "instruction_type_counts": dict(sorted(type_counts.items())),
        }
    return summary


def build_responses(rows: list[dict[str, Any]], config: dict[str, Any], output_path: Path, progress_path: Path) -> list[dict[str, Any]]:
    """Run deterministic greedy generation and persist every raw response."""
    model_config = config["model"]
    model_path = Path(model_config["path"]).expanduser()
    if not model_path.exists():
        raise FileNotFoundError(f"Pinned local model snapshot not found: {model_path}")

    # Explicitly disable hub access. A0 must evaluate the frozen local snapshot,
    # not silently download a moving model revision.
    tokenizer = AutoTokenizer.from_pretrained(str(model_path), local_files_only=True)
    model = AutoModelForCausalLM.from_pretrained(
        str(model_path),
        local_files_only=True,
        torch_dtype="auto",
    )
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model.to(device)
    model.eval()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    # Resume only from complete JSONL records. This makes an interrupted run
    # observable and recoverable without generating duplicate responses.
    records = []
    if output_path.exists():
        for line in output_path.read_text().splitlines():
            if line.strip():
                records.append(json.loads(line))
    completed_keys = {record["key"] for record in records}
    if records:
        live = live_scores(rows, records)
        elapsed_total = max(sum(record["generation_seconds"] for record in records), 0.001)
        resumed_progress = {
            "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "completed": len(records), "total": len(rows),
            "percent": 100.0 * len(records) / len(rows),
            "elapsed_seconds": elapsed_total,
            "examples_per_second": len(records) / elapsed_total,
            "mean_generation_seconds": sum(item["generation_seconds"] for item in records) / len(records),
            "mean_input_tokens": sum(item["input_tokens"] for item in records) / len(records),
            "mean_output_tokens": sum(item["output_tokens"] for item in records) / len(records),
            **live,
            "status": "running" if len(records) < len(rows) else "generation_complete",
        }
        write_json(progress_path, resumed_progress)
        with progress_path.with_name("progress.jsonl").open("a") as event_log:
            event_log.write(json.dumps(resumed_progress, sort_keys=True) + "\n")
    # The append mode preserves valid prior work when resuming an interrupted
    # generation job. A response is flushed after each example for durability.
    with output_path.open("a") as handle:
        for index, row in enumerate(rows, start=1):
            if row["key"] in completed_keys:
                continue
            # Use the model's native chat template when present and preserve the
            # exact system instruction in the checked-in configuration.
            messages = [
                {"role": "system", "content": model_config["system_prompt"]},
                {"role": "user", "content": row["prompt"]},
            ]
            prompt_text = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=False,
            )
            inputs = tokenizer(prompt_text, return_tensors="pt").to(device)
            started = time.perf_counter()
            with torch.inference_mode():
                generated = model.generate(
                    **inputs,
                    max_new_tokens=int(model_config["max_new_tokens"]),
                    do_sample=False,
                    pad_token_id=tokenizer.eos_token_id,
                )
            elapsed = time.perf_counter() - started
            new_tokens = generated[0, inputs["input_ids"].shape[1] :]
            response = tokenizer.decode(new_tokens, skip_special_tokens=True).strip()
            record = {
                "key": row["key"],
                "prompt": row["prompt"],
                "response": response,
                "input_tokens": int(inputs["input_ids"].shape[1]),
                "output_tokens": int(new_tokens.shape[0]),
                "generation_seconds": elapsed,
                "split": row["split"],
            }
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            handle.flush()
            records.append(record)
            completed_keys.add(row["key"])

            # Score the growing prefix with the official verifier every
            # example initially, then every ten examples. This keeps the
            # dashboard current without rescoring the full prefix too often.
            should_refresh = len(records) == 1 or len(records) % 10 == 0 or len(records) == len(rows)
            if should_refresh:
                live = live_scores(rows, records)
            elif progress_path.exists():
                live = json.loads(progress_path.read_text())
            else:
                live = {"strict_prompt_accuracy": 0.0, "strict_prompt_correct": 0,
                        "strict_instruction_accuracy": 0.0, "loose_prompt_accuracy": 0.0,
                        "loose_prompt_correct": 0, "loose_instruction_accuracy": 0.0,
                        "scored_examples": 0}
            elapsed_total = max(sum(item["generation_seconds"] for item in records), 0.001)
            progress = {
                "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "completed": len(records),
                "total": len(rows),
                "percent": 100.0 * len(records) / len(rows),
                "elapsed_seconds": elapsed_total,
                "examples_per_second": len(records) / elapsed_total,
                "mean_generation_seconds": sum(item["generation_seconds"] for item in records) / len(records),
                "mean_input_tokens": sum(item["input_tokens"] for item in records) / len(records),
                "mean_output_tokens": sum(item["output_tokens"] for item in records) / len(records),
                "strict_prompt_accuracy": live["strict_prompt_accuracy"],
                "strict_prompt_correct": live["strict_prompt_correct"],
                "strict_instruction_accuracy": live["strict_instruction_accuracy"],
                "strict_instruction_correct": live["strict_instruction_correct"],
                "loose_prompt_accuracy": live["loose_prompt_accuracy"],
                "loose_prompt_correct": live["loose_prompt_correct"],
                "loose_instruction_accuracy": live["loose_instruction_accuracy"],
                "loose_instruction_correct": live["loose_instruction_correct"],
                "scored_examples": live["scored_examples"],
                "status": "running" if len(records) < len(rows) else "generation_complete",
            }
            write_json(progress_path, progress)
            # Append an immutable progress event as a time series so the
            # dashboard can later plot score and throughput curves.
            with progress_path.with_name("progress.jsonl").open("a") as event_log:
                event_log.write(json.dumps(progress, sort_keys=True) + "\n")
                event_log.flush()
            print(
                f"[{len(records):>3}/{len(rows)} {progress['percent']:5.1f}%] "
                f"strict={live['strict_prompt_accuracy']:.3f} "
                f"loose={live['loose_prompt_accuracy']:.3f} "
                f"{progress['examples_per_second']:.3f} ex/s "
                f"{elapsed_total / 60:.1f} min",
                flush=True,
            )

    return records


def live_scores(rows: list[dict[str, Any]], records: list[dict[str, Any]]) -> dict[str, float]:
    """Compute current strict and loose rates with the official IFEval code."""
    evaluator_root = ROOT / "runs/a0/source/google-research"
    sys.path.insert(0, str(evaluator_root))
    from instruction_following_eval import evaluation_lib

    response_map = {record["prompt"]: record["response"] for record in records}
    inputs = [
        evaluation_lib.InputExample(
            key=int(row["key"]),
            instruction_id_list=row["instruction_id_list"],
            prompt=row["prompt"],
            kwargs=row["kwargs"],
        )
        for row in rows
        if row["prompt"] in response_map
    ]
    scores: dict[str, float] = {"scored_examples": len(inputs)}
    instruction_correct_by_mode: dict[str, int] = {}
    for mode, function in (
        ("strict", evaluation_lib.test_instruction_following_strict),
        ("loose", evaluation_lib.test_instruction_following_loose),
    ):
        outputs = [function(example, response_map) for example in inputs]
        prompts_ok = sum(output.follow_all_instructions for output in outputs)
        instructions_ok = sum(sum(output.follow_instruction_list) for output in outputs)
        instructions_total = sum(len(output.follow_instruction_list) for output in outputs)
        instruction_correct_by_mode[mode] = instructions_ok
        scores[f"{mode}_prompt_accuracy"] = prompts_ok / len(outputs) if outputs else 0.0
        scores[f"{mode}_prompt_correct"] = prompts_ok
        scores[f"{mode}_instruction_accuracy"] = instructions_ok / instructions_total if instructions_total else 0.0
        scores["scored_examples"] = len(outputs)
    scores["strict_instruction_correct"] = instruction_correct_by_mode["strict"]
    scores["loose_instruction_correct"] = instruction_correct_by_mode["loose"]
    return scores


def score_split(rows: list[dict[str, Any]], responses: list[dict[str, Any]], output_dir: Path, evaluator_dir: Path) -> dict[str, Any]:
    """Call the untouched official strict and loose evaluator entry points."""
    output_dir.mkdir(parents=True, exist_ok=True)
    # Import from the pinned checkout rather than reimplementing IFEval scoring.
    sys.path.insert(0, str(evaluator_dir.parent))
    from instruction_following_eval import evaluation_lib

    response_path = output_dir / "responses_for_official_evaluator.jsonl"
    response_path.write_text("".join(json.dumps({"prompt": item["prompt"], "response": item["response"]}, ensure_ascii=False) + "\n" for item in responses))
    inputs_path = output_dir / "inputs_for_official_evaluator.jsonl"
    inputs_path.write_text("".join(json.dumps({key: row[key] for key in ("key", "prompt", "instruction_id_list", "kwargs")}, ensure_ascii=False) + "\n" for row in rows))
    prompt_to_response = evaluation_lib.read_prompt_to_response_dict(str(response_path))
    inputs = evaluation_lib.read_prompt_list(str(inputs_path))

    score_details: dict[str, Any] = {}
    for mode, function in (
        ("strict", evaluation_lib.test_instruction_following_strict),
        ("loose", evaluation_lib.test_instruction_following_loose),
    ):
        outputs = [function(example, prompt_to_response) for example in inputs]
        prompt_correct = sum(result.follow_all_instructions for result in outputs)
        instruction_correct = sum(sum(result.follow_instruction_list) for result in outputs)
        instruction_total = sum(len(result.follow_instruction_list) for result in outputs)
        result_path = output_dir / f"eval_results_{mode}.jsonl"
        evaluation_lib.write_outputs(str(result_path), outputs)
        score_details[mode] = {
            "prompt_accuracy": prompt_correct / len(outputs),
            "prompt_correct": prompt_correct,
            "prompt_total": len(outputs),
            "instruction_accuracy": instruction_correct / instruction_total,
            "instruction_correct": instruction_correct,
            "instruction_total": instruction_total,
            "official_result_file": str(result_path.relative_to(ROOT)),
        }
    return score_details


def main() -> None:
    """Parse the CLI, freeze a run manifest, and execute requested split(s)."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--splits", nargs="+", choices=("evolution", "validation", "heldout_test"), default=["evolution", "validation", "heldout_test"])
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    global ACTIVE_CONFIG
    ACTIVE_CONFIG = config
    source = ROOT / config["benchmark"]["source_file"]
    observed_sha = sha256_file(source)
    if observed_sha != config["benchmark"]["source_sha256"]:
        raise RuntimeError(f"IFEval source SHA mismatch: expected {config['benchmark']['source_sha256']}, found {observed_sha}")

    rows = load_rows(source)
    splits = stratified_split(rows, int(config["split"]["seed"]))
    split_summary = summarize_splits(splits)
    if sum(item["example_count"] for item in split_summary.values()) != len(rows):
        raise RuntimeError("Split assignment lost or duplicated examples")
    for split_name, split_rows in splits.items():
        for row in split_rows:
            row["split"] = split_name
    all_rows = [row for members in splits.values() for row in members]
    if len({row["key"] for row in all_rows}) != len(rows):
        raise RuntimeError("Split assignment has duplicate or missing example keys")
    if any(not members for members in splits.values()):
        raise RuntimeError("Every registered split must contain at least one example")

    # Reuse the active run created before an interruption so existing
    # completed responses can be resumed instead of silently discarded.
    prior_runs = sorted((ROOT / "runs/a0/experiments").glob("a0-*"), reverse=True)
    run_id = prior_runs[0].name if prior_runs and not (prior_runs[0] / "summary.json").exists() else time.strftime("a0-%Y%m%d-%H%M%S")
    run_dir = ROOT / "runs/a0/experiments" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    split_manifest = {
        "seed": config["split"]["seed"],
        "method": config["split"]["stratification"],
        "dataset_sha256": observed_sha,
        "splits": split_summary,
        "membership": {name: sorted(row["key"] for row in members) for name, members in splits.items()},
    }
    write_json(run_dir / "split_manifest.json", split_manifest)

    evaluator_dir = ROOT / "runs/a0/source/google-research/instruction_following_eval"
    # IFEval's sentence and word checks use NLTK assets. Keep their location
    # inside ignored run storage so the source checkout stays self-contained.
    os.environ.setdefault("NLTK_DATA", str(ROOT / "runs/a0/nltk_data"))
    environment = {
        "python": sys.version,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "torch": torch.__version__,
        "mps_available": torch.backends.mps.is_available(),
        "selected_device": "mps" if torch.backends.mps.is_available() else "cpu",
        "selected_device": "mps" if torch.backends.mps.is_available() else "cpu",
        "packages": {name: importlib.metadata.version(name) for name in ("transformers", "tokenizers", "accelerate", "absl-py", "langdetect", "nltk", "immutabledict")},
        "evaluator_revision": config["evaluator"]["revision"],
        "model_revision": config["model"]["revision"],
        "model_snapshot_sha256": sha256_file(Path(config["model"]["path"]).expanduser() / "model.safetensors"),
        "config_sha256": sha256_file(args.config),
        "source_sha256": observed_sha,
    }
    write_json(run_dir / "environment.json", environment)

    all_scores = {}
    for split_name in args.splits:
        split_rows = splits[split_name]
        split_dir = run_dir / split_name
        response_path = split_dir / "raw_responses.jsonl"
        records = build_responses(split_rows, config, response_path, split_dir / "progress.json")
        all_scores[split_name] = score_split(split_rows, records, split_dir, evaluator_dir)
        write_json(split_dir / "metrics.json", all_scores[split_name])
        # Keep the held-out run unmistakably separate in the evidence tree.
        if split_name == "heldout_test":
            os.chmod(split_dir, 0o700)

    write_json(run_dir / "summary.json", {"run_id": run_id, "scores": all_scores})
    print(f"A0 run artifacts saved to {run_dir.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

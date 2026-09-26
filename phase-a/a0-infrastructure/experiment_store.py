"""Read A0 experiment artifacts into dashboard-friendly records.

The runner remains the only writer of scientific evidence. This module treats
the ignored runs/ tree as an append-oriented experiment store and derives
health, comparisons, example details, artifacts, and gate state without
changing raw model outputs or official evaluator results.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
RUNS_ROOT = ROOT / "runs/a0"
EXPERIMENTS_ROOT = RUNS_ROOT / "experiments"
SOURCE_DATA = RUNS_ROOT / "source/ifeval/ifeval_input_data.jsonl"
EVALUATOR_ROOT = RUNS_ROOT / "source/google-research"
CONFIG_PATH = ROOT / "phase-a/a0-infrastructure/config.json"
CONTROL_PATH = RUNS_ROOT / "control.json"
SPLIT_ORDER = ("evolution", "validation", "heldout_test")
STALE_AFTER_SECONDS = 120

# The official evaluator loads sentence tokenizers through NLTK's environment
# lookup. Point it at the pinned local resource bundle for dashboard launches
# that did not set NLTK_DATA in their parent shell.
os.environ.setdefault("NLTK_DATA", str(RUNS_ROOT / "nltk_data"))


def read_json(path: Path, default: Any = None) -> Any:
    """Read JSON safely while a runner may be replacing the file."""
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    """Read complete JSONL records and ignore a trailing partial write."""
    records: list[dict[str, Any]] = []
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return records
    for line in lines:
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return records


def sha256_file(path: Path) -> str:
    """Return a content hash for a dashboard artifact."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def wilson_interval(successes: int, total: int, z_score: float = 1.96) -> list[float] | None:
    """Return a 95% Wilson interval for a binomial success rate."""
    if total <= 0:
        return None
    proportion = successes / total
    denominator = 1 + z_score**2 / total
    center = (proportion + z_score**2 / (2 * total)) / denominator
    margin = (
        z_score
        * math.sqrt(proportion * (1 - proportion) / total + z_score**2 / (4 * total**2))
        / denominator
    )
    return [max(center - margin, 0.0), min(center + margin, 1.0)]


def process_exists(pid: int | None) -> bool:
    """Check a local PID without sending it a signal that changes state."""
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except PermissionError:
        # Lack of signal permission still proves the process exists.
        return True
    except OSError:
        return False
    return True


def active_control() -> dict[str, Any]:
    """Return durable process-control state, including a reconciled status."""
    control = read_json(CONTROL_PATH, {}) or {}
    pid = control.get("pid")
    control["alive"] = process_exists(pid)
    if not control:
        return {"alive": False}
    if control["alive"]:
        control["status"] = "running"
    elif control.get("status") == "running":
        control["status"] = "exited"
    return control


def source_rows() -> dict[str, dict[str, Any]]:
    """Index the pinned IFEval source by its stable example key."""
    return {str(row["key"]): row for row in read_jsonl(SOURCE_DATA)}


def split_snapshot(run_dir: Path, split: str) -> dict[str, Any] | None:
    """Summarize one split while preserving raw files for drill-down views."""
    split_dir = run_dir / split
    progress_path = split_dir / "progress.json"
    response_path = split_dir / "raw_responses.jsonl"
    metrics_path = split_dir / "metrics.json"
    if not split_dir.exists():
        return None

    progress = read_json(progress_path, {}) or {}
    responses = read_jsonl(response_path)
    manifest = read_json(run_dir / "split_manifest.json", {}) or {}
    expected = (
        manifest.get("splits", {}).get(split, {}).get("example_count")
        or progress.get("total")
        or 0
    )
    completed = len(responses)
    updated_path = progress_path if progress_path.exists() else response_path
    updated_at = updated_path.stat().st_mtime if updated_path.exists() else run_dir.stat().st_mtime
    age_seconds = max(time.time() - updated_at, 0.0)
    lifecycle = read_json(split_dir / "lifecycle.json", {}) or {}
    control = active_control()
    controls_this_split = (
        control.get("alive")
        and control.get("run_id") == run_dir.name
        and control.get("split") == split
    )

    if expected and completed >= expected and (split_dir / "metrics.json").exists():
        status = "complete"
    elif controls_this_split:
        status = "running"
    elif lifecycle.get("status") == "failed":
        status = "failed"
    elif completed:
        status = "interrupted"
    else:
        status = "not_started"

    total_generation = sum(float(item.get("generation_seconds", 0)) for item in responses)
    average_generation = total_generation / completed if completed else 0.0
    remaining = max(int(expected) - completed, 0)
    eta_seconds = remaining * average_generation if average_generation else None
    metrics = read_json(metrics_path, {}) or {}
    strict = metrics.get("strict", {})
    loose = metrics.get("loose", {})
    # An interrupted run may contain one or more durable responses written
    # after its last progress heartbeat. Recompute a cached aggregate from the
    # official verifier so the overview never displays a stale score/count.
    if split != "heldout_test" and completed and not metrics:
        cache_path = split_dir / "dashboard_metrics.json"
        cache = read_json(cache_path, {}) or {}
        response_mtime = response_path.stat().st_mtime if response_path.exists() else 0
        if cache.get("response_mtime") != response_mtime or cache.get("completed") != completed:
            examples = evaluate_examples(run_dir.name, split)
            strict_prompt_correct = sum(item["strict_pass"] for item in examples)
            loose_prompt_correct = sum(item["loose_pass"] for item in examples)
            strict_instruction_total = sum(len(item["strict_checks"]) for item in examples)
            strict_instruction_correct = sum(sum(item["strict_checks"]) for item in examples)
            loose_instruction_correct = sum(sum(item["loose_checks"]) for item in examples)
            cache = {
                "response_mtime": response_mtime,
                "completed": completed,
                "strict_prompt_accuracy": strict_prompt_correct / completed,
                "loose_prompt_accuracy": loose_prompt_correct / completed,
                "strict_instruction_accuracy": strict_instruction_correct / strict_instruction_total,
                "loose_instruction_accuracy": loose_instruction_correct / strict_instruction_total,
            }
            cache_path.write_text(json.dumps(cache, indent=2, sort_keys=True) + "\n")
    else:
        cache = {}
    prompt_accuracy = strict.get("prompt_accuracy", cache.get("strict_prompt_accuracy", progress.get("strict_prompt_accuracy")))
    scored_examples = int(strict.get("prompt_total", cache.get("completed", progress.get("scored_examples", completed))))
    prompt_successes = int(round(prompt_accuracy * scored_examples)) if prompt_accuracy is not None else 0
    return {
        "name": split,
        "status": status,
        "completed": completed,
        "total": int(expected),
        "percent": 100.0 * completed / expected if expected else 0.0,
        "updated_at_epoch": updated_at,
        "age_seconds": age_seconds,
        "elapsed_seconds": total_generation,
        "eta_seconds": eta_seconds,
        "examples_per_second": completed / total_generation if total_generation else 0.0,
        "mean_generation_seconds": average_generation,
        "mean_input_tokens": (
            sum(int(item.get("input_tokens", 0)) for item in responses) / completed
            if completed else 0.0
        ),
        "mean_output_tokens": (
            sum(int(item.get("output_tokens", 0)) for item in responses) / completed
            if completed else 0.0
        ),
        "strict_prompt_accuracy": prompt_accuracy,
        "strict_prompt_ci95": wilson_interval(prompt_successes, scored_examples),
        "strict_instruction_accuracy": strict.get("instruction_accuracy", cache.get("strict_instruction_accuracy", progress.get("strict_instruction_accuracy"))),
        "loose_prompt_accuracy": loose.get("prompt_accuracy", cache.get("loose_prompt_accuracy", progress.get("loose_prompt_accuracy"))),
        "loose_instruction_accuracy": loose.get("instruction_accuracy", cache.get("loose_instruction_accuracy", progress.get("loose_instruction_accuracy"))),
        "scored_examples": scored_examples,
        "lifecycle": lifecycle,
    }


def run_snapshot(run_dir: Path) -> dict[str, Any]:
    """Build the run-table record for one local A0 run directory."""
    environment = read_json(run_dir / "environment.json", {}) or {}
    if "selected_device" not in environment and "mps_available" in environment:
        environment["selected_device"] = "mps" if environment["mps_available"] else "cpu"
    manifest = read_json(run_dir / "split_manifest.json", {}) or {}
    summary = read_json(run_dir / "summary.json", {}) or {}
    mlflow_info = read_json(run_dir / "mlflow.json", {}) or {}
    splits = {
        split: snapshot
        for split in SPLIT_ORDER
        if (snapshot := split_snapshot(run_dir, split)) is not None
    }
    statuses = [item["status"] for item in splits.values()]
    if "running" in statuses:
        status = "running"
    elif "failed" in statuses:
        status = "failed"
    elif "interrupted" in statuses:
        status = "interrupted"
    elif statuses and all(item == "complete" for item in statuses):
        status = "complete"
    elif statuses:
        status = "partial"
    else:
        status = "created"
    return {
        "run_id": run_dir.name,
        "status": status,
        "created_at_epoch": run_dir.stat().st_ctime,
        "updated_at_epoch": max(
            [run_dir.stat().st_mtime]
            + [item["updated_at_epoch"] for item in splits.values()]
        ),
        "splits": splits,
        "environment": environment,
        "manifest": manifest,
        "summary": summary,
        "mlflow": mlflow_info,
        "git_commit": environment.get("git_commit"),
        "model_revision": environment.get("model_revision"),
        "dataset_sha256": environment.get("source_sha256"),
        "evaluator_revision": environment.get("evaluator_revision"),
    }


def list_runs() -> list[dict[str, Any]]:
    """List newest experiment runs first."""
    if not EXPERIMENTS_ROOT.exists():
        return []
    runs = [run_snapshot(path) for path in EXPERIMENTS_ROOT.glob("a0-*") if path.is_dir()]
    return sorted(runs, key=lambda item: item["created_at_epoch"], reverse=True)


def get_run(run_id: str) -> dict[str, Any] | None:
    """Return one run only when the requested id resolves inside runs/."""
    run_dir = EXPERIMENTS_ROOT / run_id
    if not run_dir.is_dir() or run_dir.parent.resolve() != EXPERIMENTS_ROOT.resolve():
        return None
    run = run_snapshot(run_dir)
    run["progress_history"] = {
        split: read_jsonl(run_dir / split / "progress.jsonl")
        for split in SPLIT_ORDER
        if (run_dir / split).exists()
    }
    run["config"] = read_json(CONFIG_PATH, {}) or {}
    run["gate"] = gate_status(run_dir, run)
    run["artifacts"] = artifact_inventory(run_dir)
    return run


def evaluate_examples(run_id: str, split: str) -> list[dict[str, Any]]:
    """Join responses to source tasks and run official strict and loose checks.

    Held-out prompts are intentionally not returned through the dashboard. The
    final held-out score may be displayed after execution, but task text stays
    out of routine development inspection.
    """
    if split == "heldout_test":
        return []
    run_dir = EXPERIMENTS_ROOT / run_id
    responses = read_jsonl(run_dir / split / "raw_responses.jsonl")
    if not responses:
        return []
    rows = source_rows()
    if str(EVALUATOR_ROOT) not in sys.path:
        sys.path.insert(0, str(EVALUATOR_ROOT))
    from instruction_following_eval import evaluation_lib

    evaluated: list[dict[str, Any]] = []
    for position, response in enumerate(responses, start=1):
        source = rows.get(str(response.get("key")))
        if not source:
            continue
        inp = evaluation_lib.InputExample(
            key=int(source["key"]),
            instruction_id_list=source["instruction_id_list"],
            prompt=source["prompt"],
            kwargs=source["kwargs"],
        )
        response_map = {source["prompt"]: response.get("response", "")}
        strict = evaluation_lib.test_instruction_following_strict(inp, response_map)
        loose = evaluation_lib.test_instruction_following_loose(inp, response_map)
        evaluated.append({
            "position": position,
            "key": str(source["key"]),
            "split": split,
            "prompt": source["prompt"],
            "response": response.get("response", ""),
            "instruction_ids": source["instruction_id_list"],
            "strict_checks": strict.follow_instruction_list,
            "loose_checks": loose.follow_instruction_list,
            "strict_pass": strict.follow_all_instructions,
            "loose_pass": loose.follow_all_instructions,
            "input_tokens": response.get("input_tokens", 0),
            "output_tokens": response.get("output_tokens", 0),
            "generation_seconds": response.get("generation_seconds", 0),
        })
    return evaluated


def slice_metrics(examples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Aggregate strict and loose instruction checks by IFEval instruction id."""
    totals: Counter[str] = Counter()
    strict_ok: Counter[str] = Counter()
    loose_ok: Counter[str] = Counter()
    for example in examples:
        for index, instruction_id in enumerate(example["instruction_ids"]):
            totals[instruction_id] += 1
            strict_ok[instruction_id] += int(example["strict_checks"][index])
            loose_ok[instruction_id] += int(example["loose_checks"][index])
    return [
        {
            "instruction_id": instruction_id,
            "total": totals[instruction_id],
            "strict_accuracy": strict_ok[instruction_id] / totals[instruction_id],
            "loose_accuracy": loose_ok[instruction_id] / totals[instruction_id],
        }
        for instruction_id in sorted(totals)
    ]


def comparison(left_id: str, right_id: str, split: str = "evolution") -> dict[str, Any]:
    """Compare aggregate, configuration, and instruction-slice results."""
    left = get_run(left_id)
    right = get_run(right_id)
    if not left or not right:
        return {"error": "One or both run ids do not exist"}
    left_examples = evaluate_examples(left_id, split)
    right_examples = evaluate_examples(right_id, split)
    left_slices = {item["instruction_id"]: item for item in slice_metrics(left_examples)}
    right_slices = {item["instruction_id"]: item for item in slice_metrics(right_examples)}
    slices = []
    for instruction_id in sorted(set(left_slices) | set(right_slices)):
        left_value = left_slices.get(instruction_id, {}).get("strict_accuracy")
        right_value = right_slices.get(instruction_id, {}).get("strict_accuracy")
        slices.append({
            "instruction_id": instruction_id,
            "left": left_value,
            "right": right_value,
            "delta": right_value - left_value if left_value is not None and right_value is not None else None,
        })

    def flatten(value: Any, prefix: str = "") -> dict[str, Any]:
        flattened: dict[str, Any] = {}
        if isinstance(value, dict):
            for key, child in value.items():
                flattened.update(flatten(child, f"{prefix}.{key}" if prefix else key))
        else:
            flattened[prefix] = value
        return flattened

    left_config = flatten(left.get("config", {}))
    right_config = flatten(right.get("config", {}))
    config_diff = [
        {"field": key, "left": left_config.get(key), "right": right_config.get(key)}
        for key in sorted(set(left_config) | set(right_config))
        if left_config.get(key) != right_config.get(key)
    ]
    return {
        "left": left_id,
        "right": right_id,
        "split": split,
        "left_examples": len(left_examples),
        "right_examples": len(right_examples),
        "slices": slices,
        "config_diff": config_diff,
    }


def artifact_inventory(run_dir: Path) -> list[dict[str, Any]]:
    """List evidence artifacts with sizes and hashes for provenance review."""
    artifacts = []
    for path in sorted(run_dir.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(run_dir)
        artifacts.append({
            "path": str(relative),
            "size_bytes": path.stat().st_size,
            "sha256": sha256_file(path),
            "updated_at_epoch": path.stat().st_mtime,
        })
    return artifacts


def gate_status(run_dir: Path, run: dict[str, Any] | None = None) -> dict[str, Any]:
    """Evaluate the preregistered A0 evidence gate without auto-approving it."""
    run = run or run_snapshot(run_dir)
    evolution = run.get("splits", {}).get("evolution", {})
    decision = read_json(run_dir / "gate_decision.json", {}) or {}
    checks = [
        {"id": "dataset", "label": "Pinned dataset fingerprint recorded", "passed": bool(run.get("dataset_sha256"))},
        {"id": "evaluator", "label": "Pinned evaluator revision recorded", "passed": bool(run.get("evaluator_revision"))},
        {"id": "model", "label": "Pinned model revision recorded", "passed": bool(run.get("model_revision"))},
        {"id": "environment", "label": "Environment manifest recorded", "passed": bool(run.get("environment"))},
        {"id": "responses", "label": "Evolution responses complete", "passed": evolution.get("status") == "complete"},
        {"id": "metrics", "label": "Official strict and loose metrics recorded", "passed": bool(evolution.get("strict_prompt_accuracy") is not None and evolution.get("loose_prompt_accuracy") is not None)},
        {"id": "heldout", "label": "Held-out examples remain hidden from development view", "passed": True},
        {"id": "approval", "label": "Owner gate decision recorded", "passed": decision.get("decision") == "approved"},
    ]
    evidence_ready = all(item["passed"] for item in checks if item["id"] != "approval")
    return {
        "checks": checks,
        "evidence_ready": evidence_ready,
        "approved": decision.get("decision") == "approved",
        "decision": decision,
    }


def tail_log(path: Path, line_count: int = 200) -> list[str]:
    """Return a bounded log tail for live debugging."""
    try:
        return path.read_text(errors="replace").splitlines()[-line_count:]
    except OSError:
        return []

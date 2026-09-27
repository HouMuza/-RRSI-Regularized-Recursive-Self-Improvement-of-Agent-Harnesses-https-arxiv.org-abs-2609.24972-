"""Serve the local RRSI experiment console and its JSON API."""

from __future__ import annotations

import argparse
import datetime
import json
import mimetypes
import os
import signal
import subprocess
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import experiment_store as store


ROOT = Path(__file__).resolve().parents[2]
STATIC_ROOT = ROOT / "phase-a/a0-infrastructure/dashboard"
RUNNER = ROOT / "phase-a/a0-infrastructure/run_a0.py"
A1_RUNNER = ROOT / "phase-a/a1-prompt-evolution/run_a1.py"
A1_RUNS_ROOT = ROOT / "runs/a1"
PYTHON = ROOT / ".venv/bin/python"
DEFAULT_RUN_ID = "a0-20260926-180736"
CONTROL_PATH = store.CONTROL_PATH
PROCESS_LOCK = threading.RLock()
ACTIVE_PROCESS: subprocess.Popen[str] | None = None
ACTIVE_LOG: Any = None


def utc_now() -> str:
    """Return an explicit UTC timestamp for process and decision records."""
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def atomic_json(path: Path, value: Any) -> None:
    """Replace a JSON record atomically so readers never see half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def reconcile_process() -> dict[str, Any]:
    """Reconcile the in-memory child process with durable control state."""
    global ACTIVE_PROCESS, ACTIVE_LOG
    with PROCESS_LOCK:
        control = store.active_control()
        if ACTIVE_PROCESS is not None and ACTIVE_PROCESS.poll() is not None:
            exit_code = ACTIVE_PROCESS.returncode
            if ACTIVE_LOG is not None:
                ACTIVE_LOG.close()
            ACTIVE_PROCESS = None
            ACTIVE_LOG = None
            control.update({
                "alive": False,
                "status": "complete" if exit_code == 0 else "interrupted" if exit_code in {130, -signal.SIGTERM} else "failed",
                "exit_code": exit_code,
                "finished_at": utc_now(),
            })
            atomic_json(CONTROL_PATH, control)
        return store.active_control()


def start_runner(run_id: str, split: str) -> tuple[bool, str]:
    """Launch one resumable runner and record its PID and log path."""
    global ACTIVE_PROCESS, ACTIVE_LOG
    with PROCESS_LOCK:
        current = reconcile_process()
        if current.get("alive"):
            return False, f"Runner {current.get('pid')} is already active."
        allowed_splits = ("evolution", "validation", "heldout_test")
        if split not in allowed_splits:
            return False, "The requested A0 split is invalid."
        normalized = run_id.removeprefix("a0-").replace("-", "")
        if not run_id.startswith("a0-") or not normalized.isdigit():
            return False, "The requested run id is invalid."
        if not RUNNER.exists() or not PYTHON.exists():
            return False, "The runner or project Python environment is missing."

        run_dir = store.EXPERIMENTS_ROOT / run_id
        requested_snapshot = store.split_snapshot(run_dir, split) or {}
        if requested_snapshot.get("status") == "complete":
            # An already-open browser tab may still submit the previous split
            # after the dashboard code is updated. Resolve that stale request
            # to the first unfinished split on the server, where protocol state
            # is authoritative.
            split = next(
                (
                    candidate
                    for candidate in allowed_splits
                    if (store.split_snapshot(run_dir, candidate) or {}).get("status") != "complete"
                ),
                "",
            )
            if not split:
                return False, "Every A0 split is already complete."

        # Enforce the evaluation sequence in the backend as well as the UI.
        # This prevents an edited browser request from opening held-out data
        # before evolution and validation evidence has been completed.
        required_predecessors = {
            "evolution": (),
            "validation": ("evolution",),
            "heldout_test": ("evolution", "validation"),
        }
        for predecessor in required_predecessors[split]:
            summary = store.split_snapshot(run_dir, predecessor) or {}
            if summary.get("status") != "complete":
                return False, f"Complete {predecessor.replace('_', ' ')} before starting {split.replace('_', ' ')}."

        log_dir = store.RUNS_ROOT / "dashboard"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / f"{run_id}-{split}-{int(time.time())}.log"
        ACTIVE_LOG = log_path.open("a", encoding="utf-8")
        command = [str(PYTHON), str(RUNNER), "--run-id", run_id, "--splits", split]
        environment = os.environ.copy()
        environment.setdefault("NLTK_DATA", str(store.RUNS_ROOT / "nltk_data"))
        try:
            ACTIVE_PROCESS = subprocess.Popen(
                command,
                cwd=ROOT,
                env=environment,
                stdout=ACTIVE_LOG,
                stderr=subprocess.STDOUT,
                text=True,
                start_new_session=True,
            )
        except OSError as error:
            ACTIVE_LOG.close()
            ACTIVE_LOG = None
            return False, f"Could not launch the runner: {error}"
        control = {
            "pid": ACTIVE_PROCESS.pid,
            "run_id": run_id,
            "split": split,
            "status": "running",
            "alive": True,
            "started_at": utc_now(),
            "log_path": str(log_path.relative_to(ROOT)),
            "command": command,
        }
        atomic_json(CONTROL_PATH, control)
        return True, f"Started {run_id} / {split}."


def a1_snapshot() -> dict[str, Any]:
    """Summarize A1 protocol, candidates, decisions, and comparisons."""
    config = store.read_json(ROOT / "phase-a/a1-prompt-evolution/config.json", {})
    experiments = A1_RUNS_ROOT / "experiments"
    run_dirs = sorted((path for path in experiments.glob("a1-*") if path.is_dir()), reverse=True) if experiments.exists() else []
    runs = []
    for run_dir in run_dirs:
        state = store.read_json(run_dir / "search_state.json", {})
        candidates = []
        for path in sorted((run_dir / "candidates").glob("*/candidate.json")) if (run_dir / "candidates").exists() else []:
            candidate = store.read_json(path, {})
            evaluation_summaries = []
            for metrics_path in sorted(path.parent.glob("evaluations/*/metrics.json")):
                metrics = store.read_json(metrics_path, {})
                evaluation_summaries.append({
                    "stage": metrics_path.parent.name,
                    "strict_prompt_accuracy": metrics.get("strict", {}).get("prompt_accuracy"),
                    "strict_instruction_accuracy": metrics.get("strict", {}).get("instruction_accuracy"),
                })
            candidate["evaluations"] = evaluation_summaries
            candidates.append(candidate)
        decisions = [store.read_json(path, {}) for path in sorted((run_dir / "generations").glob("*.json"))] if (run_dir / "generations").exists() else []
        comparisons = {
            path.stem: store.read_json(path, {})
            for path in sorted((run_dir / "comparisons").glob("*.json"))
        } if (run_dir / "comparisons").exists() else {}
        if state.get("status") == "complete":
            next_stage = "validation" if "validation" not in comparisons else "heldout_test" if "heldout_test" not in comparisons else None
        else:
            next_stage = "search"
        runs.append({
            "run_id": run_dir.name,
            "state": state,
            "candidates": candidates,
            "decisions": decisions,
            "comparisons": comparisons,
            "next_stage": next_stage,
            "complete": next_stage is None,
        })
    return {"config": config, "runs": runs, "control": reconcile_process()}


def start_a1_runner(run_id: str | None, stage: str) -> tuple[bool, str, str]:
    """Launch one resumable A1 protocol stage under the shared process guard."""
    global ACTIVE_PROCESS, ACTIVE_LOG
    with PROCESS_LOCK:
        current = reconcile_process()
        if current.get("alive"):
            return False, f"Runner {current.get('pid')} is already active.", str(run_id or "")
        if stage not in {"search", "validation", "heldout_test"}:
            return False, "The requested A1 stage is invalid.", str(run_id or "")
        if not run_id:
            run_id = datetime.datetime.now().strftime("a1-%Y%m%d-%H%M%S")
        normalized = run_id.removeprefix("a1-").replace("-", "")
        if not run_id.startswith("a1-") or not normalized.isdigit():
            return False, "The requested A1 run id is invalid.", run_id
        if not A1_RUNNER.exists() or not PYTHON.exists():
            return False, "The A1 runner or project Python environment is missing.", run_id

        # The server derives the legal next stage from durable evidence rather
        # than trusting the browser. This keeps validation and held-out data
        # outside candidate selection even when an old tab submits stale data.
        run_dir = A1_RUNS_ROOT / "experiments" / run_id
        state = store.read_json(run_dir / "search_state.json", {})
        comparisons_dir = run_dir / "comparisons"
        expected_stage = "search"
        if state.get("status") == "complete":
            expected_stage = "validation" if not (comparisons_dir / "validation.json").exists() else "heldout_test" if not (comparisons_dir / "heldout_test.json").exists() else "complete"
        if expected_stage == "complete":
            return False, "Every A1 stage is already complete.", run_id
        stage = expected_stage

        log_dir = A1_RUNS_ROOT / "dashboard"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / f"{run_id}-{stage}-{int(time.time())}.log"
        ACTIVE_LOG = log_path.open("a", encoding="utf-8")
        command = [str(PYTHON), str(A1_RUNNER), "--run-id", run_id, "--stage", stage]
        environment = os.environ.copy()
        environment.setdefault("NLTK_DATA", str(store.RUNS_ROOT / "nltk_data"))
        try:
            ACTIVE_PROCESS = subprocess.Popen(command, cwd=ROOT, env=environment, stdout=ACTIVE_LOG, stderr=subprocess.STDOUT, text=True, start_new_session=True)
        except OSError as error:
            ACTIVE_LOG.close()
            ACTIVE_LOG = None
            return False, f"Could not launch the A1 runner: {error}", run_id
        control = {
            "pid": ACTIVE_PROCESS.pid, "run_id": run_id, "phase": "a1", "stage": stage,
            "status": "running", "alive": True, "started_at": utc_now(),
            "log_path": str(log_path.relative_to(ROOT)), "command": command,
        }
        atomic_json(CONTROL_PATH, control)
        return True, f"Started {run_id} / {stage}.", run_id


def stop_runner() -> tuple[bool, str]:
    """Request graceful termination of the exact PID in the control record."""
    with PROCESS_LOCK:
        control = reconcile_process()
        pid = control.get("pid")
        if not control.get("alive") or not pid:
            return False, "No active experiment runner was found."
        try:
            os.kill(int(pid), signal.SIGTERM)
        except OSError as error:
            return False, f"Could not stop runner {pid}: {error}"
        control.update({"status": "stopping", "stop_requested_at": utc_now()})
        atomic_json(CONTROL_PATH, control)
        return True, f"Stop requested for runner {pid}."


class DashboardHandler(BaseHTTPRequestHandler):
    """Serve static console assets and the local experiment JSON API."""

    server_version = "rrsi-a0-console/1"

    def send_json(self, value: Any, status: int = 200) -> None:
        """Serialize one API response with consistent no-cache headers."""
        payload = json.dumps(value, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def read_body(self) -> dict[str, Any]:
        """Read a bounded JSON or form body."""
        length = int(self.headers.get("Content-Length", "0"))
        if length > 64 * 1024:
            raise ValueError("Request body is too large")
        raw = self.rfile.read(length)
        if "application/json" in self.headers.get("Content-Type", ""):
            return json.loads(raw.decode("utf-8") or "{}")
        values = parse_qs(raw.decode("utf-8"))
        return {key: items[0] for key, items in values.items()}

    def serve_static(self, request_path: str) -> None:
        """Serve only files that resolve under the checked-in static folder."""
        relative = "index.html" if request_path in {"", "/"} else unquote(request_path.lstrip("/"))
        candidate = (STATIC_ROOT / relative).resolve()
        if STATIC_ROOT.resolve() not in candidate.parents and candidate != STATIC_ROOT.resolve():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not candidate.is_file():
            candidate = STATIC_ROOT / "index.html"
        payload = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8" if content_type.startswith("text/") else content_type)
        self.send_header("Content-Length", str(len(payload)))
        # The console is a local operational tool. Always fetch current UI code
        # so an open experiment cannot keep obsolete run-control behavior.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def serve_artifact(self, run_id: str, artifact_path: str) -> None:
        """Download one run artifact after resolving it inside that run only."""
        run_root = (store.EXPERIMENTS_ROOT / run_id).resolve()
        candidate = (run_root / artifact_path).resolve()
        if run_root not in candidate.parents or not candidate.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        payload = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Content-Disposition", f'attachment; filename="{candidate.name}"')
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        """Route read-only API requests and static browser assets."""
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        path = parsed.path
        if path == "/health":
            self.send_json({"ok": True, "control": reconcile_process()})
            return
        if path == "/api/overview":
            runs = store.list_runs()
            selected = store.get_run(runs[0]["run_id"]) if runs else None
            self.send_json({
                "generated_at": utc_now(),
                "control": reconcile_process(),
                "runs": runs,
                "selected": selected,
                "protocol": store.read_json(store.CONFIG_PATH, {}),
            })
            return
        if path == "/api/runs":
            self.send_json({"runs": store.list_runs(), "control": reconcile_process()})
            return
        if path.startswith("/api/runs/"):
            run_id = unquote(path.removeprefix("/api/runs/"))
            run = store.get_run(run_id)
            self.send_json(run or {"error": "Run not found"}, 200 if run else 404)
            return
        if path == "/api/examples":
            run_id = query.get("run_id", [""])[0]
            split = query.get("split", ["evolution"])[0]
            examples = store.evaluate_examples(run_id, split)
            self.send_json({"examples": examples, "slices": store.slice_metrics(examples)})
            return
        if path == "/api/compare":
            left = query.get("left", [""])[0]
            right = query.get("right", [""])[0]
            split = query.get("split", ["evolution"])[0]
            self.send_json(store.comparison(left, right, split))
            return
        if path == "/api/logs":
            control = reconcile_process()
            relative = control.get("log_path")
            log_path = ROOT / relative if relative else Path("/nonexistent")
            self.send_json({"control": control, "lines": store.tail_log(log_path)})
            return
        if path == "/api/mlflow":
            self.send_json({
                "tracking_uri": f"sqlite:///{(store.RUNS_ROOT / 'mlflow.db').as_posix()}",
                "database_exists": (store.RUNS_ROOT / "mlflow.db").exists(),
                "ui_command": ".venv/bin/mlflow server --backend-store-uri sqlite:///runs/a0/mlflow.db --port 5000",
                "ui_url": "http://127.0.0.1:5000",
            })
            return
        if path == "/api/a1":
            self.send_json(a1_snapshot())
            return
        if path == "/api/artifact":
            self.serve_artifact(
                query.get("run_id", [""])[0],
                query.get("path", [""])[0],
            )
            return
        self.serve_static(path)

    def do_POST(self) -> None:  # noqa: N802
        """Route explicit local control and gate-decision actions."""
        try:
            body = self.read_body()
            if self.path == "/api/runs/start":
                run_id = str(body.get("run_id") or DEFAULT_RUN_ID)
                split = str(body.get("split") or "evolution")
                ok, message = start_runner(run_id, split)
                self.send_json({"ok": ok, "message": message, "control": reconcile_process()}, 200 if ok else 409)
                return
            if self.path == "/api/runs/stop":
                ok, message = stop_runner()
                self.send_json({"ok": ok, "message": message, "control": reconcile_process()}, 200 if ok else 409)
                return
            if self.path == "/api/a1/start":
                run_id = str(body.get("run_id") or "") or None
                stage = str(body.get("stage") or "search")
                ok, message, resolved_run_id = start_a1_runner(run_id, stage)
                self.send_json({"ok": ok, "message": message, "run_id": resolved_run_id, "control": reconcile_process()}, 200 if ok else 409)
                return
            if self.path == "/api/gate":
                run_id = str(body.get("run_id") or "")
                decision = str(body.get("decision") or "")
                note = str(body.get("note") or "")[:2000]
                if decision not in {"approved", "rejected"}:
                    raise ValueError("Gate decision must be approved or rejected")
                run_dir = store.EXPERIMENTS_ROOT / run_id
                if not run_dir.is_dir():
                    raise ValueError("Run does not exist")
                gate = store.gate_status(run_dir)
                if decision == "approved" and not gate["evidence_ready"]:
                    self.send_json({"ok": False, "message": "A0 evidence is not complete yet."}, 409)
                    return
                record = {"decision": decision, "note": note, "recorded_at": utc_now()}
                atomic_json(run_dir / "gate_decision.json", record)
                self.send_json({"ok": True, "message": f"Gate decision recorded: {decision}", "decision": record})
                return
            self.send_error(HTTPStatus.NOT_FOUND)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json({"ok": False, "message": str(error)}, 400)

    def log_message(self, format: str, *args: object) -> None:
        """Keep request logs readable without suppressing operational evidence."""
        print(f"dashboard {self.address_string()} {format % args}", flush=True)


def main() -> None:
    """Start the threaded localhost experiment console."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    print(f"RRSI experiment console available at http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

"""Serve a read-only local dashboard for A0's live JSON progress files.

The dashboard requires only Python's standard library. It reads artifacts
written by run_a0.py and refreshes automatically, so no training or inference
process has to be modified by the web server.
"""

from __future__ import annotations

import argparse
import html
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RUNS = ROOT / "runs/a0/experiments"


class DashboardHandler(BaseHTTPRequestHandler):
    """Return a single self-refreshing page with the latest run metrics."""

    def do_GET(self) -> None:  # noqa: N802, required by the stdlib server API
        if self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
            return

        run_dirs = sorted((path for path in RUNS.glob("a0-*") if path.is_dir()), reverse=True)
        rows = []
        for run_dir in run_dirs:
            for progress_file in sorted(run_dir.glob("*/progress.json")):
                try:
                    progress = json.loads(progress_file.read_text())
                except (OSError, json.JSONDecodeError):
                    # A partially written file is skipped and will appear on
                    # the next browser refresh once the atomic update lands.
                    continue
                # Reconcile the heartbeat with the durable response file. This
                # catches a crash between writing a response and its progress
                # update, and prevents old runs from appearing live forever.
                split_dir = progress_file.parent
                response_file = split_dir / "raw_responses.jsonl"
                completed = sum(1 for line in response_file.open() if line.strip()) if response_file.exists() else 0
                progress["completed"] = completed
                total = int(progress.get("total", 0))
                progress["percent"] = 100.0 * completed / total if total else 0.0
                age_seconds = max(time.time() - progress_file.stat().st_mtime, 0.0)
                progress["age_seconds"] = age_seconds
                if total and completed >= total:
                    progress["status"] = "complete"
                elif age_seconds > 120:
                    progress["status"] = "stale, interrupted"
                rows.append((run_dir.name, split_dir.name, progress))

        cards = []
        chart_data = []
        for run_id, split, data in rows:
            history_path = RUNS / run_id / split / "progress.jsonl"
            history = []
            if history_path.exists():
                for line in history_path.read_text().splitlines():
                    try:
                        history.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
            chart_data.append({"run": f"{run_id} / {split}", "points": history})
            pct = max(0.0, min(float(data.get("percent", 0)), 100.0))
            cards.append(f"""
            <section class="card">
              <div class="top"><h2>{html.escape(run_id)} / {html.escape(split)}</h2>
                <span class="status">{html.escape(data.get('status', 'unknown'))}</span></div>
              <div class="bar"><div style="width:{pct:.1f}%"></div></div>
              <p class="count">{data.get('completed', 0)} / {data.get('total', 0)} examples <b>{pct:.1f}%</b></p>
              <div class="grid">
                <div><label>strict prompt</label><strong>{float(data.get('strict_prompt_accuracy', 0)):.1%}</strong><small>{data.get('strict_prompt_correct', 0)}/{data.get('scored_examples', 0)} scored</small></div>
                <div><label>strict instruction</label><strong>{float(data.get('strict_instruction_accuracy', 0)):.1%}</strong></div>
                <div><label>loose prompt</label><strong>{float(data.get('loose_prompt_accuracy', 0)):.1%}</strong><small>{data.get('loose_prompt_correct', 0)}/{data.get('scored_examples', 0)} scored</small></div>
                <div><label>loose instruction</label><strong>{float(data.get('loose_instruction_accuracy', 0)):.1%}</strong></div>
                <div><label>speed</label><strong>{float(data.get('examples_per_second', 0)):.3f} ex/s</strong></div>
                <div><label>avg response</label><strong>{float(data.get('mean_output_tokens', 0)):.0f} tokens</strong></div>
                <div><label>avg generation</label><strong>{float(data.get('mean_generation_seconds', 0)):.1f}s</strong></div>
                <div><label>elapsed</label><strong>{float(data.get('elapsed_seconds', 0))/60:.1f} min</strong></div>
              </div>
              <p class="updated">Last progress write: {float(data.get('age_seconds', 0)) / 60:.1f} minutes ago | {html.escape(str(data.get('updated_at', '')))}</p>
            </section>""")

        content = "\n".join(cards) or '<p class="empty">No active A0 progress found yet. Start the runner and refresh this page.</p>'
        chart_payload = json.dumps(chart_data).replace("</", "<\\/")
        page = f"""<!doctype html>
        <html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3">
        <meta name="viewport" content="width=device-width, initial-scale=1"><title>a0 experiment dashboard</title>
        <style>
          :root {{ color-scheme: dark; font: 15px/1.45 -apple-system, BlinkMacSystemFont, sans-serif; }}
          body {{ margin: 0; background: #10141b; color: #e7edf5; }}
          main {{ max-width: 980px; margin: 0 auto; padding: 36px 22px 70px; }}
          h1 {{ margin: 0 0 6px; font-size: 28px; }}
          .intro {{ color: #9aa8b8; margin: 0 0 24px; }}
          .card {{ background: #1a222d; border: 1px solid #2a3746; border-radius: 14px; padding: 20px; margin: 16px 0; }}
          .top {{ display: flex; justify-content: space-between; gap: 12px; align-items: center; }}
          h2 {{ font-size: 17px; margin: 0; }} .status {{ color: #8bc5a3; font-size: 12px; }}
          .bar {{ height: 9px; background: #303b49; border-radius: 10px; overflow: hidden; margin-top: 20px; }}
          .bar div {{ height: 100%; background: #60c796; transition: width .35s; }}
          .count {{ display: flex; justify-content: space-between; color: #abb8c7; margin: 7px 0 18px; }}
          .grid {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }}
          .grid div {{ background: #141a23; border-radius: 9px; padding: 11px; }}
          label {{ display: block; color: #8d9bac; font-size: 12px; margin-bottom: 3px; }}
          strong {{ font-size: 18px; }} small {{ display: block; color: #78879a; font-size: 10px; }} .updated {{ color: #78879a; font-size: 11px; margin: 16px 0 0; }}
          .empty {{ color: #aab6c5; padding: 24px; background: #1a222d; border-radius: 12px; }}
          .chart {{ background: #1a222d; border: 1px solid #2a3746; border-radius: 14px; padding: 16px; margin: 20px 0; }}
          canvas {{ width: 100%; height: 250px; }}
          @media (max-width: 650px) {{ .grid {{ grid-template-columns: repeat(2, 1fr); }} main {{ padding: 24px 14px; }} }}
        </style></head><body><main><h1>a0 experiment dashboard</h1>
        <p class="intro">Live local status from the frozen Qwen3-0.6B IFEval run. Refreshes every three seconds.</p>
        <section class="chart"><h2>score over time</h2><canvas id="scores" width="900" height="250"></canvas></section>
        {content}
        <script>
        const runs = {chart_payload};
        const canvas = document.getElementById('scores');
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#1a222d'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        const colors = ['#60c796', '#71aef5', '#f1b85b', '#df8de1'];
        let series = [];
        runs.forEach((run, ri) => ['strict_prompt_accuracy','loose_prompt_accuracy'].forEach((metric, mi) => {{
          const pts = run.points.filter(p => Number.isFinite(p[metric]));
          if (pts.length) series.push({{name: run.run + ' ' + (mi ? 'loose' : 'strict'), pts, color: colors[(ri * 2 + mi) % colors.length]}});
        }}));
        ctx.font = '12px sans-serif'; ctx.fillStyle = '#9aa8b8';
        ctx.fillText('100%', 6, 18); ctx.fillText('0%', 6, 235);
        ctx.strokeStyle = '#354252'; ctx.beginPath(); ctx.moveTo(44, 12); ctx.lineTo(44, 230); ctx.lineTo(890, 230); ctx.stroke();
        series.forEach(s => {{
          ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.beginPath();
          s.pts.forEach((p, i) => {{ const x=48+(i/Math.max(s.pts.length-1,1))*830; const val=p[s.name.endsWith('loose')?'loose_prompt_accuracy':'strict_prompt_accuracy']; const y=225-val*205; i?ctx.lineTo(x,y):ctx.moveTo(x,y); }});
          ctx.stroke();
        }});
        </script></main></body></html>"""
        payload = page.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: object) -> None:
        """Keep access logs concise while leaving requests observable."""
        print(f"dashboard {self.address_string()} {format % args}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", help="Local bind address")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    print(f"Dashboard available at http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

/* RRSI A0 experiment console.
 *
 * The browser is deliberately a thin client. Scientific state is read from
 * versioned run artifacts through the local API, while control actions are
 * explicit POST requests. No metric is recomputed in JavaScript.
 */

const state = {
  overview: null,
  selectedRun: null,
  examples: null,
  logs: null,
  a1: null,
  scope: localStorage.getItem("rrsi-experiment-scope") || "a1",
  view: location.hash.slice(1) || "overview",
};

const content = document.getElementById("content");
const title = document.getElementById("page-title");
const banner = document.getElementById("banner");
const startButton = document.getElementById("start-button");
const stopButton = document.getElementById("stop-button");
const refreshButton = document.getElementById("refresh-button");
const dialog = document.getElementById("example-dialog");
const experimentSelect = document.getElementById("experiment-select");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatPercent(value, digits = 1) {
  return value == null ? "pending" : `${(Number(value) * 100).toFixed(digits)}%`;
}

function formatDuration(seconds) {
  if (seconds == null) return "pending";
  const value = Math.max(Number(seconds), 0);
  if (value < 60) return `${value.toFixed(0)}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${Math.floor(value % 60)}s`;
  return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
}

function formatInterval(interval) {
  return interval?.length === 2
    ? `95% CI ${formatPercent(interval[0])} to ${formatPercent(interval[1])}`
    : "uncertainty pending";
}

function formatTime(epoch) {
  if (!epoch) return "unknown";
  return new Date(Number(epoch) * 1000).toLocaleString();
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(bytes || 0);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function statusBadge(status) {
  return `<span class="status ${escapeHtml(status)}">${escapeHtml(status || "unknown")}</span>`;
}

function showBanner(message, kind = "success") {
  banner.textContent = message;
  banner.className = `banner ${kind}`;
  setTimeout(() => { banner.className = "banner hidden"; }, 6500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {"Content-Type": "application/json", ...(options.headers || {})},
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error || `Request failed: ${response.status}`);
  return data;
}

function selectedRunId() {
  return state.selectedRun?.run_id || state.overview?.runs?.[0]?.run_id || "a0-20260926-180736";
}

function selectedSplit(run = state.selectedRun) {
  return run?.splits?.evolution || {};
}

function nextRunnableSplit(run = state.selectedRun) {
  // Runs proceed in protocol order. An incomplete split is always resumed
  // before a later split can start, including after a browser refresh.
  for (const name of ["evolution", "validation", "heldout_test"]) {
    if (run?.splits?.[name]?.status !== "complete") return name;
  }
  return null;
}

function updateChrome() {
  const control = state.overview?.control || {};
  const running = Boolean(control.alive);
  document.getElementById("system-pulse").className = `pulse ${running ? "running" : ""}`;
  document.getElementById("system-label").textContent = running
    ? `${control.run_id} / ${control.stage || control.split} is running`
    : "local runner idle";
  const a1Context = state.view === "a1" || (state.view === "overview" && state.scope === "a1");
  startButton.classList.toggle("hidden", running || a1Context);
  stopButton.classList.toggle("hidden", !running);
  const nextSplit = nextRunnableSplit();
  if (!running) {
    startButton.disabled = nextSplit == null;
    startButton.textContent = nextSplit == null
      ? "a0 run complete"
      : `${state.selectedRun?.splits?.[nextSplit]?.status === "not_started" ? "start" : "resume"} ${nextSplit.replaceAll("_", " ")}`;
  }
  document.getElementById("last-refresh").textContent = `updated ${new Date().toLocaleTimeString()}`;
  experimentSelect.value = state.scope;
  document.getElementById("scope-label").textContent = state.scope === "a1"
    ? "phase a / a1 prompt evolution"
    : "phase a / a0 infrastructure";
  document.querySelectorAll("nav a").forEach(link => {
    link.classList.toggle("active", link.dataset.view === state.view);
  });
}

function progressRows(run) {
  const splits = ["evolution", "validation", "heldout_test"];
  return splits.map(name => {
    const split = run?.splits?.[name];
    if (!split) {
      return `<div class="progress-row"><strong>${name.replace("_", " ")}</strong><div class="progress"><span style="width:0%"></span></div><span>0%</span>${statusBadge("not_started")}</div>`;
    }
    return `<div class="progress-row">
      <strong>${escapeHtml(name.replaceAll("_", " "))}</strong>
      <div class="progress"><span style="width:${Math.min(split.percent, 100)}%"></span></div>
      <span>${split.percent.toFixed(1)}%</span>
      ${statusBadge(split.status)}
    </div>`;
  }).join("");
}

function metricChart(history, metricNames) {
  const points = history || [];
  if (!points.length) return `<div class="chart-empty">No metric history has been recorded yet.</div>`;
  const width = 900, height = 245, left = 46, right = 12, top = 16, bottom = 27;
  const colors = ["#1877f2", "#16855b", "#d07a16", "#7b61b3"];
  const dashPatterns = ["none", "8 5", "2 4", "11 4 2 4"];
  const x = index => left + index / Math.max(points.length - 1, 1) * (width - left - right);
  const y = value => top + (1 - Number(value || 0)) * (height - top - bottom);
  const lines = metricNames.map((metric, metricIndex) => {
    const path = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point[metric]).toFixed(1)}`).join(" ");
    const lastPoint = points[points.length - 1];
    return `<path d="${path}" fill="none" stroke="${colors[metricIndex]}" stroke-width="2.5" stroke-dasharray="${dashPatterns[metricIndex]}"/><circle cx="${x(points.length - 1)}" cy="${y(lastPoint[metric])}" r="3" fill="${colors[metricIndex]}"/><text x="${left + metricIndex * 190}" y="240" fill="${colors[metricIndex]}" font-size="11">${escapeHtml(metric.replaceAll("_", " "))}</text>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Metric history">
    <line x1="${left}" y1="${top}" x2="${left}" y2="${height-bottom}" stroke="#d8d6df"/>
    <line x1="${left}" y1="${height-bottom}" x2="${width-right}" y2="${height-bottom}" stroke="#d8d6df"/>
    <line x1="${left}" y1="${y(.5)}" x2="${width-right}" y2="${y(.5)}" stroke="#e9e7ed" stroke-dasharray="4 5"/>
    <text x="8" y="${top+4}" fill="#7c7884" font-size="10">100%</text><text x="17" y="${height-bottom}" fill="#7c7884" font-size="10">0%</text>
    ${lines}
  </svg>`;
}

function kpi(label, value, detail = "") {
  return `<div class="card kpi"><label>${escapeHtml(label)}</label><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></div>`;
}

function renderA0Overview() {
  const run = state.selectedRun;
  if (!run) { content.innerHTML = `<div class="empty">No A0 run exists yet.</div>`; return; }
  const split = selectedSplit(run);
  const gate = run.gate || {};
  const warnings = [];
  if (run.status === "interrupted") warnings.push("The last runner stopped before the evolution split completed.");
  if (split.status === "running" && split.age_seconds > 120) warnings.push("The run heartbeat is stale.");
  if (!run.environment?.mps_available) warnings.push("The model is running on CPU because MPS is unavailable in this environment.");
  content.innerHTML = `
    ${warnings.length ? `<div class="banner error">${warnings.map(escapeHtml).join(" ")}</div>` : ""}
    <div class="grid kpis">
      ${kpi("run state", run.status, `${split.completed || 0} of ${split.total || 0} evolution examples`)}
      ${kpi("strict prompt", formatPercent(split.strict_prompt_accuracy), `${split.scored_examples || 0} scored · ${formatInterval(split.strict_prompt_ci95)}`)}
      ${kpi("strict instruction", formatPercent(split.strict_instruction_accuracy), "official IFEval verifier")}
      ${kpi("estimated remaining", formatDuration(split.eta_seconds), `${(split.examples_per_second || 0).toFixed(3)} examples / second`)}
    </div>
    <div class="grid main-side section">
      <div class="card">
        <div class="card-head"><h2>phase progress</h2>${statusBadge(run.status)}</div>
        ${progressRows(run)}
      </div>
      <div class="card">
        <div class="card-head"><h2>a0 evidence gate</h2>${statusBadge(gate.approved ? "approved" : gate.evidence_ready ? "ready" : "blocked")}</div>
        <div class="checklist">${(gate.checks || []).map(check => `<div class="check ${check.passed ? "passed" : ""}"><span class="icon">${check.passed ? "✓" : "×"}</span><span>${escapeHtml(check.label)}</span></div>`).join("")}</div>
      </div>
    </div>
    <div class="grid two section">
      <div class="card"><div class="card-head"><h2>live quality</h2><span class="muted">prompt and instruction checks</span></div>${metricChart(run.progress_history?.evolution, ["strict_prompt_accuracy", "strict_instruction_accuracy", "loose_prompt_accuracy"])}</div>
      <div class="card"><div class="card-head"><h2>frozen protocol</h2><button class="button ghost" data-nav="system">inspect provenance</button></div>
        <div class="kv">
          <div>model</div><div>${escapeHtml(state.overview.protocol?.model?.name)}</div>
          <div>model revision</div><div class="run-id">${escapeHtml(run.model_revision)}</div>
          <div>dataset</div><div>${escapeHtml(state.overview.protocol?.benchmark?.name)}</div>
          <div>dataset fingerprint</div><div class="run-id">${escapeHtml(run.dataset_sha256)}</div>
          <div>evaluator revision</div><div class="run-id">${escapeHtml(run.evaluator_revision)}</div>
          <div>device</div><div>${escapeHtml(run.environment?.selected_device || "unknown")}</div>
        </div>
      </div>
    </div>`;
  bindNavigationButtons();
}

function renderOverview() {
  // The overview follows the selected experiment. A0 remains available as
  // historical baseline evidence while A1 becomes the default active context.
  if (state.scope === "a1") renderA1();
  else renderA0Overview();
}

function renderRuns() {
  const runs = state.overview?.runs || [];
  content.innerHTML = `<div class="toolbar"><input id="run-search" type="search" placeholder="Search run id, state, model, or revision"><select id="run-status"><option value="all">all states</option>${[...new Set(runs.map(run => run.status))].map(value => `<option>${escapeHtml(value)}</option>`).join("")}</select></div><div class="card flush">
    <div class="card-head" style="padding:17px;margin:0"><h2>run registry</h2><span class="muted">${runs.length} recorded run${runs.length === 1 ? "" : "s"}</span></div>
    <table><thead><tr><th>run</th><th>state</th><th>evolution</th><th>strict prompt</th><th>tokens</th><th>device</th><th>updated</th></tr></thead>
    <tbody id="run-body"></tbody></table></div>`;
  const renderRows = () => {
    const query = document.getElementById("run-search").value.toLowerCase();
    const status = document.getElementById("run-status").value;
    const filtered = runs.filter(run => {
      const haystack = `${run.run_id} ${run.status} ${run.model_revision} ${run.git_commit}`.toLowerCase();
      return (!query || haystack.includes(query)) && (status === "all" || run.status === status);
    });
    document.getElementById("run-body").innerHTML = filtered.map(run => {
      const split = run.splits?.evolution || {};
      return `<tr data-run="${escapeHtml(run.run_id)}"><td class="run-id">${escapeHtml(run.run_id)}</td><td>${statusBadge(run.status)}</td><td>${split.completed || 0} / ${split.total || 0}</td><td>${formatPercent(split.strict_prompt_accuracy)}</td><td>${Math.round(split.mean_output_tokens || 0)} avg out</td><td>${escapeHtml(run.environment?.selected_device || "unknown")}</td><td>${formatTime(run.updated_at_epoch)}</td></tr>`;
    }).join("");
    document.querySelectorAll("[data-run]").forEach(row => row.addEventListener("click", async () => {
      state.selectedRun = await api(`/api/runs/${encodeURIComponent(row.dataset.run)}`);
      location.hash = "run";
    }));
  };
  document.getElementById("run-search").addEventListener("input", renderRows);
  document.getElementById("run-status").addEventListener("input", renderRows);
  renderRows();
}

function renderRunDetail() {
  const run = state.selectedRun;
  const split = selectedSplit(run);
  content.innerHTML = `
    <div class="card">
      <div class="card-head"><div><p class="eyebrow">run detail</p><h2 class="run-id">${escapeHtml(run.run_id)}</h2></div>${statusBadge(run.status)}</div>
      ${progressRows(run)}
    </div>
    <div class="grid kpis section">
      ${kpi("strict prompt", formatPercent(split.strict_prompt_accuracy), `${split.scored_examples || 0} scored · ${formatInterval(split.strict_prompt_ci95)}`)}
      ${kpi("loose prompt", formatPercent(split.loose_prompt_accuracy), "format-tolerant upper bound")}
      ${kpi("throughput", `${(split.examples_per_second || 0).toFixed(3)} ex/s`, `${formatDuration(split.mean_generation_seconds)} average`)}
      ${kpi("tokens", `${Math.round(split.mean_output_tokens || 0)} out`, `${Math.round(split.mean_input_tokens || 0)} average input`)}
    </div>
    <div class="grid two section">
      <div class="card"><div class="card-head"><h2>metric history</h2></div>${metricChart(run.progress_history?.evolution, ["strict_prompt_accuracy", "strict_instruction_accuracy", "loose_prompt_accuracy"])}</div>
      <div class="card"><div class="card-head"><h2>lineage</h2></div><div class="kv">
        <div>git commit</div><div class="run-id">${escapeHtml(run.git_commit || "not recorded")}</div>
        <div>MLflow run</div><div class="run-id">${escapeHtml(run.mlflow?.run_id || "pending")}</div>
        <div>model revision</div><div class="run-id">${escapeHtml(run.model_revision)}</div>
        <div>dataset hash</div><div class="run-id">${escapeHtml(run.dataset_sha256)}</div>
        <div>evaluator</div><div class="run-id">${escapeHtml(run.evaluator_revision)}</div>
        <div>python</div><div>${escapeHtml(run.environment?.python || "unknown")}</div>
      </div></div>
    </div>
    <div class="card section flush"><div class="card-head" style="padding:17px;margin:0"><h2>artifacts</h2><span class="muted">content-addressed evidence</span></div>
      <table><thead><tr><th>path</th><th>size</th><th>sha-256</th><th>updated</th></tr></thead><tbody>${(run.artifacts || []).map(item => `<tr><td><a href="/api/artifact?run_id=${encodeURIComponent(run.run_id)}&path=${encodeURIComponent(item.path)}">${escapeHtml(item.path)}</a></td><td>${formatBytes(item.size_bytes)}</td><td class="artifact-hash">${escapeHtml(item.sha256)}</td><td>${formatTime(item.updated_at_epoch)}</td></tr>`).join("")}</tbody></table>
    </div>`;
}

async function loadExamples() {
  if (!state.examples) state.examples = await api(`/api/examples?run_id=${encodeURIComponent(selectedRunId())}&split=evolution`);
  renderExamples();
}

function renderExamples() {
  const examples = state.examples?.examples || [];
  content.innerHTML = `
    <div class="toolbar">
      <input id="example-search" type="search" placeholder="Search prompt, response, key, or instruction">
      <select id="example-status"><option value="all">all outcomes</option><option value="failed">strict failures</option><option value="passed">strict passes</option></select>
      <select id="example-instruction"><option value="all">all instruction types</option>${[...new Set(examples.flatMap(item => item.instruction_ids))].sort().map(value => `<option>${escapeHtml(value)}</option>`).join("")}</select>
      <span class="muted">Held-out prompt text is intentionally unavailable.</span>
    </div>
    <div class="grid main-side">
      <div class="card flush"><table><thead><tr><th>key</th><th>outcome</th><th>prompt</th><th>latency</th><th>tokens</th></tr></thead><tbody id="example-body"></tbody></table></div>
      <div class="card"><div class="card-head"><h2>instruction slices</h2></div><div id="slice-list"></div></div>
    </div>`;
  const search = document.getElementById("example-search");
  const status = document.getElementById("example-status");
  const instruction = document.getElementById("example-instruction");
  const update = () => {
    const query = search.value.toLowerCase();
    const filtered = examples.filter(item => {
      const haystack = `${item.key} ${item.prompt} ${item.response} ${item.instruction_ids.join(" ")}`.toLowerCase();
      return (!query || haystack.includes(query))
        && (status.value === "all" || (status.value === "passed") === item.strict_pass)
        && (instruction.value === "all" || item.instruction_ids.includes(instruction.value));
    });
    document.getElementById("example-body").innerHTML = filtered.map(item => `<tr class="example-row" data-example="${item.position-1}"><td class="run-id">${escapeHtml(item.key)}</td><td>${statusBadge(item.strict_pass ? "complete" : "failed")}</td><td class="truncate">${escapeHtml(item.prompt)}</td><td>${Number(item.generation_seconds).toFixed(1)}s</td><td>${item.output_tokens}</td></tr>`).join("");
    document.querySelectorAll("[data-example]").forEach(row => row.addEventListener("click", () => openExample(examples[Number(row.dataset.example)])));
  };
  [search, status, instruction].forEach(control => control.addEventListener("input", update));
  update();
  document.getElementById("slice-list").innerHTML = (state.examples?.slices || []).map(slice => `<div class="progress-row" style="grid-template-columns:minmax(0,1fr) 70px"><span class="run-id">${escapeHtml(slice.instruction_id)}</span><strong>${formatPercent(slice.strict_accuracy)}</strong></div>`).join("");
}

function openExample(example) {
  const checks = example.instruction_ids.map((id, index) => `<span class="check-chip ${example.strict_checks[index] ? "pass" : ""}">${escapeHtml(id)}: ${example.strict_checks[index] ? "pass" : "fail"}</span>`).join("");
  document.getElementById("example-detail").innerHTML = `<p class="eyebrow">example ${escapeHtml(example.key)}</p><h2>${example.strict_pass ? "strict pass" : "strict failure"}</h2><div class="checks">${checks}</div><h3 class="section">prompt</h3><div class="response-block">${escapeHtml(example.prompt)}</div><h3 class="section">model response</h3><div class="response-block">${escapeHtml(example.response)}</div><div class="grid kpis section">${kpi("latency", `${Number(example.generation_seconds).toFixed(1)}s`)}${kpi("input tokens", example.input_tokens)}${kpi("output tokens", example.output_tokens)}${kpi("loose result", example.loose_pass ? "pass" : "fail")}</div>`;
  dialog.showModal();
}

function renderCompare() {
  const runs = state.overview?.runs || [];
  const options = runs.map(run => `<option value="${escapeHtml(run.run_id)}">${escapeHtml(run.run_id)}</option>`).join("");
  content.innerHTML = `<div class="card"><div class="card-head"><h2>run comparison</h2><span class="muted">configuration and instruction-slice deltas</span></div><div class="toolbar"><select id="compare-left">${options}</select><select id="compare-right">${options}</select><button class="button primary" id="compare-button" ${runs.length < 2 ? "disabled" : ""}>compare runs</button></div><div id="compare-results" class="empty">${runs.length < 2 ? "A second run is required for comparison." : "Select two runs."}</div></div>`;
  if (runs.length > 1) document.getElementById("compare-right").selectedIndex = 1;
  document.getElementById("compare-button").addEventListener("click", async () => {
    const left = document.getElementById("compare-left").value;
    const right = document.getElementById("compare-right").value;
    const result = await api(`/api/compare?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}&split=evolution`);
    document.getElementById("compare-results").innerHTML = `<div class="grid two"><div><h3>configuration changes</h3>${result.config_diff.length ? `<div class="kv">${result.config_diff.flatMap(item => [`<div>${escapeHtml(item.field)}</div>`, `<div>${escapeHtml(item.left)} → ${escapeHtml(item.right)}</div>`]).join("")}</div>` : `<p class="muted">No configuration changes.</p>`}</div><div><h3>instruction deltas</h3>${result.slices.map(item => `<div class="progress-row" style="grid-template-columns:minmax(0,1fr) 70px"><span class="run-id">${escapeHtml(item.instruction_id)}</span><strong class="${item.delta > 0 ? "metric-positive" : item.delta < 0 ? "metric-negative" : "metric-neutral"}">${item.delta == null ? "n/a" : `${item.delta >= 0 ? "+" : ""}${(item.delta*100).toFixed(1)} pp`}</strong></div>`).join("")}</div></div>`;
  });
}

function renderGate() {
  const run = state.selectedRun;
  const gate = run.gate || {};
  content.innerHTML = `<div class="grid main-side"><div class="card"><div class="card-head"><h2>a0 evidence checklist</h2>${statusBadge(gate.approved ? "approved" : gate.evidence_ready ? "ready" : "blocked")}</div><div class="checklist">${(gate.checks || []).map(check => `<div class="check ${check.passed ? "passed" : ""}"><span class="icon">${check.passed ? "✓" : "×"}</span><div><strong>${escapeHtml(check.label)}</strong><small>${check.id === "approval" ? "Only the project owner can open a1." : "Derived from frozen run artifacts."}</small></div></div>`).join("")}</div></div><div class="card"><h2>owner decision</h2><p class="muted">Approval is disabled until every scientific evidence check passes.</p><textarea id="gate-note" placeholder="Decision note"></textarea><div class="toolbar section"><button class="button primary" id="approve-gate" ${gate.evidence_ready ? "" : "disabled"}>approve a0 gate</button><button class="button danger" id="reject-gate">reject</button></div>${gate.decision?.recorded_at ? `<p class="muted">Recorded ${escapeHtml(gate.decision.recorded_at)}: ${escapeHtml(gate.decision.note || "No note")}</p>` : ""}</div></div>`;
  document.getElementById("approve-gate").addEventListener("click", () => recordGate("approved"));
  document.getElementById("reject-gate").addEventListener("click", () => recordGate("rejected"));
}

async function recordGate(decision) {
  try {
    const result = await api("/api/gate", {method: "POST", body: JSON.stringify({run_id: selectedRunId(), decision, note: document.getElementById("gate-note").value})});
    showBanner(result.message);
    await refresh();
  } catch (error) { showBanner(error.message, "error"); }
}

async function renderSystem() {
  const run = state.selectedRun;
  const control = state.overview?.control || {};
  const mlflow = await api("/api/mlflow");
  if (!state.logs) state.logs = await api("/api/logs");
  content.innerHTML = `<div class="grid two"><div class="card"><div class="card-head"><h2>runner control</h2>${statusBadge(control.alive ? "running" : control.status || "idle")}</div><div class="kv"><div>pid</div><div>${escapeHtml(control.pid || "none")}</div><div>run</div><div class="run-id">${escapeHtml(control.run_id || "none")}</div><div>split</div><div>${escapeHtml(control.split || "none")}</div><div>started</div><div>${escapeHtml(control.started_at || "not active")}</div><div>log</div><div>${escapeHtml(control.log_path || "none")}</div></div></div><div class="card"><div class="card-head"><h2>MLflow ledger</h2>${statusBadge(mlflow.database_exists ? "complete" : "not_started")}</div><div class="kv"><div>tracking URI</div><div class="run-id">${escapeHtml(mlflow.tracking_uri)}</div><div>run id</div><div class="run-id">${escapeHtml(run.mlflow?.run_id || "pending next runner start")}</div><div>UI</div><div><a href="${escapeHtml(mlflow.ui_url)}" target="_blank">${escapeHtml(mlflow.ui_url)}</a></div><div>launch command</div><div class="run-id">${escapeHtml(mlflow.ui_command)}</div></div></div></div><div class="card section"><div class="card-head"><h2>live runner log</h2><button class="button ghost" id="refresh-log">refresh log</button></div><pre class="log">${escapeHtml((state.logs.lines || []).join("\n") || "No runner log is active.")}</pre></div>`;
  document.getElementById("refresh-log").addEventListener("click", async () => { state.logs = await api("/api/logs"); renderSystem(); });
}

function signedPercent(value) {
  if (value == null) return "pending";
  const points = Number(value) * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)} pp`;
}

function renderA1() {
  const data = state.a1 || {};
  const config = data.config || {};
  const runs = data.runs || [];
  const run = runs[0];
  const control = data.control || {};
  const runningThisRun = Boolean(control.alive && control.phase === "a1");
  const search = config.search || {};
  const stateRecord = run?.state || {};
  const candidates = run?.candidates || [];
  const comparisons = run?.comparisons || {};
  const activity = run?.active_evaluation;
  const nextStage = run?.next_stage || "search";
  const actionLabel = runningThisRun
    ? `${control.stage} running`
    : run?.complete ? "start new a1 run" : `${run ? "resume" : "start"} ${nextStage}`;
  const comparisonCards = ["evolution", "validation", "heldout_test"].map(name => {
    const item = comparisons[name];
    return item
      ? kpi(name.replaceAll("_", " "), signedPercent(item.strict_prompt_delta), `${formatPercent(item.candidate_strict_prompt_accuracy)} winner · 95% CI ${signedPercent(item.strict_prompt_delta_ci95?.[0])} to ${signedPercent(item.strict_prompt_delta_ci95?.[1])}`)
      : kpi(name.replaceAll("_", " "), "pending", "paired against the approved a0 baseline");
  }).join("");
  content.innerHTML = `
    ${stateRecord.status === "failed" && !runningThisRun ? `<div class="banner error"><strong>A1 search stopped:</strong> ${escapeHtml(stateRecord.error || "The runner exited before completing the current candidate.")} The saved candidate ledger can be resumed.</div>` : ""}
    ${activity ? `<div class="card a1-live"><div class="card-head"><div><p class="eyebrow">current evaluation</p><h2>${escapeHtml(activity.candidate_id)} / ${escapeHtml(activity.stage)}</h2></div>${statusBadge(runningThisRun ? "running" : activity.status)}</div><div class="progress"><span style="width:${Math.min(activity.percent || 0, 100)}%"></span></div><div class="a1-progress-meta"><strong>${activity.completed || 0} / ${activity.total || 0} examples</strong><span>${(activity.percent || 0).toFixed(1)}%</span><span>strict ${formatPercent(activity.strict_prompt_accuracy)}</span><span>${(activity.examples_per_second || 0).toFixed(3)} ex/s</span><span>ETA ${formatDuration(activity.eta_seconds)}</span></div></div>` : ""}
    <div class="grid main-side">
      <div class="card">
        <div class="card-head"><div><p class="eyebrow">prompt-only recursive improvement</p><h2>a1 evolution protocol</h2></div>${statusBadge(run?.complete ? "complete" : runningThisRun ? "running" : run ? stateRecord.status || "ready" : "ready")}</div>
        <p class="muted">Three generations. Four children per generation. Only the system prompt may change. Validation and heldout results cannot select a candidate.</p>
        <div class="kv">
          <div>baseline</div><div class="run-id">${escapeHtml(config.experiment?.baseline_run_id || "a0")}</div>
          <div>primary metric</div><div>${escapeHtml(config.experiment?.primary_metric || "strict prompt accuracy")}</div>
          <div>screen panel</div><div>${escapeHtml(search.screen_examples || 0)} evolution examples</div>
          <div>confirmation panel</div><div>${escapeHtml(search.confirmation_examples || 0)} evolution examples</div>
          <div>acceptance rule</div><div>positive paired confirmation delta</div>
          <div>current incumbent</div><div class="run-id">${escapeHtml(stateRecord.incumbent_id || "a0-baseline")}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>run control</h2>${statusBadge(runningThisRun ? "running" : run?.complete ? "complete" : "ready")}</div>
        <p class="muted">A1 is resumable. Every candidate response, rejection, and acceptance is written before the next stage begins.</p>
        <button class="button primary" id="a1-start" ${runningThisRun ? "disabled" : ""}>${escapeHtml(actionLabel)}</button>
        ${run ? `<p class="run-id section">${escapeHtml(run.run_id)}</p>` : ""}
      </div>
    </div>
    <div class="grid kpis section">${comparisonCards}</div>
    <div class="grid two section">
      <div class="card flush">
        <div class="card-head" style="padding:16px;margin:0"><h2>candidate ledger</h2><span class="muted">${candidates.length} candidates recorded</span></div>
        <table><thead><tr><th>candidate</th><th>parent</th><th>generation</th><th>status</th><th>prompt words</th><th>evaluations</th></tr></thead><tbody>
          ${candidates.length ? candidates.map(candidate => { const latest = candidate.evaluations?.at(-1); return `<tr><td class="run-id">${escapeHtml(candidate.candidate_id)}</td><td class="run-id">${escapeHtml(candidate.parent_id || "root")}</td><td>${escapeHtml(candidate.generation)}</td><td>${statusBadge(candidate.status)}</td><td>${escapeHtml(candidate.prompt_words || 0)}</td><td>${latest ? `${escapeHtml(latest.stage)} · ${latest.completed || 0}/${latest.total || 0}` : "queued"}</td></tr>`; }).join("") : `<tr><td colspan="6" class="empty">Candidates appear when search starts.</td></tr>`}
        </tbody></table>
      </div>
      <div class="card">
        <div class="card-head"><h2>selection lineage</h2><span class="muted">immutable decisions</span></div>
        ${(run?.decisions || []).length ? run.decisions.map(item => `<div class="check ${item.accepted ? "passed" : ""}"><span class="icon">${item.accepted ? "✓" : "×"}</span><div><strong>generation ${item.generation}: ${escapeHtml(item.selected_candidate_id)}</strong><small>${signedPercent(item.strict_prompt_delta)} · ${escapeHtml(item.reason)}</small></div></div>`).join("") : `<div class="empty">No selection decisions yet.</div>`}
      </div>
    </div>`;
  document.getElementById("a1-start").addEventListener("click", async event => {
    event.currentTarget.disabled = true;
    try {
      const useExistingRun = run && !run.complete;
      const result = await api("/api/a1/start", {method:"POST", body:JSON.stringify({run_id:useExistingRun ? run.run_id : null, stage:useExistingRun ? nextStage : "search"})});
      showBanner(result.message);
      await refresh();
    } catch (error) { showBanner(error.message, "error"); event.currentTarget.disabled = false; }
  });
}

function bindNavigationButtons() {
  document.querySelectorAll("[data-nav]").forEach(button => button.addEventListener("click", () => { location.hash = button.dataset.nav; }));
}

async function render() {
  state.view = location.hash.slice(1) || "overview";
  // Direct navigation to an experiment-specific page updates the selector so
  // the header and subsequent overview remain in the same experiment context.
  if (state.view === "a1") state.scope = "a1";
  if (["runs", "run", "examples", "compare", "gate"].includes(state.view)) state.scope = "a0";
  localStorage.setItem("rrsi-experiment-scope", state.scope);
  const labels = {overview:"overview", runs:"run registry", run:"run detail", examples:"example browser", compare:"compare runs", gate:"a0 evidence gate", a1:"a1 prompt evolution", system:"system and logs"};
  title.textContent = labels[state.view] || state.view;
  updateChrome();
  if (state.view === "overview") renderOverview();
  else if (state.view === "runs") renderRuns();
  else if (state.view === "run") renderRunDetail();
  else if (state.view === "examples") await loadExamples();
  else if (state.view === "compare") renderCompare();
  else if (state.view === "gate") renderGate();
  else if (state.view === "a1") renderA1();
  else if (state.view === "system") await renderSystem();
  else { location.hash = "overview"; }
}

async function refresh() {
  try {
    state.overview = await api("/api/overview");
    state.a1 = await api("/api/a1");
    const currentId = state.selectedRun?.run_id || state.overview.runs?.[0]?.run_id;
    state.selectedRun = currentId ? await api(`/api/runs/${encodeURIComponent(currentId)}`) : null;
    state.examples = null;
    state.logs = null;
    await render();
  } catch (error) {
    content.innerHTML = `<div class="banner error">Could not load experiment state: ${escapeHtml(error.message)}</div>`;
  }
}

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  try {
    const split = nextRunnableSplit();
    if (!split) {
      showBanner("Every A0 split is already complete.");
      return;
    }
    const result = await api("/api/runs/start", {method:"POST", body:JSON.stringify({run_id:selectedRunId(), split})});
    showBanner(result.message);
    await refresh();
  } catch (error) { showBanner(error.message, "error"); }
  startButton.disabled = false;
});

stopButton.addEventListener("click", async () => {
  if (!confirm("Stop the active local A0 runner after its current operation? Saved responses will remain resumable.")) return;
  try {
    const result = await api("/api/runs/stop", {method:"POST", body:"{}"});
    showBanner(result.message);
    await refresh();
  } catch (error) { showBanner(error.message, "error"); }
});

refreshButton.addEventListener("click", refresh);
experimentSelect.addEventListener("change", async event => {
  state.scope = event.target.value;
  localStorage.setItem("rrsi-experiment-scope", state.scope);
  location.hash = "overview";
  await refresh();
});
window.addEventListener("hashchange", render);
dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
setInterval(async () => {
  if (["overview", "run", "a1", "system"].includes(state.view)) await refresh();
}, 5000);
refresh();

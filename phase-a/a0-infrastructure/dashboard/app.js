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
  a1Stage: null,
  a1RunId: null,
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
const stageHelpDialog = document.getElementById("stage-help-dialog");
const stageHelpContent = document.getElementById("stage-help-content");
const runComparisonLayer = document.getElementById("run-comparison-layer");
const runComparisonContent = document.getElementById("run-comparison-content");

const A1_STAGE_HELP = {
  search: {
    title: "Search: create and select prompt changes",
    purpose: "Search is the only stage allowed to change the system prompt. It asks whether a prompt-only mutation can make the frozen Qwen model follow more instructions.",
    process: "Each generation creates four candidate prompts. All four run on the same 32-example screen. The two highest strict prompt scores advance to a paired 96-example confirmation round. A candidate becomes the next parent only when it beats the current parent on that confirmation panel.",
    data: "Search uses only the evolution split. It cannot read validation or heldout results. Model weights, the dataset, generation settings, and the IFEval verifier remain frozen.",
    metric: "Strict prompt accuracy is the selection metric. An example passes only when every instruction in that prompt passes. A positive confirmation difference is required for adoption.",
    visual: "The generation graph shows whether the best confirmed candidate moved above or below its parent. Candidate tables preserve every attempted mutation, including ideas stopped after screening.",
  },
  evolution: {
    title: "Evolution evaluation: measure the frozen winner on development data",
    purpose: "This stage measures the prompt selected by search across the complete evolution split and compares it with the approved A0 baseline.",
    process: "The winner and baseline are evaluated under the same model, settings, examples, and deterministic verifier. No prompt can be selected or modified here.",
    data: "The evolution split was available to search, so this result describes performance on development data. It does not establish generalization by itself.",
    metric: "The graph compares strict prompt accuracy for the baseline and selected prompt. The reported change is selected prompt accuracy minus baseline accuracy.",
    visual: "Higher selected-prompt bars indicate improvement. Equal bars indicate no change. If search retained the baseline, both bars represent the same prompt and a zero difference is expected.",
  },
  validation: {
    title: "Validation: test generalization without changing the prompt",
    purpose: "Validation asks whether the frozen search result transfers to examples that were not available for candidate selection.",
    process: "The baseline and selected prompt run on the validation split with identical model settings and the official verifier. The result is recorded, but it cannot change the selected prompt.",
    data: "Validation examples are excluded from search and confirmation decisions. This separation reduces the risk of mistaking evolution-set overfitting for a real improvement.",
    metric: "The primary result is the paired strict prompt accuracy difference. Positive means the selected prompt passed more complete examples, negative means it passed fewer, and zero means no measured difference.",
    visual: "The live chart moves as checkpoints are scored. The final bar chart compares baseline and selected prompt after every validation example is verified.",
  },
  heldout_test: {
    title: "Heldout test: final sealed evaluation",
    purpose: "The heldout test provides the final estimate of how the frozen result performs on untouched examples.",
    process: "It runs only after search, evolution evaluation, and validation are complete. Neither the prompt nor the acceptance decision may change after seeing this result.",
    data: "Heldout examples remain sealed from development views and selection logic until this stage begins. This protects the final result from iterative tuning.",
    metric: "The final report compares paired strict prompt accuracy for the baseline and selected prompt, with the difference reported in percentage points.",
    visual: "The final bars are the experiment's strongest generalization evidence. Equal bars mean no measured improvement. A positive selected-prompt difference supports transfer, while a negative difference indicates regression.",
  },
};

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

function statusBadge(status, label = status) {
  // The stored status remains the CSS and machine-readable state, while an
  // optional label lets the interface explain that state in ordinary words.
  return `<span class="status ${escapeHtml(status)}">${escapeHtml(label || "unknown")}</span>`;
}

function showBanner(message, kind = "success") {
  banner.textContent = message;
  banner.className = `banner ${kind}`;
  setTimeout(() => { banner.className = "banner hidden"; }, 6500);
}

function openStageHelp(stage) {
  const help = A1_STAGE_HELP[stage];
  if (!help) return;
  stageHelpContent.innerHTML = `<p class="eyebrow">A1 stage guide</p><h2>${escapeHtml(help.title)}</h2><section><h3>What this stage asks</h3><p>${escapeHtml(help.purpose)}</p></section><section><h3>How it works</h3><p>${escapeHtml(help.process)}</p></section><section><h3>What data it can use</h3><p>${escapeHtml(help.data)}</p></section><section><h3>How success is measured</h3><p>${escapeHtml(help.metric)}</p></section><section><h3>How to read the visuals</h3><p>${escapeHtml(help.visual)}</p></section>`;
  stageHelpDialog.showModal();
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

function generationProgressChart(history, baselineScore) {
  // This chart keeps the baseline and every generation on one stable axis so
  // the viewer can see the search trajectory without reading the detail table.
  const usable = (history || []).filter(item => item.candidateScore != null);
  if (baselineScore == null || !usable.length) return `<div class="chart-empty">Generation results will appear here after confirmation begins.</div>`;
  const width = 760, height = 260, left = 55, right = 22, top = 25, bottom = 48;
  const values = [Number(baselineScore), ...usable.map(item => Number(item.candidateScore))];
  const lower = Math.max(0, Math.floor((Math.min(...values) - .05) * 20) / 20);
  const upper = Math.min(1, Math.ceil((Math.max(...values) + .05) * 20) / 20);
  const span = Math.max(upper - lower, .1);
  const points = [{label: "baseline", score: Number(baselineScore), provisional: false, delta: 0}, ...usable.map(item => ({
    label: `generation ${item.generation}`,
    score: Number(item.candidateScore),
    provisional: item.provisional,
    delta: item.delta,
  }))];
  const x = index => left + index / Math.max(points.length - 1, 1) * (width - left - right);
  const y = value => top + (upper - value) / span * (height - top - bottom);
  const confirmedPoints = points.filter(point => !point.provisional);
  const confirmedPath = confirmedPoints.map(point => {
    const index = points.indexOf(point);
    return `${confirmedPoints.indexOf(point) ? "L" : "M"}${x(index).toFixed(1)},${y(point.score).toFixed(1)}`;
  }).join(" ");
  const lastConfirmedIndex = points.findLastIndex(point => !point.provisional);
  const provisional = points.find(point => point.provisional);
  const provisionalPath = provisional
    ? `M${x(lastConfirmedIndex).toFixed(1)},${y(points[lastConfirmedIndex].score).toFixed(1)} L${x(points.indexOf(provisional)).toFixed(1)},${y(provisional.score).toFixed(1)}`
    : "";
  const ticks = [lower, lower + span / 2, upper].map(value => `<g><line x1="${left}" y1="${y(value)}" x2="${width-right}" y2="${y(value)}" stroke="#e6e8ec"/><text x="8" y="${y(value) + 4}" fill="#6d7179" font-size="11">${(value * 100).toFixed(0)}%</text></g>`).join("");
  const marks = points.map((point, index) => {
    const color = point.provisional ? "#d07a16" : point.delta > 0 ? "#16855b" : point.delta < 0 ? "#b33a45" : "#1877f2";
    return `<g><circle cx="${x(index)}" cy="${y(point.score)}" r="6" fill="${color}"/><text x="${x(index)}" y="${y(point.score) - 13}" text-anchor="middle" fill="${color}" font-size="12" font-weight="700">${(point.score * 100).toFixed(1)}%${point.provisional ? " live" : ""}</text><text x="${x(index)}" y="${height - 17}" text-anchor="middle" fill="#555b66" font-size="11">${escapeHtml(point.label)}</text></g>`;
  }).join("");
  return `<svg class="generation-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Strict prompt accuracy across generations">
    ${ticks}
    <line x1="${left}" y1="${y(baselineScore)}" x2="${width-right}" y2="${y(baselineScore)}" stroke="#1877f2" stroke-width="1.5" stroke-dasharray="6 5"/>
    <path d="${confirmedPath}" fill="none" stroke="#1877f2" stroke-width="3"/>
    ${provisionalPath ? `<path d="${provisionalPath}" fill="none" stroke="#d07a16" stroke-width="3" stroke-dasharray="7 5"/>` : ""}
    ${marks}
  </svg>`;
}

function splitComparisonChart(comparisons) {
  const names = ["evolution", "validation", "heldout_test"];
  const rows = names.filter(name => comparisons?.[name]).map(name => ({name, ...comparisons[name]}));
  if (!rows.length) return `<div class="chart-empty">Final split comparisons will appear here.</div>`;
  const width = 760, height = 245, left = 55, right = 20, top = 22, bottom = 48;
  const y = value => top + (1 - Number(value || 0)) * (height - top - bottom);
  const groupWidth = (width - left - right) / rows.length;
  const grid = [0, .25, .5, .75, 1].map(value => `<g><line x1="${left}" y1="${y(value)}" x2="${width-right}" y2="${y(value)}" stroke="#e6e8ec"/><text x="13" y="${y(value)+4}" fill="#6d7179" font-size="10">${value*100}%</text></g>`).join("");
  const groups = rows.map((row, index) => {
    const center = left + groupWidth * index + groupWidth / 2;
    const baseline = Number(row.baseline_strict_prompt_accuracy || 0);
    const candidate = Number(row.candidate_strict_prompt_accuracy || 0);
    const barWidth = Math.min(42, groupWidth / 4);
    return `<g><rect x="${center-barWidth-3}" y="${y(baseline)}" width="${barWidth}" height="${y(0)-y(baseline)}" fill="#8ca8c7"/><rect x="${center+3}" y="${y(candidate)}" width="${barWidth}" height="${y(0)-y(candidate)}" fill="#1877f2"/><text x="${center-barWidth/2-3}" y="${y(baseline)-7}" text-anchor="middle" fill="#52657a" font-size="11">${(baseline*100).toFixed(1)}%</text><text x="${center+barWidth/2+3}" y="${y(candidate)-7}" text-anchor="middle" fill="#1456a0" font-size="11">${(candidate*100).toFixed(1)}%</text><text x="${center}" y="${height-18}" text-anchor="middle" fill="#555b66" font-size="11">${escapeHtml(row.name.replaceAll("_", " "))}</text></g>`;
  }).join("");
  return `<svg class="split-comparison-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Baseline and selected prompt accuracy by evaluation split">${grid}${groups}<text x="${width-190}" y="14" fill="#52657a" font-size="10">■ baseline</text><text x="${width-105}" y="14" fill="#1456a0" font-size="10">■ selected prompt</text></svg>`;
}

function stageMetricChart(baseline, selected) {
  const metrics = [
    {label: "strict prompt", key: "strict_prompt_accuracy"},
    {label: "strict instruction", key: "strict_instruction_accuracy"},
    {label: "loose prompt", key: "loose_prompt_accuracy"},
  ];
  if (!baseline || !selected) return `<div class="chart-empty">Metric breakdown is not available for this stage.</div>`;
  const width = 760, height = 265, left = 55, right = 20, top = 25, bottom = 52;
  const y = value => top + (1 - Number(value || 0)) * (height - top - bottom);
  const groupWidth = (width - left - right) / metrics.length;
  const grid = [0, .25, .5, .75, 1].map(value => `<g><line x1="${left}" y1="${y(value)}" x2="${width-right}" y2="${y(value)}" stroke="#e6e8ec"/><text x="13" y="${y(value)+4}" fill="#6d7179" font-size="10">${value*100}%</text></g>`).join("");
  const groups = metrics.map((metric, index) => {
    const center = left + groupWidth * index + groupWidth / 2;
    const baselineValue = Number(baseline[metric.key] || 0);
    const selectedValue = Number(selected[metric.key] || 0);
    const barWidth = Math.min(48, groupWidth / 4);
    return `<g><rect x="${center-barWidth-4}" y="${y(baselineValue)}" width="${barWidth}" height="${y(0)-y(baselineValue)}" fill="#8ca8c7"/><rect x="${center+4}" y="${y(selectedValue)}" width="${barWidth}" height="${y(0)-y(selectedValue)}" fill="#1877f2"/><text x="${center-barWidth/2-4}" y="${y(baselineValue)-7}" text-anchor="middle" fill="#52657a" font-size="11">${(baselineValue*100).toFixed(1)}%</text><text x="${center+barWidth/2+4}" y="${y(selectedValue)-7}" text-anchor="middle" fill="#1456a0" font-size="11">${(selectedValue*100).toFixed(1)}%</text><text x="${center}" y="${height-20}" text-anchor="middle" fill="#555b66" font-size="11">${escapeHtml(metric.label)}</text></g>`;
  }).join("");
  return `<svg class="stage-metric-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Stage metric breakdown for baseline and selected prompt">${grid}${groups}<text x="${width-190}" y="14" fill="#52657a" font-size="10">■ baseline</text><text x="${width-105}" y="14" fill="#1456a0" font-size="10">■ selected prompt</text></svg>`;
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

function a1ExampleEvidence(example) {
  // A running evaluation has generated responses before the official verifier
  // writes its result files. Represent that state directly instead of treating
  // an absent result as a failure.
  const checks = example.instruction_ids.length
    ? example.instruction_ids.map((id, index) => `<span class="check-chip ${example.strict_checks[index] ? "pass" : ""}">${escapeHtml(id)}: ${example.strict_checks[index] ? "pass" : "fail"}</span>`).join("")
    : `<span class="muted">Verifier result pending for this response.</span>`;
  const outcome = example.strict_pass == null ? "validation pending" : example.strict_pass ? "strict pass" : "strict failure";
  return `<p class="eyebrow">example ${escapeHtml(example.key)}</p><h2>${outcome}</h2><div class="checks">${checks}</div><h3 class="section">user prompt</h3><div class="response-block">${escapeHtml(example.prompt)}</div><h3 class="section">model response</h3><div class="response-block">${escapeHtml(example.response)}</div><div class="grid kpis section">${kpi("latency", example.generation_seconds == null ? "pending" : `${Number(example.generation_seconds).toFixed(1)}s`)}${kpi("input tokens", example.input_tokens ?? "pending")}${kpi("output tokens", example.output_tokens ?? "pending")}${kpi("loose result", example.loose_pass == null ? "pending" : example.loose_pass ? "pass" : "fail")}</div>`;
}

async function openA1Candidate(runId, candidateId, stage) {
  dialog.querySelector("#example-detail").innerHTML = `<div class="loading">loading candidate evidence…</div>`;
  dialog.showModal();
  try {
    const detail = await api(`/api/a1/candidate?run_id=${encodeURIComponent(runId)}&candidate_id=${encodeURIComponent(candidateId)}&stage=${encodeURIComponent(stage)}`);
    const candidate = detail.candidate || {};
    if (detail.sealed) {
      dialog.querySelector("#example-detail").innerHTML = `<p class="eyebrow">${escapeHtml(candidateId)} · ${escapeHtml(stage)}</p><h2>held-out evidence is sealed</h2><p class="muted">Only aggregate held-out metrics are exposed. Prompt text and model responses remain unavailable to prompt development.</p>`;
      return;
    }
    const examples = detail.examples || [];
    const strict = detail.metrics?.strict || {};
    dialog.querySelector("#example-detail").innerHTML = `
      <p class="eyebrow">candidate drilldown · ${escapeHtml(stage)}</p>
      <h2>${escapeHtml(candidate.candidate_id)}</h2>
      <div class="grid kpis section">
        ${kpi("strict prompt", formatPercent(strict.prompt_accuracy), `${examples.length} responses available`)}
        ${kpi("mutation", (candidate.operators || []).join(", ") || "baseline", `${candidate.added_words || 0} words added`)}
        ${kpi("validator", "deterministic", "official IFEval checks")}
        ${kpi("written advice", "none", "pass or fail signals only")}
      </div>
      <div class="banner info section"><strong>What produced this candidate:</strong> ${escapeHtml(detail.proposal?.rationale || "This is the frozen baseline prompt.")} ${detail.proposal?.uses_validator_feedback ? "Validator feedback was used." : "This mutation was predefined and did not use validator feedback."}</div>
      <h3 class="section">candidate system prompt</h3><div class="response-block">${escapeHtml(candidate.prompt || "")}</div>
      <h3 class="section">change from parent</h3><div class="response-block diff-block">${escapeHtml(candidate.diff || "No prompt change. This is the baseline.")}</div>
      <div class="card-head section"><h3>individual responses and checks</h3><span class="muted">select an example to inspect the exact verifier target</span></div>
      <div class="candidate-example-list">${examples.length ? examples.map((example, index) => `<button class="candidate-example ${example.strict_pass === true ? "passed" : example.strict_pass === false ? "failed" : "pending"}" data-a1-example="${index}"><span class="run-id">${escapeHtml(example.key)}</span><span>${example.strict_pass == null ? "validator pending" : example.strict_pass ? "strict pass" : "strict failure"}</span></button>`).join("") : `<div class="empty">No responses have been generated for this stage yet.</div>`}</div>
      <div id="a1-example-evidence" class="section">${examples.length ? a1ExampleEvidence(examples[0]) : ""}</div>`;
    dialog.querySelectorAll("[data-a1-example]").forEach(button => button.addEventListener("click", () => {
      dialog.querySelector("#a1-example-evidence").innerHTML = a1ExampleEvidence(examples[Number(button.dataset.a1Example)]);
    }));
  } catch (error) {
    dialog.querySelector("#example-detail").innerHTML = `<div class="banner error">Could not load candidate evidence: ${escapeHtml(error.message)}</div>`;
  }
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


/* Build a cross-run chart from recorded results. Missing stages stay hollow
 * rather than becoming zero, which would falsely imply a completed result. */
function runComparisonChart(runs) {
  const stages = ["evolution", "validation", "heldout_test"];
  const width = 760, height = 260, left = 55, right = 24, top = 30, bottom = 48;
  const innerWidth = width - left - right, innerHeight = height - top - bottom;
  const values = runs.flatMap(run => stages.map(stage => run.comparisons?.[stage]?.strict_prompt_delta).filter(value => value != null));
  const largest = Math.max(0.05, ...values.map(value => Math.abs(Number(value))));
  const limit = Math.ceil(largest * 100 / 5) * 5 / 100;
  const y = value => top + ((limit - value) / (limit * 2)) * innerHeight;
  const x = index => left + (index / Math.max(stages.length - 1, 1)) * innerWidth;
  const zero = y(0);
  const grid = [-limit, 0, limit].map(value => `<g><line x1="${left}" y1="${y(value)}" x2="${width-right}" y2="${y(value)}" stroke="${value === 0 ? "#a9adb5" : "#e8e8ef"}"/><text x="${left-9}" y="${y(value)+4}" text-anchor="end" fill="#686572" font-size="10">${value > 0 ? "+" : ""}${(value*100).toFixed(0)} pp</text></g>`).join("");
  const colors = ["#1456a0", "#16855b", "#d97706", "#c93c48", "#6d4bc3"];
  const series = runs.map((run, runIndex) => {
    const points = stages.map((stage, stageIndex) => {
      const value = run.comparisons?.[stage]?.strict_prompt_delta;
      return value == null ? null : {x:x(stageIndex), y:y(Number(value)), value:Number(value)};
    });
    const linePoints = points.filter(Boolean).map(point => `${point.x},${point.y}`).join(" ");
    const line = points.filter(Boolean).length > 1 ? `<polyline points="${linePoints}" fill="none" stroke="${colors[runIndex % colors.length]}" stroke-width="3"/>` : "";
    const markers = points.map((point, index) => point
      ? `<circle cx="${point.x}" cy="${point.y}" r="5" fill="${colors[runIndex % colors.length]}"><title>${escapeHtml(run.run_id)}: ${(point.value*100).toFixed(1)} pp</title></circle>`
      : `<circle cx="${x(index)}" cy="${zero}" r="4" fill="#fff" stroke="#c8c8d2" stroke-width="2"><title>${escapeHtml(run.run_id)}: pending</title></circle>`).join("");
    return line + markers;
  }).join("");
  const labels = stages.map((stage, index) => `<text x="${x(index)}" y="${height-18}" text-anchor="middle" fill="#4f4c57" font-size="11">${stage.replaceAll("_", " ")}</text>`).join("");
  const legend = runs.map((run, index) => `<span><i style="background:${colors[index % colors.length]}"></i>${escapeHtml(run.proposer || "deterministic")} · ${escapeHtml(run.run_id)}</span>`).join("");
  return `<div class="comparison-chart-legend">${legend}</div><svg class="run-comparison-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Strict prompt accuracy change across runs and evaluation stages">${grid}${series}${labels}</svg>`;
}

function renderRunComparisonDrawer(runs, selectedRunId, selectedStage) {
  const completedStages = runs.reduce((total, run) => total + ["evolution", "validation", "heldout_test"].filter(stage => run.comparisons?.[stage]).length, 0);
  const acceptedTotal = runs.reduce((total, run) => total + (run.decisions || []).filter(decision => decision.accepted).length, 0);
  runComparisonContent.innerHTML = `<div class="drawer-header"><div><p class="eyebrow">experiment history</p><h2 id="run-comparison-title">A1 run comparison</h2><p>See whether repeated runs are producing measurable progress. Select any row to load its full stage evidence in the main view.</p></div><button class="drawer-close" id="run-comparison-close" aria-label="Close run comparison">×</button></div><div class="comparison-summary"><div><strong>${runs.length}</strong><span>runs preserved</span></div><div><strong>${acceptedTotal}</strong><span>prompt changes accepted</span></div><div><strong>${completedStages}</strong><span>final evaluations complete</span></div></div><section class="drawer-section"><div class="drawer-section-head"><div><h3>performance across runs</h3><p>Strict prompt accuracy change from the approved A0 baseline</p></div></div>${runComparisonChart(runs)}</section><section class="drawer-section"><div class="drawer-section-head"><div><h3>run evidence</h3><p>Pending means that run has not reached that evaluation stage.</p></div></div><div class="run-history-grid drawer-run-table"><div class="run-history-row run-history-head"><span>run</span><span>proposer</span><span>search</span><span>accepted</span><span>evolution</span><span>validation</span><span>heldout</span></div>${runs.map(item => { const decisions = item.decisions || []; const accepted = decisions.filter(decision => decision.accepted).length; const record = item.state || {}; return `<button class="run-history-row ${item.run_id === selectedRunId ? "active" : ""}" data-a1-run="${escapeHtml(item.run_id)}"><span class="run-id">${escapeHtml(item.run_id)}</span><strong>${escapeHtml(item.proposer || "deterministic")}</strong><span>${record.status || "not started"}</span><span>${accepted}</span><span>${item.comparisons?.evolution ? signedPercent(item.comparisons.evolution.strict_prompt_delta) : "pending"}</span><span>${item.comparisons?.validation ? signedPercent(item.comparisons.validation.strict_prompt_delta) : "pending"}</span><span>${item.comparisons?.heldout_test ? signedPercent(item.comparisons.heldout_test.strict_prompt_delta) : "pending"}</span></button>`; }).join("")}</div></section>`;
  document.getElementById("run-comparison-close").addEventListener("click", closeRunComparisonDrawer);
  runComparisonContent.querySelectorAll("[data-a1-run]").forEach(button => button.addEventListener("click", () => {
    closeRunComparisonDrawer();
    location.hash = `a1/${selectedStage}/${button.dataset.a1Run}`;
  }));
}

function openRunComparisonDrawer() {
  runComparisonLayer.classList.add("open");
  runComparisonLayer.setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
  document.getElementById("run-comparison-close")?.focus();
}

function closeRunComparisonDrawer() {
  runComparisonLayer.classList.remove("open");
  runComparisonLayer.setAttribute("aria-hidden", "true");
  document.body.classList.remove("drawer-open");
}


/* Keep every screen candidate visible while the generation advances. The live
 * candidate is explicitly marked partial and completed candidates retain their
 * final score, so the current panel never erases earlier evidence. */
function generationScreenChart(records, parentScore, activeCandidateId) {
  const width = 820, height = 250, left = 145, right = 82, top = 24, rowHeight = 48;
  const chartWidth = width - left - right;
  const x = value => left + Math.max(0, Math.min(1, Number(value || 0))) * chartWidth;
  const parentX = x(parentScore);
  const rows = records.map((record, index) => {
    const candidate = record.candidate;
    const evaluation = record.evaluation;
    const cy = top + index * rowHeight + 15;
    const score = evaluation?.strict_prompt_accuracy;
    const complete = evaluation?.status === "complete";
    const active = candidate.candidate_id === activeCandidateId;
    const stateLabel = complete ? "final" : active ? "live" : evaluation ? "partial" : "still to run";
    const bar = score == null
      ? `<line x1="${left}" y1="${cy}" x2="${width-right}" y2="${cy}" stroke="#ececf1" stroke-width="12"/>`
      : `<line x1="${left}" y1="${cy}" x2="${x(score)}" y2="${cy}" stroke="${complete ? "#1456a0" : "#d97706"}" stroke-width="12"/><circle cx="${x(score)}" cy="${cy}" r="5" fill="${complete ? "#1456a0" : "#d97706"}"/>`;
    const valueLabel = score == null ? stateLabel : `${formatPercent(score)} · ${stateLabel}`;
    return `<g><text x="${left-12}" y="${cy+4}" text-anchor="end" fill="#3f3c46" font-size="12" font-weight="650">${escapeHtml(candidate.candidate_id)}</text>${bar}<text x="${width-right+10}" y="${cy+4}" fill="${complete ? "#1456a0" : active ? "#a66b08" : "#686572"}" font-size="11">${escapeHtml(valueLabel)}</text></g>`;
  }).join("");
  return `<svg class="generation-screen-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="All generation screening candidate scores"><line x1="${parentX}" y1="${top-10}" x2="${parentX}" y2="${top + records.length*rowHeight-15}" stroke="#16855b" stroke-width="2" stroke-dasharray="5 5"/><text x="${parentX}" y="${height-14}" text-anchor="middle" fill="#16855b" font-size="10">parent ${formatPercent(parentScore)}</text>${rows}</svg>`;
}

function renderA1() {
  const data = state.a1 || {};
  const config = data.config || {};
  const runs = data.runs || [];
  const run = runs.find(item => item.run_id === state.a1RunId) || runs[0];
  const control = data.control || {};
  const proposerStatus = data.proposers || {};
  const runProposer = run?.proposer || "deterministic";
  const runningThisRun = Boolean(control.alive && control.phase === "a1" && control.run_id === run?.run_id);
  const anyA1Running = Boolean(control.alive && control.phase === "a1");
  const search = config.search || {};
  const stateRecord = run?.state || {};
  const candidates = run?.candidates || [];
  const comparisons = run?.comparisons || {};
  // Preserve the most recent candidate evaluation between runner checkpoints.
  // The runner briefly has no active evaluation after one candidate completes
  // and before the next candidate writes its first checkpoint. Keeping the
  // latest evaluation here prevents the graphs from disappearing in that gap.
  const activity = run?.active_evaluation || run?.latest_evaluation;
  const evaluationInProgress = run?.active_evaluation != null;
  const nextStage = run?.next_stage || "search";
  const finalSplit = activity?.stage?.match(/^final-(evolution|validation|heldout_test)$/)?.[1] || null;
  const activeCandidate = activity ? candidates.find(candidate => candidate.candidate_id === activity.candidate_id) : null;
  // The evaluation stage identifies the search generation. The active parent
  // may have been created in an earlier generation, so its own generation
  // number would make the dashboard appear to move backwards during retesting.
  const activeGeneration = Number(activity?.stage?.match(/^g(\d+)/)?.[1] || stateRecord.completed_generations?.length + 1 || 1);
  const candidatePosition = Number(activity?.candidate_id?.match(/c(\d+)$/)?.[1] || 0);
  const measuringParent = activity?.candidate_id === (stateRecord.incumbent_id || "a0-baseline");
  const stageLabel = activity?.stage?.includes("confirmation")
    ? "confirmation"
    : activity?.stage?.includes("screen") ? "screening" : activity?.stage?.includes("final") ? "full evaluation" : "evaluation";
  const actionLabel = runningThisRun
    ? `${control.stage} running`
    : run?.complete ? proposerStatus.deepseek?.configured ? "start deepseek a1 run" : "deepseek key required" : `${run ? "resume" : "start"} ${nextStage}`;
  const comparisonCards = ["evolution", "validation", "heldout_test"].map(name => {
    const item = comparisons[name];
    return item
      ? kpi(name.replaceAll("_", " "), signedPercent(item.strict_prompt_delta), `${formatPercent(item.candidate_strict_prompt_accuracy)} winner · 95% CI ${signedPercent(item.strict_prompt_delta_ci95?.[0])} to ${signedPercent(item.strict_prompt_delta_ci95?.[1])}`)
      : kpi(name.replaceAll("_", " "), "pending", "paired against the approved a0 baseline");
  }).join("");
  const generationCandidates = candidates
    .filter(candidate => candidate.generation === activeGeneration)
    .map(candidate => ({candidate, evaluation: [...(candidate.evaluations || [])].reverse().find(item => item.stage === activity?.stage)}))
    .sort((left, right) => left.candidate.candidate_id.localeCompare(right.candidate.candidate_id));
  const completedDecisions = run?.decisions || [];
  // Candidate files use a single `rejected` state after a generation closes.
  // That state is correct for the search runner, but it hides two materially
  // different scientific outcomes from a person reading the dashboard:
  // candidates either stopped at the small screen or reached confirmation and
  // failed to beat their parent. Build explicit, plain-language outcomes here.
  const decisionsByGeneration = new Map(completedDecisions.map(decision => [Number(decision.generation), decision]));
  const candidatesById = new Map(candidates.map(candidate => [candidate.candidate_id, candidate]));
  const ledgerOutcome = candidate => {
    if (candidate.generation === 0) {
      return {
        label: "current parent",
        status: "baseline",
        reason: completedDecisions.length
          ? `Retained after ${completedDecisions.length} completed generation${completedDecisions.length === 1 ? "" : "s"}.`
          : "This is the prompt every candidate must beat.",
      };
    }

    const decision = decisionsByGeneration.get(Number(candidate.generation));
    const screenStage = `g${String(candidate.generation).padStart(2, "0")}-screen`;
    const confirmationStage = `g${String(candidate.generation).padStart(2, "0")}-confirmation`;
    const screen = (candidate.evaluations || []).find(item => item.stage === screenStage);

    if (!decision) {
      const isActive = activity?.candidate_id === candidate.candidate_id && evaluationInProgress;
      if (isActive) return {label: "testing now", status: "running", reason: `${activity.scored_examples || 0} of ${activity.total || 0} examples scored so far.`};
      if (screen?.status === "complete") return {label: "screen complete", status: "proposed", reason: `${formatPercent(screen.strict_prompt_accuracy)} on 32 examples. Waiting for all four candidates before the top two advance.`};
      return {label: "waiting", status: "proposed", reason: "This candidate has not completed its 32 example screen."};
    }

    if (!(decision.screen_finalists || []).includes(candidate.candidate_id)) {
      return {
        label: "stopped after screen",
        status: "screened-out",
        reason: `Scored ${formatPercent(screen?.strict_prompt_accuracy)} on 32 examples and did not place in the generation's top two.`,
      };
    }

    const confirmation = (candidate.evaluations || []).find(item => item.stage === confirmationStage);
    const parent = candidatesById.get(candidate.parent_id);
    const parentConfirmation = (parent?.evaluations || []).find(item => item.stage === confirmationStage);
    const delta = confirmation?.strict_prompt_accuracy != null && parentConfirmation?.strict_prompt_accuracy != null
      ? confirmation.strict_prompt_accuracy - parentConfirmation.strict_prompt_accuracy
      : null;
    const scoreExplanation = confirmation && parentConfirmation
      ? `Scored ${formatPercent(confirmation.strict_prompt_accuracy)} versus the parent's ${formatPercent(parentConfirmation.strict_prompt_accuracy)} on the same 96 examples${delta == null ? "" : ` (${signedPercent(delta)})`}.`
      : "Reached the 96 example confirmation round.";

    if (decision.accepted && decision.selected_candidate_id === candidate.candidate_id) {
      return {label: "adopted", status: "accepted", reason: `${scoreExplanation} It becomes the next generation's parent.`};
    }
    return {
      label: "not adopted",
      status: "rejected",
      reason: `${scoreExplanation} ${decision.selected_candidate_id === candidate.candidate_id ? "This was the strongest finalist, but it did not beat the parent." : "Another finalist scored higher, and neither replaced the parent."}`,
    };
  };
  const explainDecision = decision => {
    const selected = candidatesById.get(decision.selected_candidate_id);
    const parent = candidatesById.get(decision.parent_id);
    const stage = `g${String(decision.generation).padStart(2, "0")}-confirmation`;
    const selectedResult = (selected?.evaluations || []).find(item => item.stage === stage);
    const parentResult = (parent?.evaluations || []).find(item => item.stage === stage);
    if (!selectedResult || !parentResult) return decision.reason;
    return `${decision.selected_candidate_id} was the strongest finalist at ${formatPercent(selectedResult.strict_prompt_accuracy)}. The parent scored ${formatPercent(parentResult.strict_prompt_accuracy)}, so ${decision.accepted ? "the candidate became the new parent" : "the existing parent was kept"}.`;
  };
  // Keep one durable row for every generation. The live candidate is appended
  // as provisional evidence, rather than replacing the completed history.
  const generationHistory = completedDecisions.map(decision => {
    const selected = candidatesById.get(decision.selected_candidate_id);
    const parent = candidatesById.get(decision.parent_id);
    const stage = `g${String(decision.generation).padStart(2, "0")}-confirmation`;
    const selectedResult = (selected?.evaluations || []).find(item => item.stage === stage);
    const parentResult = (parent?.evaluations || []).find(item => item.stage === stage);
    return {
      generation: Number(decision.generation),
      candidateId: decision.selected_candidate_id,
      candidateScore: selectedResult?.strict_prompt_accuracy,
      parentScore: parentResult?.strict_prompt_accuracy,
      delta: decision.strict_prompt_delta,
      outcome: decision.accepted ? "new prompt adopted" : "parent kept",
      provisional: false,
    };
  });
  if (stageLabel === "confirmation" && !measuringParent && activity && !decisionsByGeneration.has(activeGeneration)) {
    const historyParent = candidatesById.get(stateRecord.incumbent_id || "a0-baseline");
    const historyParentEvaluation = (historyParent?.evaluations || []).find(item => item.stage === activity.stage);
    const historyDelta = activity.strict_prompt_accuracy != null && historyParentEvaluation?.strict_prompt_accuracy != null
      ? activity.strict_prompt_accuracy - historyParentEvaluation.strict_prompt_accuracy
      : null;
    generationHistory.push({
      generation: activeGeneration,
      candidateId: activity.candidate_id,
      candidateScore: activity.strict_prompt_accuracy,
      parentScore: historyParentEvaluation?.strict_prompt_accuracy,
      delta: historyDelta,
      outcome: "still being measured",
      provisional: true,
    });
  }
  const confirmationCandidates = candidates.flatMap(candidate => (candidate.evaluations || [])
    .filter(item => item.stage?.includes("confirmation") && candidate.candidate_id !== "a0-baseline")
    .map(item => {
      const generation = Number(item.stage.match(/^g(\d+)/)?.[1] || candidate.generation);
      const parent = candidatesById.get(candidate.parent_id);
      const parentResult = (parent?.evaluations || []).find(parentItem => parentItem.stage === item.stage);
      const delta = item.strict_prompt_accuracy != null && parentResult?.strict_prompt_accuracy != null
        ? item.strict_prompt_accuracy - parentResult.strict_prompt_accuracy
        : null;
      const decision = decisionsByGeneration.get(generation);
      return {candidate, item, generation, parentResult, delta, decision};
    }))
    .sort((left, right) => left.generation - right.generation || left.candidate.candidate_id.localeCompare(right.candidate.candidate_id));
  const activeConfirmationPosition = confirmationCandidates.filter(record => record.generation === activeGeneration).length;
  const activeRunLabel = measuringParent
    ? "parent benchmark"
    : stageLabel === "confirmation"
      ? `finalist ${Math.max(activeConfirmationPosition, 1)} of 2`
      : `candidate ${candidatePosition || 1} of ${search.candidates_per_generation || 4}`;
  const parentCandidate = candidates.find(candidate => candidate.candidate_id === (stateRecord.incumbent_id || "a0-baseline")) || candidates.find(candidate => candidate.candidate_id === "a0-baseline");
  const parentEvaluation = [...(parentCandidate?.evaluations || [])].reverse().find(item => item.stage === activity?.stage);
  const latestDecision = completedDecisions.at(-1);
  const currentGenerationDecided = latestDecision?.generation === activeGeneration;
  const findingDetail = currentGenerationDecided
    ? latestDecision.accepted
      ? `${latestDecision.selected_candidate_id} beat ${latestDecision.parent_id} by ${signedPercent(latestDecision.strict_prompt_delta)} on the 96 example paired confirmation panel and becomes the next generation parent.`
      : `The best finalist did not beat ${latestDecision.parent_id} on the 96 example paired confirmation panel, so the parent prompt is retained.`
    : "No improvement has been confirmed yet.";
  const activeHasUsableCheckpoint = activity?.status === "complete" || Number(activity?.scored_examples || 0) >= 10;
  const activeDelta = activeHasUsableCheckpoint && activity?.strict_prompt_accuracy != null && parentEvaluation?.strict_prompt_accuracy != null
    ? activity.strict_prompt_accuracy - parentEvaluation.strict_prompt_accuracy
    : null;
  const activeComparison = measuringParent
    ? finalSplit
      ? `${activeCandidate?.candidate_id || "The parent prompt"} has completed ${activity?.scored_examples || 0} of ${activity?.total || 0} ${finalSplit.replaceAll("_", " ")} examples at ${formatPercent(activity?.strict_prompt_accuracy)} strict prompt accuracy.`
      : `The system is measuring ${activeCandidate?.candidate_id || "the parent prompt"} on the same tasks that candidates must beat.`
    : activeDelta == null
      ? `${activity?.scored_examples || 0} of ${activity?.total || 0} examples have been scored, which is too early for a useful comparison.`
      : `${activeCandidate?.candidate_id || "This candidate"} currently passes ${formatPercent(activity?.strict_prompt_accuracy)} of scored prompts. The parent passes ${formatPercent(parentEvaluation?.strict_prompt_accuracy)}, so the candidate is ${Math.abs(activeDelta * 100).toFixed(1)} percentage points ${activeDelta > 0 ? "ahead" : "behind"}.`;
  const activeHeadline = measuringParent
    ? finalSplit
      ? `Measuring the ${finalSplit.replaceAll("_", " ")} baseline`
      : `Measuring the generation ${activeGeneration} parent benchmark`
    : activeDelta == null
      ? `Testing ${activeCandidate?.candidate_id || "the current candidate"}`
      : `${activeCandidate?.candidate_id || "The current candidate"} is ${Math.abs(activeDelta * 100).toFixed(1)} points ${activeDelta > 0 ? "ahead" : "behind"} so far`;
  const nextExplanation = stageLabel === "screening"
    ? "After all four candidates finish, the two highest scores move to a larger 96 example confirmation round. Nothing is inherited during screening."
    : stageLabel === "confirmation"
      ? "After both finalists finish, the best one is adopted only if it beats the parent on the same 96 examples. Otherwise the parent remains unchanged."
      : finalSplit === "validation"
        ? "When validation finishes, its paired result is frozen and the heldout test becomes available. Validation cannot change the selected prompt."
        : finalSplit === "heldout_test"
          ? "When this heldout comparison finishes, A1 is complete. The heldout result cannot change the selected prompt."
          : "This stage measures the selected prompt without allowing another prompt change.";
  const pipeline = [
    {label: "search", status: stateRecord.status === "complete" ? "complete" : runningThisRun && !finalSplit ? "running" : "waiting", progress: stateRecord.status === "complete" ? 100 : 0},
    {label: "evolution", status: comparisons.evolution ? "complete" : finalSplit === "evolution" && evaluationInProgress ? "running" : "waiting", progress: comparisons.evolution ? 100 : finalSplit === "evolution" ? activity?.percent || 0 : 0},
    {label: "validation", status: comparisons.validation ? "complete" : finalSplit === "validation" && evaluationInProgress ? "running" : "waiting", progress: comparisons.validation ? 100 : finalSplit === "validation" ? activity?.percent || 0 : 0},
    {label: "heldout test", status: comparisons.heldout_test ? "complete" : finalSplit === "heldout_test" && evaluationInProgress ? "running" : "waiting", progress: comparisons.heldout_test ? 100 : finalSplit === "heldout_test" ? activity?.percent || 0 : 0},
  ];
  const automaticStage = finalSplit && evaluationInProgress
    ? finalSplit
    : comparisons.heldout_test ? "heldout_test" : comparisons.validation ? "validation" : stateRecord.status === "complete" ? "evolution" : "search";
  if (!state.a1Stage) {
    state.a1Stage = automaticStage;
    history.replaceState(null, "", `#a1/${automaticStage}/${run?.run_id || ""}`);
  }
  const selectedStage = state.a1Stage;
  const selectedComparison = selectedStage === "search" ? null : comparisons[selectedStage];
  const selectedStageLabel = selectedStage.replaceAll("_", " ");
  const showSearch = selectedStage === "search";
  const showActiveEvaluation = showSearch ? !finalSplit : finalSplit === selectedStage && evaluationInProgress;
  const retainedBaseline = stateRecord.winner_id === "a0-baseline";
  const selectedFinalStage = selectedStage === "search" ? null : `final-${selectedStage}`;
  const baselineFinalEvaluation = selectedFinalStage
    ? (candidatesById.get("a0-baseline")?.evaluations || []).find(item => item.stage === selectedFinalStage)
    : null;
  const winnerFinalEvaluation = selectedFinalStage
    ? (candidatesById.get(stateRecord.winner_id || stateRecord.incumbent_id || "a0-baseline")?.evaluations || []).find(item => item.stage === selectedFinalStage)
    : null;
  content.innerHTML = `
    ${stateRecord.status === "failed" && !runningThisRun ? `<div class="banner error"><strong>A1 search stopped:</strong> ${escapeHtml(stateRecord.error || "The runner exited before completing the current candidate.")} The saved candidate ledger can be resumed.</div>` : ""}
    <div class="card run-control-top">
      <div>
        <p class="eyebrow">run control</p>
        <div class="run-control-title"><h2>${escapeHtml(run?.run_id || "new a1 run")}</h2>${statusBadge(runningThisRun ? "running" : run?.complete ? "complete" : "ready")}</div>
        <p class="muted">Proposer: ${escapeHtml(runProposer)} · model: ${escapeHtml(proposerStatus.deepseek?.model || "not configured")} · API key: ${proposerStatus.deepseek?.configured ? "configured" : "not configured"}</p>
      </div>
      <div class="run-control-actions"><label><span>view run</span><select id="a1-run-select">${runs.map(item => `<option value="${escapeHtml(item.run_id)}" ${item.run_id === run?.run_id ? "selected" : ""}>${escapeHtml(item.run_id)} · ${escapeHtml(item.proposer || "deterministic")}</option>`).join("")}</select></label>${runs.length > 1 ? `<button class="button secondary comparison-open" id="a1-compare-runs"><span class="comparison-icon" aria-hidden="true">↗</span> compare ${runs.length} runs</button>` : ""}<button class="button primary" id="a1-start" ${anyA1Running || (run?.complete && !proposerStatus.deepseek?.configured) ? "disabled" : ""}>${anyA1Running && !runningThisRun ? "another run is active" : escapeHtml(actionLabel)}</button></div>
    </div>
    <div class="card stage-pipeline" aria-label="Select A1 stage">
      ${pipeline.map((item, index) => { const value = item.label.replace("heldout test", "heldout_test"); return `<div class="pipeline-stage ${item.status} ${selectedStage === value ? "active" : ""}"><button class="stage-select" data-a1-stage="${value}" aria-label="Show ${escapeHtml(item.label)} results"><div class="pipeline-label"><span>${index + 1}</span><strong>${escapeHtml(item.label)}</strong><em>${escapeHtml(item.status)}</em></div><div class="pipeline-track"><span style="width:${Math.min(item.progress, 100)}%"></span></div></button><button class="stage-help" data-stage-help="${value}" aria-label="Explain ${escapeHtml(item.label)} stage">?</button></div>`; }).join("")}
    </div>
    ${!showSearch ? selectedComparison ? `<div class="card evaluation-insight"><div><p class="eyebrow">${escapeHtml(selectedStageLabel)} result</p><h2>${signedPercent(selectedComparison.strict_prompt_delta)} change from baseline</h2><p>${retainedBaseline ? `Search retained the original prompt, so ${escapeHtml(selectedStageLabel)} measured the same prompt on both sides. Both scored ${formatPercent(selectedComparison.baseline_strict_prompt_accuracy)}. This confirms reproducibility and cannot demonstrate improvement.` : `The selected prompt scored ${formatPercent(selectedComparison.candidate_strict_prompt_accuracy)} versus ${formatPercent(selectedComparison.baseline_strict_prompt_accuracy)} for the baseline.`}</p><strong>${selectedStage === "heldout_test" ? "This is the final A1 result." : selectedStage === "validation" ? "Validation is complete. The heldout test is next." : "Evolution evaluation is complete."}</strong></div>${splitComparisonChart({[selectedStage]: selectedComparison})}</div>` : `<div class="card stage-empty"><p class="eyebrow">${escapeHtml(selectedStageLabel)}</p><h2>${finalSplit === selectedStage && evaluationInProgress ? "Evaluation is running" : runningThisRun && !finalSplit ? "Search is running first" : "This stage has not run yet"}</h2><p>${runningThisRun && !finalSplit ? "Open the Search stage to watch DeepSeek propose candidates and IFEval score them. This evaluation stage begins only after Search finishes." : selectedStage === "heldout_test" ? "Complete validation before starting the heldout test." : "Complete the preceding stage before this result becomes available."}</p></div>` : ""}
    ${!showSearch && selectedComparison && baselineFinalEvaluation && winnerFinalEvaluation ? `<div class="card section"><div class="card-head"><div><h2>${escapeHtml(selectedStageLabel)} metric profile</h2><p class="muted">complete verifier results across all three quality measures</p></div></div>${stageMetricChart(baselineFinalEvaluation, winnerFinalEvaluation)}<p class="chart-note">Strict prompt accuracy requires every instruction in an example to pass. Strict instruction accuracy counts individual instructions. Loose prompt accuracy tolerates formatting variations.</p></div>` : ""}
    ${!showSearch && winnerFinalEvaluation?.progress_history?.length ? `<div class="card section"><div class="card-head"><div><h2>${escapeHtml(selectedStageLabel)} checkpoint history</h2><p class="muted">how measured quality changed as examples were verified</p></div></div>${metricChart(winnerFinalEvaluation.progress_history, ["strict_prompt_accuracy", "strict_instruction_accuracy", "loose_prompt_accuracy"])}</div>` : ""}
    <div class="card experiment-brief ${showActiveEvaluation ? "" : "hidden"}">
      <p class="eyebrow">what is happening now</p>
      <h2>${escapeHtml(activeHeadline)}</h2>
      <p class="brief-lead">${escapeHtml(activeComparison)}</p>
      ${!measuringParent && activeCandidate ? `<p><strong>The change being tested:</strong> ${escapeHtml(activeCandidate.rationale || "A revised system prompt is being compared with its parent.")}</p>` : ""}
      <p><strong>What counts as success:</strong> the revised system prompt must make Qwen satisfy every instruction in more prompts than the current parent does. The model weights, data, and evaluator do not change.</p>
      <p><strong>What happens next:</strong> ${escapeHtml(nextExplanation)}</p>
      <div class="plain-conclusion"><strong>Current conclusion:</strong> ${escapeHtml(currentGenerationDecided ? findingDetail : "No improvement has been confirmed yet.")} <span>${runProposer === "deepseek" ? `DeepSeek ${escapeHtml(proposerStatus.deepseek?.model || "")} proposes the changes; IFEval scores them.` : "This control run uses a fixed mutation bank. DeepSeek will be used in the separately registered run."}</span></div>
    </div>
    ${activity && showActiveEvaluation ? `<div class="card a1-live"><div class="card-head"><div><p class="eyebrow">${evaluationInProgress ? `${finalSplit ? finalSplit.replaceAll("_", " ") : "evolution"} is active` : runningThisRun ? "evaluation complete · next comparison starting" : "latest evaluation"}</p><h2>${finalSplit ? `${finalSplit.replaceAll("_", " ")} · ${measuringParent ? "baseline" : "selected prompt"}` : `generation ${activeGeneration} of ${search.generations || 3} · ${stageLabel} ${activeRunLabel}`}</h2></div>${statusBadge(evaluationInProgress ? "running" : activity.status)}</div><p class="a1-live-explanation">${evaluationInProgress ? "Evaluating" : "Last evaluated"} <span class="run-id">${escapeHtml(activity.candidate_id)}</span>. ${stageLabel === "screening" ? "The best two candidates advance to confirmation." : stageLabel === "confirmation" ? "A candidate replaces the incumbent only if it beats the incumbent on the paired confirmation panel." : `This is a frozen ${finalSplit?.replaceAll("_", " ") || "final"} measurement. It cannot select or modify a prompt.`}</p><div class="progress"><span style="width:${Math.min(activity.percent || 0, 100)}%"></span></div><div class="a1-progress-meta"><strong>${activity.completed || 0} / ${activity.total || 0} generated</strong><span>${activity.scored_examples || 0} scored</span><span>${evaluationInProgress ? "live" : "final"} strict estimate ${formatPercent(activity.strict_prompt_accuracy)}</span><span>${(activity.examples_per_second || 0).toFixed(3)} ex/s</span><span>${evaluationInProgress ? `ETA ${formatDuration(activity.eta_seconds)}` : runningThisRun ? "next comparison is still to run" : "evaluation complete"}</span></div></div>` : ""}
    ${activity && showActiveEvaluation ? `<div class="card section"><div class="card-head"><div><h2>live candidate checkpoints</h2><p class="muted">${escapeHtml(activity.candidate_id)} updates as new responses are verified</p></div><span class="live-indicator">${evaluationInProgress ? "● live" : "final"}</span></div>${metricChart(activity.progress_history, ["strict_prompt_accuracy", "strict_instruction_accuracy", "loose_prompt_accuracy"])}<p class="chart-note">Blue is the metric used to select a prompt. Green shows instruction-level accuracy. Orange is the format-tolerant upper bound. These lines can move until the candidate finishes.</p></div>` : ""}
    ${activity && showSearch && stageLabel === "screening" ? `<div class="card section generation-screen"><div class="card-head"><div><h2>generation ${activeGeneration} screening results</h2><p class="muted">completed candidates stay visible while the remaining candidates run</p></div><span class="muted">${generationCandidates.filter(record => record.evaluation?.status === "complete").length} of ${search.candidates_per_generation || 4} final</span></div>${generationScreenChart(generationCandidates, parentEvaluation?.strict_prompt_accuracy, activity.candidate_id)}<div class="screen-legend"><span class="final">final screen score</span><span class="live">live partial score</span><span class="parent">parent score to beat</span></div><p class="chart-note">Candidate 1 remains here with its final 32 example result. Orange is the candidate currently being scored. The two highest final scores advance only after all four screens finish.</p></div>` : ""}
    ${activity && showSearch ? `<div class="grid two section"><div class="card"><div class="card-head"><h2>improvement across generations</h2><span class="muted">solid points are final · orange is live</span></div>${generationProgressChart(generationHistory, generationHistory[0]?.parentScore || parentEvaluation?.strict_prompt_accuracy)}<div class="generation-history"><div class="history-row history-head"><span>stage</span><span>candidate</span><span>score</span><span>parent</span><span>change</span><span>decision</span></div><div class="history-row"><strong>baseline</strong><span class="run-id">a0-baseline</span><strong>${formatPercent(generationHistory[0]?.parentScore || parentEvaluation?.strict_prompt_accuracy)}</strong><span>reference</span><span>0.0 pp</span><span>starting prompt</span></div>${generationHistory.map(item => `<div class="history-row ${item.provisional ? "provisional" : ""}"><strong>generation ${item.generation}</strong><span class="run-id">${escapeHtml(item.candidateId)}</span><strong>${formatPercent(item.candidateScore)}</strong><span>${formatPercent(item.parentScore)}</span><span class="${item.delta > 0 ? "metric-positive" : item.delta < 0 ? "metric-negative" : "metric-neutral"}">${item.delta == null ? "too early" : signedPercent(item.delta)}${item.provisional ? " partial" : ""}</span><span>${escapeHtml(item.outcome)}</span></div>`).join("")}</div><p class="chart-note">A point above the dashed baseline is an improvement. A point below it is a regression. The live point can move until all 96 examples are scored.</p></div><div class="card"><div class="card-head"><h2>all confirmation runs</h2><span class="muted">every finalist, across every generation</span></div><table><thead><tr><th>generation</th><th>candidate</th><th>evidence</th><th>score</th><th>versus parent</th></tr></thead><tbody>${confirmationCandidates.map(record => `<tr class="drilldown-row" data-a1-candidate="${escapeHtml(record.candidate.candidate_id)}" data-a1-stage="${escapeHtml(record.item.stage)}"><td>${record.generation}</td><td><span class="run-id">${escapeHtml(record.candidate.candidate_id)}</span><small class="table-subline">${escapeHtml(record.candidate.rationale || "Prompt revision")}</small></td><td>${record.item.scored_examples || record.item.completed || 0}/${record.item.total || 0}${record.item.status === "complete" ? " final" : " partial"}</td><td>${formatPercent(record.item.strict_prompt_accuracy)}</td><td class="${record.delta > 0 ? "metric-positive" : record.delta < 0 ? "metric-negative" : "metric-neutral"}">${record.delta == null ? "pending" : signedPercent(record.delta)}${record.item.status === "complete" ? "" : " partial"}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
    <div class="${showSearch ? "" : "hidden"}">
    <div class="card section">
        <div class="card-head"><div><p class="eyebrow">prompt-only recursive improvement</p><h2>a1 evolution protocol</h2></div>${statusBadge(run?.complete ? "complete" : runningThisRun ? "running" : run ? stateRecord.status || "ready" : "ready")}</div>
        <p class="muted">Three generations. Four children per generation. Only the system prompt may change. Validation and heldout results cannot select a candidate.</p>
        <div class="kv">
          <div>baseline</div><div class="run-id">${escapeHtml(config.experiment?.baseline_run_id || "a0")}</div>
          <div>primary metric</div><div>${escapeHtml(config.experiment?.primary_metric || "strict prompt accuracy")}</div>
          <div>screen panel</div><div>${escapeHtml(search.screen_examples || 0)} evolution examples</div>
          <div>confirmation panel</div><div>${escapeHtml(search.confirmation_examples || 0)} evolution examples</div>
          <div>acceptance rule</div><div>positive paired confirmation delta</div>
          <div>current incumbent</div><div class="run-id">${escapeHtml(stateRecord.incumbent_id || "a0-baseline")} ${runningThisRun && !(stateRecord.completed_generations || []).length ? "· unchanged until confirmation" : ""}</div>
        </div>
    </div>
    <div class="grid kpis section">${comparisonCards}</div>
    <div class="grid two section">
      <div class="card flush">
        <div class="card-head ledger-heading" style="padding:16px;margin:0"><div><h2>what happened to each prompt change</h2><p class="muted">A small screen chooses two finalists. Confirmation decides whether a finalist actually replaces its parent.</p></div><span class="muted">${candidates.length} candidates recorded</span></div>
        <table><thead><tr><th>candidate</th><th>change being tested</th><th>outcome</th><th>why</th></tr></thead><tbody>
          ${candidates.length ? candidates.map(candidate => { const latest = candidate.evaluations?.at(-1); const outcome = ledgerOutcome(candidate); return `<tr ${latest ? `class="drilldown-row" data-a1-candidate="${escapeHtml(candidate.candidate_id)}" data-a1-stage="${escapeHtml(latest.stage)}"` : ""}><td><span class="run-id">${escapeHtml(candidate.candidate_id)}</span><small class="table-subline">generation ${escapeHtml(candidate.generation)} · parent ${escapeHtml(candidate.parent_id || "none")}</small></td><td>${escapeHtml(candidate.rationale || (candidate.generation === 0 ? "Original system prompt" : candidate.operators?.join(", ") || "Prompt revision"))}</td><td>${statusBadge(outcome.status, outcome.label)}</td><td>${escapeHtml(outcome.reason)}</td></tr>`; }).join("") : `<tr><td colspan="4" class="empty">Candidates appear when search starts.</td></tr>`}
        </tbody></table>
      </div>
      <div class="card">
        <div class="card-head"><h2>generation decisions</h2><span class="muted">why the parent changed or stayed</span></div>
        ${(run?.decisions || []).length ? run.decisions.map(item => `<div class="check ${item.accepted ? "passed" : ""}"><span class="icon">${item.accepted ? "✓" : "×"}</span><div><strong>generation ${item.generation}: ${item.accepted ? `${escapeHtml(item.selected_candidate_id)} became the new parent` : `${escapeHtml(item.parent_id)} remained the parent`}</strong><small>${escapeHtml(explainDecision(item))}</small></div></div>`).join("") : `<div class="empty">No generation decision has been made yet.</div>`}
      </div>
    </div>
    </div>`;
  document.getElementById("a1-start").addEventListener("click", async event => {
    event.currentTarget.disabled = true;
    try {
      const useExistingRun = run && !run.complete;
      const result = await api("/api/a1/start", {method:"POST", body:JSON.stringify({run_id:useExistingRun ? run.run_id : null, stage:useExistingRun ? nextStage : "search", proposer:useExistingRun ? runProposer : "deepseek"})});
      showBanner(result.message);
      // A new DeepSeek experiment always begins in Search. Move the URL and
      // visible stage there so the user immediately sees proposal and scoring
      // progress instead of a waiting evaluation tab from the previous run.
      if (!useExistingRun) {
        state.a1Stage = "search";
        history.replaceState(null, "", "#a1/search");
      }
      await refresh();
    } catch (error) { showBanner(error.message, "error"); event.currentTarget.disabled = false; }
  });
  document.querySelectorAll("[data-a1-stage]").forEach(button => button.addEventListener("click", () => {
    location.hash = `a1/${button.dataset.a1Stage}/${run.run_id}`;
  }));
  document.getElementById("a1-run-select").addEventListener("change", event => {
    location.hash = `a1/${selectedStage}/${event.target.value}`;
  });
  if (runs.length > 1) {
    renderRunComparisonDrawer(runs, run.run_id, selectedStage);
    document.getElementById("a1-compare-runs").addEventListener("click", openRunComparisonDrawer);
  }
  document.querySelectorAll("[data-stage-help]").forEach(button => button.addEventListener("click", () => {
    openStageHelp(button.dataset.stageHelp);
  }));
  document.querySelectorAll("[data-a1-candidate]").forEach(row => row.addEventListener("click", () => {
    openA1Candidate(run.run_id, row.dataset.a1Candidate, row.dataset.a1Stage);
  }));
}

function bindNavigationButtons() {
  document.querySelectorAll("[data-nav]").forEach(button => button.addEventListener("click", () => { location.hash = button.dataset.nav; }));
}

async function render() {
  const [requestedView, requestedStage, requestedRun] = (location.hash.slice(1) || "overview").split("/");
  state.view = requestedView;
  if (state.view === "a1") {
    state.a1Stage = ["search", "evolution", "validation", "heldout_test"].includes(requestedStage) ? requestedStage : null;
    state.a1RunId = requestedRun ? decodeURIComponent(requestedRun) : null;
  }
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
stageHelpDialog.querySelector(".dialog-close").addEventListener("click", () => stageHelpDialog.close());
document.getElementById("run-comparison-backdrop").addEventListener("click", closeRunComparisonDrawer);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && runComparisonLayer.classList.contains("open")) closeRunComparisonDrawer();
});
setInterval(async () => {
  if (["overview", "run", "a1", "system"].includes(state.view)) await refresh();
}, 5000);
refresh();

/* =============================================================
   NeuroReadiness — history.js
   The history dashboard: long-term trends, session log, and the
   rolling personal baseline that makes every number mean something.

   Charts are hand-rolled SVG (no chart library) to stay dependency-
   free and consistent with the calibrated-instrument aesthetic.
   Reads everything through NR.store.
   ============================================================= */
(function () {
  "use strict";
  const NR = window.NR;
  const { el } = NR.dom;

  // Metrics you can trend. accessor pulls a number out of a session record.
  const METRICS = [
    { key: "readiness", label: "Readiness", better: "high", unit: "", accessor: (s) => s.readiness },
    { key: "meanRT", label: "Reaction time", better: "low", unit: "ms", accessor: (s) => s.taskMetrics && s.taskMetrics.pvt && s.taskMetrics.pvt.meanRT },
    { key: "lapses", label: "Lapses", better: "low", unit: "", accessor: (s) => s.taskMetrics && s.taskMetrics.pvt && s.taskMetrics.pvt.lapses },
    { key: "hrv", label: "HRV (RMSSD)", better: "high", unit: "ms", accessor: (s) => s.ppgSummary && s.ppgSummary.rmssdTask },
    { key: "gsr", label: "GSR arousal", better: "context", unit: "", accessor: (s) => s.gsrSummary && s.gsrSummary.arousalTask },
    { key: "confidence", label: "Data confidence", better: "high", unit: "", accessor: (s) => s.scores && s.scores.dataConfidence },
  ];

  const BASELINE_DAYS = 14;
  const state = { metric: "readiness", sessions: [], profile: null, expanded: null };

  const fmtNum = (x, unit) =>
    (typeof x === "number" && isFinite(x)) ? `${Math.round(x)}${unit ? " " + unit : ""}` : "—";
  const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  // --- Pure SVG line chart with a rolling-baseline band --------------------
  // points: [{t, v}] (already filtered to finite v). baseline: {mean, sd, n}.
  function chartSVG(points, meta, baseline) {
    const W = 720, H = 260, padL = 46, padR = 14, padT = 16, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;

    if (!points.length) {
      return `<svg viewBox="0 0 ${W} ${H}" class="chart"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="chart-empty">No data for this metric yet</text></svg>`;
    }

    // Y range from data + baseline band, padded.
    const vals = points.map((p) => p.v);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (baseline.n) { lo = Math.min(lo, baseline.mean - baseline.sd); hi = Math.max(hi, baseline.mean + baseline.sd); }
    if (lo === hi) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
    if (meta.key !== "readiness" && meta.key !== "confidence" && lo < 0) lo = 0;

    const tMin = points[0].t, tMax = points[points.length - 1].t;
    const span = tMax - tMin;
    const X = (t, i) => padL + (span > 0 ? ((t - tMin) / span) * plotW : (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2));
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * plotH;

    // Y grid + labels (4 ticks).
    let grid = "";
    for (let i = 0; i <= 3; i++) {
      const v = lo + (i / 3) * (hi - lo);
      const y = Y(v);
      grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="chart-grid"/>`;
      grid += `<text x="${padL - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="chart-axis">${Math.round(v)}</text>`;
    }

    // Baseline band + mean line.
    let band = "";
    if (baseline.n >= 2) {
      const yTop = Y(baseline.mean + baseline.sd), yBot = Y(baseline.mean - baseline.sd), yMean = Y(baseline.mean);
      band = `<rect x="${padL}" y="${yTop.toFixed(1)}" width="${plotW}" height="${Math.max(0, yBot - yTop).toFixed(1)}" class="chart-band"/>
              <line x1="${padL}" y1="${yMean.toFixed(1)}" x2="${W - padR}" y2="${yMean.toFixed(1)}" class="chart-mean"/>
              <text x="${W - padR}" y="${(yMean - 5).toFixed(1)}" text-anchor="end" class="chart-axis">your ${BASELINE_DAYS}-day normal</text>`;
    }

    // Data path + dots.
    let d = "", dots = "";
    points.forEach((p, i) => {
      const x = X(p.t, i), y = Y(p.v);
      d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
      const off = baseline.n ? (p.v - baseline.mean) : 0;
      const goodDir = meta.better === "high" ? off >= 0 : off <= 0;
      const cls = !baseline.n || meta.better === "context" ? "neutral" : goodDir ? "good" : "bad";
      dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" class="chart-dot ${cls}"/>`;
    });

    // X end labels.
    const xlabels =
      `<text x="${padL}" y="${H - 8}" class="chart-axis">${new Date(tMin).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</text>` +
      (span > 0 ? `<text x="${W - padR}" y="${H - 8}" text-anchor="end" class="chart-axis">${new Date(tMax).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</text>` : "");

    return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet">
      ${grid}${band}
      <path d="${d.trim()}" class="chart-line" fill="none"/>
      ${dots}${xlabels}
    </svg>`;
  }

  // --- Render --------------------------------------------------------------
  async function render() {
    state.profile = await NR.store.getActiveProfile();
    state.sessions = await NR.store.getSessions(state.profile ? state.profile.id : null);

    const empty = el("#history-empty");
    const content = el("#history-content");
    if (!state.sessions.length) {
      if (empty) empty.classList.remove("hidden");
      if (content) content.classList.add("hidden");
      const pn = el("#history-profile"); if (pn) pn.textContent = state.profile ? state.profile.name : "—";
      return;
    }
    if (empty) empty.classList.add("hidden");
    if (content) content.classList.remove("hidden");

    el("#history-profile").textContent = state.profile ? state.profile.name : "—";
    el("#history-count").textContent =
      `${state.sessions.length} session${state.sessions.length === 1 ? "" : "s"}`;

    renderHeadline();
    renderTabs();
    renderChart();
    renderLog();
  }

  function renderHeadline() {
    const latest = state.sessions[state.sessions.length - 1];
    const stats = NR.store.baselineStats(
      state.sessions.filter((s) => s.timestamp >= Date.now() - BASELINE_DAYS * 864e5).map((s) => s.readiness)
    );
    const r = latest.readiness;
    el("#headline-value").textContent = fmtNum(r, "");
    const deltaEl = el("#headline-delta");
    if (stats.n >= 2 && isFinite(r)) {
      const d = Math.round(r - stats.mean);
      const sign = d > 0 ? "+" : "";
      deltaEl.textContent = `${sign}${d} vs your ${BASELINE_DAYS}-day normal (${Math.round(stats.mean)})`;
      deltaEl.className = "headline-delta " + (d >= 0 ? "good" : "bad");
    } else {
      deltaEl.textContent = "building your baseline — a few more sessions and trends sharpen up";
      deltaEl.className = "headline-delta neutral";
    }
    el("#headline-when").textContent = "last check · " + fmtDate(latest.timestamp);
  }

  function renderTabs() {
    const tabs = el("#metric-tabs");
    tabs.innerHTML = METRICS.map((m) =>
      `<button class="metric-tab ${m.key === state.metric ? "active" : ""}" data-metric="${m.key}">${m.label}</button>`
    ).join("");
    NR.dom.all(".metric-tab", tabs).forEach((b) =>
      b.addEventListener("click", () => { state.metric = b.dataset.metric; renderTabs(); renderChart(); })
    );
  }

  function renderChart() {
    const meta = METRICS.find((m) => m.key === state.metric);
    const points = state.sessions
      .map((s) => ({ t: s.timestamp, v: meta.accessor(s) }))
      .filter((p) => typeof p.v === "number" && isFinite(p.v));
    const baseline = NR.store.baselineStats(
      state.sessions.filter((s) => s.timestamp >= Date.now() - BASELINE_DAYS * 864e5).map(meta.accessor)
    );
    el("#chart-better").textContent =
      meta.better === "context" ? "context only" : meta.better === "high" ? "higher is better" : "lower is better";
    el("#history-chart").innerHTML = chartSVG(points, meta, baseline);
  }

  function renderLog() {
    const log = el("#history-log");
    const rows = [...state.sessions].reverse(); // newest first
    log.innerHTML = rows.map((s) => {
      const open = state.expanded === s.id;
      const conf = s.scores && s.scores.dataConfidence;
      const confCls = conf >= 55 ? "good" : conf >= 30 ? "warn" : "bad";
      const tags = (s.tags || []).map((t) => `<span class="log-tag">${t}</span>`).join("");
      return `
        <div class="log-row ${open ? "open" : ""}" data-id="${s.id}">
          <div class="log-head">
            <span class="log-readiness">${fmtNum(s.readiness, "")}</span>
            <div class="log-meta">
              <div class="log-when">${fmtDate(s.timestamp)}</div>
              <div class="log-sub">${s.mode || "—"} · confidence <span class="log-conf ${confCls}">${fmtNum(conf, "")}</span> ${tags}</div>
            </div>
            <span class="log-chevron">${open ? "▾" : "▸"}</span>
          </div>
          ${open ? logDetail(s) : ""}
        </div>`;
    }).join("");

    NR.dom.all(".log-head", log).forEach((h) =>
      h.addEventListener("click", () => {
        const id = h.parentElement.dataset.id;
        state.expanded = state.expanded === id ? null : id;
        renderLog();
      })
    );
    NR.dom.all(".log-delete", log).forEach((b) =>
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        await NR.store.deleteSession(b.dataset.id);
        if (state.expanded === b.dataset.id) state.expanded = null;
        render();
      })
    );
  }

  function logDetail(s) {
    const p = (s.taskMetrics && s.taskMetrics.pvt) || {};
    const st = (s.taskMetrics && s.taskMetrics.stroop) || {};
    const nb = (s.taskMetrics && s.taskMetrics.nback) || {};
    const pp = s.ppgSummary || {};
    const row = (k, v) => `<div class="detail-item"><span>${k}</span><b>${v}</b></div>`;
    return `<div class="log-detail">
      <div class="detail-grid">
        ${row("Alertness", fmtNum(s.scores && s.scores.alertness, ""))}
        ${row("Cognitive control", fmtNum(s.scores && s.scores.cognitiveControl, ""))}
        ${row("Working memory", fmtNum(s.scores && s.scores.workingMemory, ""))}
        ${row("Physio load", fmtNum(s.scores && s.scores.physiologicalLoad, ""))}
        ${row("GSR arousal", fmtNum(s.scores && s.scores.electrodermalArousal, ""))}
        ${row("Mean RT", fmtNum(p.meanRT, "ms"))}
        ${row("Lapses", fmtNum(p.lapses, ""))}
        ${row("Stroop interf.", fmtNum(st.interference, "ms"))}
        ${row("2-back d′", (nb.dPrime != null && isFinite(nb.dPrime)) ? nb.dPrime.toFixed(2) : "—")}
        ${row("HR base→task", `${fmtNum(pp.hrBaseline, "")}→${fmtNum(pp.hrTask, "")}`)}
        ${row("RMSSD base→task", `${fmtNum(pp.rmssdBaseline, "")}→${fmtNum(pp.rmssdTask, "")}`)}
        ${row("Signal quality", fmtNum(pp.meanQuality, ""))}
        ${row("GSR base→task", `${fmtNum(s.gsrSummary && s.gsrSummary.arousalBaseline, "")}→${fmtNum(s.gsrSummary && s.gsrSummary.arousalTask, "")}`)}
        ${row("Motion clean", s.motionClean != null ? Math.round(s.motionClean * 100) + "%" : "—")}
      </div>
      <button class="btn btn-ghost log-delete" data-id="${s.id}">Delete session</button>
    </div>`;
  }

  NR.history = { render, chartSVG, METRICS };
  console.log("[NR] history loaded");
})();

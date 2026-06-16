/* =============================================================
   NeuroReadiness — app.js
   Orchestration. Owns the screen flow, the live waveform, the
   baseline capture, the task sequence, scoring, and the results
   dashboard. Everything below the sensor layer is source-agnostic.

   The launch URL selects the sensor source:
     app.html?source=demo#/check   -> simulated sensor stream
     app.html?source=serial#/check -> ESP32 over Web Serial
   ============================================================= */
(function () {
  "use strict";
  const NR = window.NR;
  const { el, show, hide } = NR.dom;
  const C = NR.config;

  // ---- Shared modules -------------------------------------------------------
  const ppg = new NR.PPGProcessor();
  const motion = new NR.MotionDetector();
  const gsr = new NR.GSRProcessor();
  const recorder = new NR.Recorder();

  const requestedSource = new URLSearchParams(location.search).get("source");
  const sensorSource = requestedSource === "serial" ? "serial" : "demo";
  NR.sensor = sensorSource === "serial" ? new NR.SerialSensor() : new NR.MockSensor();

  // ---- Session state --------------------------------------------------------
  const session = {
    mode: "finger",
    guest: false, // guest runs are computed but never saved (no baseline pollution)
    connected: false,
    baselinePPG: null,
    taskPPG: null,
    baselineGSR: null,
    taskGSR: null,
    results: {},
    completedTasks: 0,
    collecting: null, // "baseline" | "task" | null
    hrBuf: [],
    rmssdBuf: [],
    gsrArousalBuf: [],
    gsrTonicBuf: [],
    gsrReactivityBuf: [],
  };

  // ---- Wire the data pipeline (sample → motion/ppg/gsr) ---------------------
  NR.bus.on("sample", (s) => {
    motion.onSample(s);
    ppg.onSample(s);
    gsr.onSample(s);
  });
  NR.bus.on("motion", ({ flag }) => {
    ppg.setMotionFlag(flag);
    document.body.classList.toggle("motion-active", flag);
    const badge = el("#motion-badge");
    if (badge) badge.classList.toggle("hidden", !flag);
  });
  NR.bus.on("ppg", (p) => {
    updateLiveReadouts(p);
    if (session.collecting && isFinite(p.hr)) {
      session.hrBuf.push(p.hr);
      if (isFinite(p.rmssd)) session.rmssdBuf.push(p.rmssd);
    }
  });
  NR.bus.on("gsr", (g) => {
    updateGSRReadout(g);
    if (session.collecting && g.hasSignal) {
      if (isFinite(g.arousal)) session.gsrArousalBuf.push(g.arousal);
      if (isFinite(g.tonic)) session.gsrTonicBuf.push(g.tonic);
      if (isFinite(g.reactivity)) session.gsrReactivityBuf.push(g.reactivity);
    }
  });
  NR.bus.on("sensor:status", ({ connected, kind }) => {
    session.connected = connected;
    const dot = el("#sensor-dot");
    const label = el("#sensor-label");
    if (dot) dot.classList.toggle("on", connected);
    if (label) {
      const liveLabel = kind === "mock" ? "demo stream live" : "sensor stream live";
      label.textContent = connected ? liveLabel : "disconnected";
    }
  });

  // ===========================================================================
  //  LIVE WAVEFORM (oscilloscope-style, confidence-reactive)
  // ===========================================================================
  const waveBuf = new NR.math.RingBuffer(NR.config.SAMPLE_RATE_HZ * 6);
  NR.bus.on("ppg", (p) => waveBuf.push(p.ac));

  let waveformStarted = false;
  function startWaveform() {
    const canvas = el("#wave");
    if (!canvas || waveformStarted) return;
    waveformStarted = true;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    function resize() {
      const r = canvas.getBoundingClientRect();
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
    }
    resize();
    window.addEventListener("resize", resize);

    function draw() {
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Grid.
      ctx.strokeStyle = "rgba(12,17,22,0.055)";
      ctx.lineWidth = 1 * dpr;
      for (let x = 0; x < w; x += 36 * dpr) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = 0; y < h; y += 36 * dpr) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

      const data = waveBuf.toArray();
      if (data.length > 1) {
        const max = Math.max(1, ...data.map(Math.abs));
        // Colour follows confidence: teal when trusted, amber when shaky.
        const q = ppg.quality;
        const trusted = q >= 55;
        ctx.strokeStyle = trusted ? "#0d8a7d" : "#d97706";
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        for (let i = 0; i < data.length; i++) {
          const x = (i / (data.length - 1)) * w;
          const y = h / 2 - (data[i] / max) * (h * 0.38);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
        // Soft glow.
        ctx.shadowColor = trusted ? "rgba(13,138,125,0.28)" : "rgba(217,119,6,0.30)";
        ctx.shadowBlur = 8 * dpr;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      requestAnimationFrame(draw);
    }
    draw();
  }

  function updateLiveReadouts(p) {
    setText("#live-hr", NR.fmt.bpm(p.hr));
    setText("#live-rmssd", isFinite(p.rmssd) ? Math.round(p.rmssd) : "—");
    setText("#live-pi", isFinite(p.pi) ? p.pi.toFixed(2) : "—");
    const q = Math.round(p.quality);
    setText("#live-q", q);
    const meter = el("#q-meter-fill");
    if (meter) {
      meter.style.width = `${q}%`;
      meter.className = "q-meter-fill " + (q >= 55 ? "good" : q >= 30 ? "warn" : "bad");
    }
    const console_ = el("#console");
    if (console_) console_.classList.toggle("low-confidence", q < 55);
  }

  function updateGSRReadout(g) {
    setText("#live-gsr", g && g.hasSignal && isFinite(g.arousal) ? Math.round(g.arousal) : "—");
  }

  // ===========================================================================
  //  FLOW
  // ===========================================================================
  async function connect() {
    try {
      NR.sensor.setMode && NR.sensor.setMode(session.mode);
      await NR.sensor.start();
      startWaveform();
      goto("fit");
      startFitGate();
    } catch (e) {
      alert(e.message || "Could not start the sensor.");
    }
  }

  // ---- Fit / signal-quality gate (W4) --------------------------------------
  // The session cannot begin until the live signal quality holds above
  // threshold continuously for a few seconds. This teaches good placement and
  // refuses to record garbage — the confidence thesis, enforced at the door.
  const FIT_THRESHOLD = 50;     // live signal-quality score considered "clean"
  const FIT_REQUIRED_MS = 3000; // must stay clean this long, continuously
  const FIT_TICK = 150;
  let fitTimer = null, fitGoodMs = 0;

  function startFitGate() {
    fitGoodMs = 0;
    renderPlacementGuide(session.mode);
    const cont = el("#fit-continue");
    if (cont) cont.disabled = true;
    updateFitUI(0, false, 0);
    if (fitTimer) clearInterval(fitTimer);
    fitTimer = setInterval(() => {
      const q = ppg.quality || 0;
      fitGoodMs = q >= FIT_THRESHOLD ? fitGoodMs + FIT_TICK : 0;
      const locked = fitGoodMs >= FIT_REQUIRED_MS;
      updateFitUI(Math.min(1, fitGoodMs / FIT_REQUIRED_MS), locked, q);
      if (locked && cont) cont.disabled = false;
    }, FIT_TICK);
  }

  function stopFitGate() {
    if (fitTimer) clearInterval(fitTimer);
    fitTimer = null;
  }

  function updateFitUI(frac, locked, q) {
    const fill = el("#fit-gate-fill");
    if (fill) {
      fill.style.width = Math.round(frac * 100) + "%";
      fill.className = "fit-gate-fill" + (locked ? " locked" : "");
    }
    const label = el("#fit-gate-label");
    if (label) {
      label.textContent = locked
        ? "Signal locked — ready to begin"
        : q >= FIT_THRESHOLD ? "Hold steady…" : "Acquiring a clean signal…";
    }
    const status = el("#fit-status");
    if (status) status.className = "fit-status " + (locked ? "good" : q >= FIT_THRESHOLD ? "warn" : "bad");
  }

  function renderPlacementGuide(mode) {
    const guide = el("#placement-guide");
    if (!guide) return;
    const fingerSVG = `
      <svg viewBox="0 0 240 140" class="placement-svg" aria-hidden="true">
        <rect x="66" y="92" width="108" height="30" rx="8" fill="none" stroke="var(--teal)" stroke-width="2"/>
        <circle cx="98" cy="107" r="5" fill="var(--red)"/>
        <circle cx="120" cy="107" r="5" fill="var(--red)"/>
        <circle cx="142" cy="107" r="5" fill="var(--teal)"/>
        <path d="M84 86 q4 -54 56 -54 q34 0 34 30 q0 14 -8 24" fill="rgba(12,17,22,0.035)" stroke="var(--muted)" stroke-width="2"/>
        <path d="M84 86 q56 16 82 0" fill="none" stroke="var(--muted)" stroke-width="2"/>
      </svg>`;
    const templeSVG = `
      <svg viewBox="0 0 240 150" class="placement-svg" aria-hidden="true">
        <path d="M168 26 q-78 -6 -86 64 q-4 30 18 46 q12 8 9 20" fill="rgba(12,17,22,0.035)" stroke="var(--muted)" stroke-width="2"/>
        <path d="M92 100 q-13 2 -11 17 q2 10 13 8" fill="none" stroke="var(--muted)" stroke-width="2"/>
        <rect x="96" y="52" width="32" height="24" rx="6" fill="none" stroke="var(--teal)" stroke-width="2"/>
        <circle cx="108" cy="64" r="3.5" fill="var(--red)"/>
        <circle cx="118" cy="64" r="3.5" fill="var(--teal)"/>
        <path d="M96 58 q-46 -18 -2 -44" fill="none" stroke="var(--blue)" stroke-width="2" stroke-dasharray="5 3"/>
      </svg>`;
    const steps = mode === "temple"
      ? ["Sit the sensor flat against your temple, just above the cheekbone.",
         "Use the band to hold it snug — no gap, but no hard pressure.",
         "Temple signal is faint by nature; give it a few seconds to settle."]
      : ["Rest the pad of your index finger flat over the sensor window.",
         "Keep your hand still and supported on a surface.",
         "Light contact only — pressing hard chokes off the signal."];
    guide.innerHTML = `
      ${mode === "temple" ? templeSVG : fingerSVG}
      <div class="placement-steps">
        <div class="placement-mode">${mode === "temple" ? "Temple placement · experimental" : "Finger placement"}</div>
        <ol>${steps.map((s) => `<li>${s}</li>`).join("")}</ol>
      </div>`;
  }

  function setMode(mode) {
    session.mode = mode;
    NR.sensor.setMode && NR.sensor.setMode(mode);
    NR.dom.all(".mode-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === mode)
    );
    el("#temple-warning").classList.toggle("hidden", mode !== "temple");
  }

  // ---- Baseline -------------------------------------------------------------
  let baselineTimer = null;
  function startBaseline() {
    const secs = parseInt(el("#baseline-dur").value, 10) || C.BASELINE_SECONDS;
    session.collecting = "baseline";
    session.hrBuf = [];
    session.rmssdBuf = [];
    session.gsrArousalBuf = [];
    session.gsrTonicBuf = [];
    session.gsrReactivityBuf = [];
    el("#baseline-start").disabled = true;
    el("#baseline-skip").disabled = true;

    let remaining = secs;
    const ring = el("#baseline-ring");
    const label = el("#baseline-count");
    const tick = () => {
      label.textContent = remaining;
      const pct = ((secs - remaining) / secs) * 100;
      ring.style.background = `conic-gradient(#0d8a7d ${pct}%, #eef2f5 ${pct}%)`;
      if (remaining <= 0) {
        clearInterval(baselineTimer);
        finishBaseline();
        return;
      }
      remaining--;
    };
    tick();
    baselineTimer = setInterval(tick, 1000);
  }

  function finishBaseline() {
    session.baselinePPG = snapshotPPG();
    session.baselineGSR = snapshotGSR();
    session.collecting = null;
    goto("tasks");
    runTasks();
  }

  function snapshotPPG() {
    const med = (arr) => (arr.length ? NR.math.median(arr) : NaN);
    return {
      hr: med(session.hrBuf),
      rmssd: med(session.rmssdBuf),
      quality: ppg.meanQuality(),
    };
  }

  function snapshotGSR() {
    const med = (arr) => (arr.length ? NR.math.median(arr) : NaN);
    const live = gsr.snapshot();
    return {
      present: !!live.hasSignal || session.gsrArousalBuf.length > 0,
      arousal: med(session.gsrArousalBuf),
      tonic: med(session.gsrTonicBuf),
      reactivity: med(session.gsrReactivityBuf),
    };
  }

  // ---- Tasks ----------------------------------------------------------------
  async function runTasks() {
    const stage = el("#task-stage");
    session.collecting = "task";
    session.hrBuf = [];
    session.rmssdBuf = [];
    session.gsrArousalBuf = [];
    session.gsrTonicBuf = [];
    session.gsrReactivityBuf = [];

    // Tell the mock physiology we're now under cognitive load.
    NR.sensor.setLoad && NR.sensor.setLoad(0.8);

    const sequence = [
      { key: "pvt", Cls: NR.tasks.PVT },
      { key: "stroop", Cls: NR.tasks.Stroop },
      { key: "nback", Cls: NR.tasks.NBack },
    ];

    for (let i = 0; i < sequence.length; i++) {
      updateTaskProgress(i, sequence.length, sequence[i].key);
      const task = new sequence[i].Cls(stage);
      session.results[sequence[i].key] = await task.run();
      session.completedTasks++;
    }

    NR.sensor.setLoad && NR.sensor.setLoad(0.2);
    session.taskPPG = snapshotPPG();
    session.taskGSR = snapshotGSR();
    session.collecting = null;
    showResults();
  }

  function updateTaskProgress(idx, total, key) {
    const names = { pvt: "Reaction time", stroop: "Colour & word", nback: "2-back memory" };
    setText("#task-phase", `Task ${idx + 1} of ${total} · ${names[key]}`);
    NR.dom.all(".task-pip").forEach((pip, i) => {
      pip.classList.toggle("done", i < idx);
      pip.classList.toggle("active", i === idx);
    });
  }

  // ---- Results --------------------------------------------------------------
  let lastSavedId = null;

  function showResults() {
    const taskCompletion = session.completedTasks / 3;
    const s = NR.scores.compute({
      pvt: session.results.pvt,
      stroop: session.results.stroop,
      nback: session.results.nback,
      baselinePPG: session.baselinePPG,
      taskPPG: session.taskPPG,
      baselineGSR: session.baselineGSR,
      taskGSR: session.taskGSR,
      quality: ppg.meanQuality(),
      cleanFraction: motion.cleanFraction(),
      taskCompletion,
      mode: session.mode,
    });
    session.scores = s;
    recorder.stop();

    renderScoreCards(s);
    resetTagChips();
    saveCurrentSession(s); // persist (async, fire-and-forget)
    goto("results");
  }

  // Build a compact, chartable session record and store it.
  async function saveCurrentSession(s) {
    const tp = el("#tag-picker");
    if (session.guest) {
      lastSavedId = null;
      if (tp) tp.classList.add("hidden");
      const statusEl = el("#save-status");
      if (statusEl) statusEl.textContent = "Guest run — not saved to anyone's history.";
      return;
    }
    if (tp) tp.classList.remove("hidden");
    const val = (k) => (s[k] && isFinite(s[k].value) ? Math.round(s[k].value) : null);
    const num = (x) => (typeof x === "number" && isFinite(x) ? x : null);
    const rec = {
      profileId: NR.store.getActiveProfileId(),
      timestamp: Date.now(),
      mode: session.mode,
      readiness: NR.scores.composite(s),
      scores: {
        alertness: val("alertness"),
        cognitiveControl: val("cognitiveControl"),
        workingMemory: val("workingMemory"),
        physiologicalLoad: val("physiologicalLoad"),
        electrodermalArousal: val("electrodermalArousal"),
        dataConfidence: val("dataConfidence"),
      },
      taskMetrics: {
        pvt: session.results.pvt || null,
        stroop: session.results.stroop || null,
        nback: session.results.nback || null,
      },
      ppgSummary: {
        hrBaseline: num(session.baselinePPG && session.baselinePPG.hr),
        hrTask: num(session.taskPPG && session.taskPPG.hr),
        rmssdBaseline: num(session.baselinePPG && session.baselinePPG.rmssd),
        rmssdTask: num(session.taskPPG && session.taskPPG.rmssd),
        meanQuality: Math.round(ppg.meanQuality()),
      },
      gsrSummary: {
        present: !!(session.taskGSR && session.taskGSR.present),
        arousalBaseline: num(session.baselineGSR && session.baselineGSR.arousal),
        arousalTask: num(session.taskGSR && session.taskGSR.arousal),
        tonicTask: num(session.taskGSR && session.taskGSR.tonic),
        reactivityTask: num(session.taskGSR && session.taskGSR.reactivity),
      },
      arousalContext: s.arousalContext || null,
      motionClean: +motion.cleanFraction().toFixed(2),
      tags: [],
      notes: "",
    };
    try {
      const saved = await NR.store.addSession(rec);
      lastSavedId = saved.id;
      const prof = await NR.store.getActiveProfile();
      setText("#save-profile", prof ? prof.name : "history");
      setText("#save-status", "");
      const statusEl = el("#save-status");
      if (statusEl) statusEl.innerHTML = `Saved to <span id="save-profile">${prof ? prof.name : "history"}</span>`;
    } catch (e) {
      console.error("[NR] session save failed", e);
      const statusEl = el("#save-status");
      if (statusEl) statusEl.textContent = "Couldn't save (browser storage may be blocked on file:// — host it to persist).";
    }
  }

  function resetTagChips() {
    NR.dom.all(".tag-chip").forEach((c) => c.classList.remove("active"));
  }

  const CARD_DEFS = [
    { key: "alertness", label: "Alertness", sub: "PVT · sustained attention", invert: false },
    { key: "cognitiveControl", label: "Cognitive control", sub: "Stroop · inhibition", invert: false },
    { key: "workingMemory", label: "Working memory", sub: "2-back · d′", invert: false },
    { key: "physiologicalLoad", label: "Physiological load", sub: "HR + HRV proxy", invert: true },
    { key: "electrodermalArousal", label: "Electrodermal arousal", sub: "GSR · experimental", invert: true },
  ];

  function renderScoreCards(s) {
    const grid = el("#score-grid");
    grid.innerHTML = CARD_DEFS.map((d) => {
      const r = s[d.key];
      const v = r.value;
      const band = bandFor(v, d.invert);
      const display = isFinite(v) ? Math.round(v) : "—";
      return `
        <div class="score-card ${band}">
          <div class="score-card-head">
            <span class="score-label">${d.label}</span>
            <span class="score-sub">${d.sub}</span>
          </div>
          <div class="score-value">${display}<span class="score-max">/100</span></div>
          <div class="score-bar"><div class="score-bar-fill" style="width:${isFinite(v) ? v : 0}%"></div></div>
          <div class="score-why">${r.why}</div>
        </div>`;
    }).join("");

    const context = el("#arousal-context");
    const contextText = el("#arousal-context-text");
    if (context && contextText) {
      const ctx = s.arousalContext;
      context.classList.toggle("hidden", !ctx || !ctx.present);
      if (ctx && ctx.present) contextText.textContent = ctx.text;
    }

    // Confidence is rendered separately and prominently — it gates the rest.
    const c = s.dataConfidence;
    const cv = Math.round(c.value);
    el("#confidence-panel").className =
      "confidence-panel " + (cv >= 55 ? "good" : cv >= 30 ? "warn" : "bad");
    setText("#confidence-value", cv);
    setText("#confidence-why", c.why);
    const notes = el("#confidence-notes");
    notes.innerHTML = c.notes.length
      ? c.notes.map((n) => `<li>${n}</li>`).join("")
      : "<li>no quality flags raised</li>";

    const stats = recorder.stats();
    setText("#session-stats",
      `${stats.sampleCount.toLocaleString()} samples · ${stats.eventCount} task events · ${Math.round(stats.durationS)} s`);
  }

  function bandFor(v, invert) {
    if (!isFinite(v)) return "na";
    const good = invert ? v <= 35 : v >= 65;
    const mid = invert ? v <= 65 : v >= 40;
    return good ? "good" : mid ? "warn" : "bad";
  }

  // ===========================================================================
  //  ROUTING
  //  A small hash router sits on top of the imperative screen flow. Top-level
  //  views (#/check, #/history, #/faq) are linkable + back-button
  //  friendly; the capture sub-screens (fit/baseline/tasks/results) are driven
  //  imperatively by goto() *within* the check route — they are transient
  //  states of a live sensor, so they aren't deep-linkable on purpose.
  // ===========================================================================
  const ROUTES = { check: "setup", history: "history", faq: "faq" };
  // Which top-nav group each screen lights up.
  const NAV_GROUP = {
    setup: "check", fit: "check", baseline: "check", tasks: "check", results: "check",
    history: "history",
    faq: "faq",
  };

  function goto(screen) {
    if (screen !== "fit") stopFitGate();
    NR.dom.all(".screen").forEach((s) => hide(s));
    show(el(`#screen-${screen}`));
    // The live console belongs on the fit, baseline, and task screens.
    el("#console").classList.toggle("hidden", !(screen === "fit" || screen === "baseline" || screen === "tasks"));
    if (screen === "baseline") {
      el("#baseline-start").disabled = false;
      el("#baseline-skip").disabled = false;
    }
    if (screen === "history" && NR.history) NR.history.render();
    setNavActive(NAV_GROUP[screen] || "check");
    window.scrollTo(0, 0);
  }

  function setNavActive(group) {
    NR.dom.all(".nav-link").forEach((l) => l.classList.toggle("active", l.dataset.nav === group));
  }

  // Parse the current hash into a known route key (defaults to check).
  function routeFromHash() {
    const key = (location.hash || "").replace(/^#\/?/, "").toLowerCase();
    return ROUTES[key] ? key : "check";
  }

  // Render whatever the hash currently points at — never interrupts a capture.
  function applyRoute() {
    if (session.collecting) return; // never yank the user out of a live capture
    goto(ROUTES[routeFromHash()]);
  }

  // Navigate by setting the hash (so back/forward + deep links work). Falling
  // through to applyRoute() covers the "already on this hash" no-op case.
  function navigate(route) {
    const target = "#/" + route;
    if (location.hash === target) applyRoute();
    else location.hash = target;
  }

  // ---- Profiles & guest mode (W3) ------------------------------------------
  async function refreshProfileUI() {
    const profs = await NR.store.getProfiles();
    const active = await NR.store.getActiveProfile();
    const chip = el("#profile-chip");
    if (session.guest) {
      setText("#profile-avatar", "G");
      setText("#profile-name", "Guest");
      if (chip) chip.classList.add("guest");
    } else {
      setText("#profile-avatar", (active ? active.name : "?").slice(0, 1).toUpperCase());
      setText("#profile-name", active ? active.name : "—");
      if (chip) chip.classList.remove("guest");
    }
    setText("#subject-name", session.guest ? "Guest · won't be saved" : (active ? active.name : "—"));

    const list = el("#profile-list");
    if (list) {
      list.innerHTML = profs.map((p) => {
        const isActive = !session.guest && active && p.id === active.id;
        return `<div class="profile-row ${isActive ? "active" : ""}" data-id="${p.id}">
            <span class="avatar small">${p.name.slice(0, 1).toUpperCase()}</span>
            <span class="profile-row-name">${p.name}</span>
            ${isActive ? '<span class="profile-check">✓</span>' : ""}
            ${profs.length > 1 ? `<button class="profile-del" data-del="${p.id}" title="Delete person">×</button>` : ""}
          </div>`;
      }).join("");
      NR.dom.all(".profile-row", list).forEach((r) =>
        r.addEventListener("click", (e) => {
          if (e.target.closest(".profile-del")) return;
          switchProfile(r.dataset.id);
        })
      );
      NR.dom.all(".profile-del", list).forEach((b) =>
        b.addEventListener("click", async (e) => {
          e.stopPropagation();
          const p = profs.find((x) => x.id === b.dataset.del);
          if (!confirm(`Delete "${p.name}" and all of their saved sessions? This can't be undone.`)) return;
          await NR.store.deleteProfile(b.dataset.del);
          await refreshProfileUI();
          if (!el("#screen-history").classList.contains("hidden")) NR.history.render();
        })
      );
    }
  }

  async function switchProfile(id) {
    session.guest = false;
    NR.store.setActiveProfileId(id);
    closeProfileMenu();
    await refreshProfileUI();
    if (!el("#screen-history").classList.contains("hidden")) NR.history.render();
  }

  async function addProfileFlow() {
    const name = (prompt("Name for the new person:") || "").trim();
    if (!name) return;
    const p = await NR.store.addProfile(name);
    session.guest = false;
    NR.store.setActiveProfileId(p.id);
    closeProfileMenu();
    await refreshProfileUI();
  }

  function enableGuest() {
    session.guest = true;
    closeProfileMenu();
    refreshProfileUI();
  }

  const toggleProfileMenu = () => el("#profile-menu").classList.toggle("hidden");
  const closeProfileMenu = () => el("#profile-menu").classList.add("hidden");

  function restart() {
    ppg.reset();
    motion.reset();
    session.baselinePPG = null;
    session.taskPPG = null;
    session.results = {};
    session.scores = null;
    session.completedTasks = 0;
    session.collecting = null;
    goto("fit");
    startFitGate();
  }

  // ---- small helpers --------------------------------------------------------
  function setText(sel, txt) { const n = el(sel); if (n) n.textContent = txt; }

  // ===========================================================================
  //  BIND UI
  // ===========================================================================
  function bind() {
    NR.store.init().then(refreshProfileUI); // open datastore, ensure default profile, paint chip

    const sourceLabel = el("#source-mode-label");
    const sourceDetail = el("#source-mode-detail");
    const sourcePrivacyNote = el("#source-privacy-note");
    const connectBtn = el("#connect-btn");
    if (sensorSource === "serial") {
      if (sourceLabel) sourceLabel.textContent = "Live sensor mode.";
      if (sourceDetail) sourceDetail.textContent = "Chrome will ask you to select the connected ESP32 serial port.";
      if (sourcePrivacyNote) sourcePrivacyNote.innerHTML = "Live sensor mode reads the connected ESP32 directly in your browser. <strong>No account, no upload:</strong> session data stays on your device.";
      if (connectBtn) connectBtn.textContent = "Connect sensor & check fit";
    } else {
      if (sourceLabel) sourceLabel.textContent = "Simulated demo mode.";
      if (sourceDetail) sourceDetail.textContent = "Synthetic sensor data will demonstrate the complete workflow.";
      if (sourcePrivacyNote) sourcePrivacyNote.innerHTML = "Demo mode uses a simulated pulse, motion and arousal stream. <strong>No account, no upload:</strong> session data stays on your device.";
      if (connectBtn) connectBtn.textContent = "Start demo & check fit";
    }

    connectBtn.addEventListener("click", connect);
    NR.dom.all(".mode-btn").forEach((b) =>
      b.addEventListener("click", () => setMode(b.dataset.mode))
    );

    // Fit gate.
    el("#fit-continue").addEventListener("click", () => {
      stopFitGate();
      recorder.start(); // record from the baseline onward (not the fit fiddling)
      goto("baseline");
    });
    el("#fit-back").addEventListener("click", () => navigate("check"));

    el("#baseline-start").addEventListener("click", startBaseline);
    el("#baseline-skip").addEventListener("click", () => {
      if (baselineTimer) clearInterval(baselineTimer);
      // A short skip still grabs a brief baseline so load math has a reference.
      session.baselinePPG = snapshotPPG();
      session.collecting = null;
      goto("tasks");
      runTasks();
    });
    el("#export-btn").addEventListener("click", () => recorder.exportAll());
    el("#restart-btn").addEventListener("click", restart);
    el("#view-history-btn").addEventListener("click", () => navigate("history"));

    // Context tags on the results screen — update the just-saved record.
    NR.dom.all(".tag-chip").forEach((chip) =>
      chip.addEventListener("click", async () => {
        chip.classList.toggle("active");
        const tags = NR.dom.all(".tag-chip")
          .filter((c) => c.classList.contains("active"))
          .map((c) => c.dataset.tag);
        if (lastSavedId) await NR.store.updateSession(lastSavedId, { tags });
      })
    );

    // Top nav + any in-page [data-nav] button.
    NR.dom.all("[data-nav]").forEach((l) =>
      l.addEventListener("click", () => navigate(l.dataset.nav))
    );

    // History toolbar.
    el("#history-start-check").addEventListener("click", () => navigate("check"));
    el("#history-export").addEventListener("click", () => NR.store.downloadExport());
    el("#history-import-btn").addEventListener("click", () => el("#history-import").click());
    el("#history-import").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const res = await NR.store.importData(data);
        alert(`Imported ${res.sessions} session(s) across ${res.profiles} profile(s).`);
        NR.history.render();
      } catch (err) {
        alert("Import failed: " + err.message);
      }
      e.target.value = "";
    });
    el("#history-clear").addEventListener("click", async () => {
      if (!confirm("Delete ALL saved profiles and sessions? This cannot be undone.")) return;
      await NR.store.clearAll();
      NR.history.render();
    });

    // Profiles & guest mode.
    el("#profile-chip").addEventListener("click", (e) => { e.stopPropagation(); toggleProfileMenu(); });
    el("#subject-switch").addEventListener("click", (e) => { e.stopPropagation(); toggleProfileMenu(); });
    el("#add-profile-btn").addEventListener("click", addProfileFlow);
    el("#guest-mode-btn").addEventListener("click", enableGuest);
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".profile-ctl")) closeProfileMenu();
    });

    // Mock-only demo affordance: prove the confidence system reacts to motion.
    const motionBtn = el("#sim-motion");
    if (NR.sensor.kind === "mock") {
      motionBtn.addEventListener("click", () => NR.sensor.injectMotion(1800, 1.0));
    } else {
      hide(motionBtn);
    }

    setMode("finger");

    // Hash router: render the current route now, and on every hash change.
    window.addEventListener("hashchange", applyRoute);
    if (!location.hash || routeFromHash() !== (location.hash || "").replace(/^#\/?/, "").toLowerCase()) {
      location.hash = "#/check"; // default app route; landing owns the overview.
    }
    applyRoute();
  }

  document.addEventListener("DOMContentLoaded", bind);
  console.log("[NR] app loaded");
})();

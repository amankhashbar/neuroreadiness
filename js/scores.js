/* =============================================================
   NeuroReadiness — scores.js
   Turns raw metrics into six 0–100 readouts:
       alertness, cognitiveControl, workingMemory,
       physiologicalLoad, electrodermalArousal, dataConfidence

   IMPORTANT: every formula here is a transparent heuristic, not a
   validated clinical instrument. The cutoffs are documented inline so
   a reviewer can see exactly how each number is produced — and the
   confidence score exists precisely so nobody over-reads the rest.
   ============================================================= */
(function () {
  "use strict";
  const NR = window.NR;
  const M = NR.math;

  function alertness(pvt) {
    if (!pvt || !pvt.trials) return { value: NaN, why: "no PVT data" };
    // Fast, consistent responses with no lapses → high alertness.
    // Mapping: 220 ms → 100, 500 ms → 0 (typical alert vs. drowsy band).
    const rtScore = M.remap(pvt.meanRT, 220, 500, 100, 0);
    const lapsePenalty = pvt.lapses * 8;       // each lapse is costly
    const fsPenalty = pvt.falseStarts * 5;     // impulsive errors
    const cvPenalty = M.remap(pvt.rtCV, 0.1, 0.4, 0, 25); // instability
    const value = M.clamp(rtScore - lapsePenalty - fsPenalty - cvPenalty);
    return {
      value,
      why: `mean RT ${Math.round(pvt.meanRT)} ms, ${pvt.lapses} lapse(s), ` +
           `${pvt.falseStarts} false start(s)`,
    };
  }

  function cognitiveControl(stroop) {
    if (!stroop || !stroop.trials) return { value: NaN, why: "no Stroop data" };
    // Smaller interference + high accuracy → stronger inhibitory control.
    // Mapping: 0 ms interference → 100, 200 ms → 0.
    const interfScore = M.remap(stroop.interference, 0, 200, 100, 0);
    const value = M.clamp(interfScore * stroop.accuracy);
    return {
      value,
      why: `interference ${Math.round(stroop.interference)} ms, ` +
           `accuracy ${Math.round(stroop.accuracy * 100)}%`,
    };
  }

  function workingMemory(nback) {
    if (!nback || !nback.trials) return { value: NaN, why: "no 2-back data" };
    // Use d-prime (sensitivity) as the backbone, blended with raw accuracy.
    // d' of 0 → chance, d' of ~3 → near-ceiling discrimination.
    const dScore = M.remap(nback.dPrime, 0, 3, 0, 100);
    const accScore = M.remap(nback.accuracy, 0.5, 1.0, 0, 100);
    const value = M.clamp(0.6 * dScore + 0.4 * accScore);
    return {
      value,
      why: `d′ ${nback.dPrime.toFixed(2)}, accuracy ${Math.round(nback.accuracy * 100)}%, ` +
           `${nback.falseAlarms} false alarm(s)`,
    };
  }

  function physiologicalLoad(baseline, task) {
    // Higher = more load. Driven by HR elevation + HRV (RMSSD) suppression
    // relative to the resting baseline. This is a coarse autonomic proxy.
    if (!baseline || isNaN(baseline.hr) || !task || isNaN(task.hr)) {
      return { value: NaN, why: "insufficient PPG for load estimate" };
    }
    const hrDelta = task.hr - baseline.hr;
    const loadHR = M.remap(hrDelta, 0, 25, 0, 100); // +25 bpm → full
    let loadHRV = 0;
    if (baseline.rmssd > 0 && !isNaN(task.rmssd)) {
      const drop = (baseline.rmssd - task.rmssd) / baseline.rmssd;
      loadHRV = M.remap(drop, 0, 0.6, 0, 100); // 60% RMSSD drop → full
    }
    const value = M.clamp(0.5 * loadHR + 0.5 * loadHRV);
    return {
      value,
      why: `HR ${Math.round(baseline.hr)}→${Math.round(task.hr)} bpm, ` +
           `RMSSD proxy ${Math.round(baseline.rmssd)}→${Math.round(task.rmssd)} ms`,
    };
  }

  function electrodermalArousal(baseline, task) {
    if (!task || !task.present || !isFinite(task.arousal)) {
      return { value: NaN, why: "GSR not present" };
    }
    const taskArousal = task.arousal;
    const delta = baseline && isFinite(baseline.arousal) ? taskArousal - baseline.arousal : NaN;
    const deltaPart = isFinite(delta) ? M.remap(delta, -5, 25, -10, 25) : 0;
    const value = M.clamp(taskArousal + deltaPart);
    return {
      value,
      why: isFinite(delta)
        ? `task arousal ${Math.round(taskArousal)}, ${delta >= 0 ? "+" : ""}${Math.round(delta)} vs baseline`
        : `task arousal ${Math.round(taskArousal)}; no baseline GSR`,
    };
  }

  function arousalContext(scores) {
    const g = scores.electrodermalArousal && scores.electrodermalArousal.value;
    if (!isFinite(g)) return { present: false, text: "" };

    const readiness = NR.scores.composite(scores);
    const load = scores.physiologicalLoad && scores.physiologicalLoad.value;
    let text;
    if (isFinite(readiness) && readiness < 55 && g >= 65) {
      text = "Performance dipped while electrodermal arousal was elevated. That pattern can fit stress or over-arousal better than simple fatigue, but it is not diagnostic.";
    } else if (isFinite(readiness) && readiness < 55 && g < 45 && (!isFinite(load) || load < 55)) {
      text = "Performance dipped without elevated electrodermal arousal. Fatigue or under-recovery is a plausible context to track against sleep, workout and schedule notes.";
    } else if (g >= 65) {
      text = "Electrodermal arousal was elevated during the tasks. Read the cognitive scores with that sympathetic-activation context in mind.";
    } else {
      text = "Electrodermal arousal stayed in a moderate range. Use it as context alongside readiness, not as a standalone stress score.";
    }
    return { present: true, text };
  }

  // The keystone score. If this is low, treat everything else as indicative
  // only. Built from mean signal quality, motion-clean fraction, and how much
  // of the protocol actually completed.
  function dataConfidence({ meanQuality, cleanFraction, taskCompletion, mode }) {
    const sq = meanQuality;                       // 0–100, from ppg.js
    const motion = cleanFraction * 100;           // 0–100
    const completion = taskCompletion * 100;      // 0–100
    let value = M.clamp(0.55 * sq + 0.25 * motion + 0.20 * completion);
    // Temple/forehead PPG is an unvalidated, superficial-perfusion mode —
    // it is intrinsically noisier, so confidence is capped to keep the
    // claim honest no matter how clean the trace happens to look.
    const notes = [];
    if (mode === "temple") {
      value = Math.min(value, 65);
      notes.push("temple mode is experimental — superficial perfusion only, not cerebral blood flow");
    }
    if (sq < 40) notes.push("low perfusion / weak PPG");
    if (motion < 70) notes.push("motion detected during capture");
    if (completion < 100) notes.push("protocol partially completed");
    return {
      value,
      why: `signal ${Math.round(sq)}, motion-clean ${Math.round(motion)}%, ` +
           `completion ${Math.round(completion)}%`,
      notes,
    };
  }

  NR.scores = {
    // A single transparent "readiness" headline for trend tracking. It's a
    // weighted blend of the three cognitive scores (alertness weighted most,
    // since PVT is the most state-sensitive and practice-resistant). Returns
    // NaN if no cognitive scores are available. Physiological load and data
    // confidence are deliberately kept OUT of this number and shown alongside
    // it instead — load is context, confidence is a gate, neither is "readiness".
    composite(s) {
      if (!s) return NaN;
      const parts = [
        { v: s.alertness && s.alertness.value, w: 0.4 },
        { v: s.cognitiveControl && s.cognitiveControl.value, w: 0.3 },
        { v: s.workingMemory && s.workingMemory.value, w: 0.3 },
      ].filter((p) => typeof p.v === "number" && isFinite(p.v));
      if (!parts.length) return NaN;
      const wsum = parts.reduce((a, p) => a + p.w, 0);
      return Math.round(parts.reduce((a, p) => a + p.v * p.w, 0) / wsum);
    },

    compute({ pvt, stroop, nback, baselinePPG, taskPPG, baselineGSR, taskGSR, quality, cleanFraction, taskCompletion, mode }) {
      const scores = {
        alertness: alertness(pvt),
        cognitiveControl: cognitiveControl(stroop),
        workingMemory: workingMemory(nback),
        physiologicalLoad: physiologicalLoad(baselinePPG, taskPPG),
        electrodermalArousal: electrodermalArousal(baselineGSR, taskGSR),
        dataConfidence: dataConfidence({
          meanQuality: quality,
          cleanFraction,
          taskCompletion,
          mode,
        }),
      };
      scores.arousalContext = arousalContext(scores);
      return scores;
    },
  };
  console.log("[NR] scores loaded");
})();

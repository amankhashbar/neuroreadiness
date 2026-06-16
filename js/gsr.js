/* =============================================================
   NeuroReadiness — gsr.js
   Electrodermal / skin-conductance processing.

   GSR is treated honestly as a sympathetic-arousal proxy. It does not read
   emotion, stress, truthfulness, diagnosis, brain activity, or recovery by
   itself. It adds context around performance and PPG.
   ============================================================= */
(function () {
  "use strict";
  const NR = window.NR;
  const M = NR.math;
  const SR = NR.config.SAMPLE_RATE_HZ;

  class GSRProcessor {
    constructor() {
      this.recentArousal = new M.RingBuffer(SR * 8);
      this.reset();
    }

    reset() {
      this.raw = NaN;
      this.conductance = NaN;
      this.tonic = NaN;
      this.fast = NaN;
      this.reactivity = NaN;
      this.arousal = NaN;
      this.hasSignal = false;
      this.recentArousal = new M.RingBuffer(SR * 8);
    }

    onSample(s) {
      const raw = Number(s.gsr);
      if (!Number.isFinite(raw)) {
        this.hasSignal = false;
        NR.bus.emit("gsr", this.snapshot());
        return;
      }

      this.raw = raw;
      this.hasSignal = true;
      const conductance = this._toMicroSiemens(raw);
      this.conductance = conductance;

      const slowAlpha = 1 / (SR * 10);
      const fastAlpha = 1 / (SR * 1.2);
      this.tonic = Number.isFinite(this.tonic)
        ? this.tonic + slowAlpha * (conductance - this.tonic)
        : conductance;
      this.fast = Number.isFinite(this.fast)
        ? this.fast + fastAlpha * (conductance - this.fast)
        : conductance;
      this.reactivity = Math.max(0, this.fast - this.tonic);

      const tonicScore = M.remap(this.tonic, 1.0, 11.0, 10, 75);
      const reactivityScore = M.remap(this.reactivity, 0.0, 1.8, 0, 25);
      this.arousal = M.clamp(tonicScore + reactivityScore);
      this.recentArousal.push(this.arousal);

      NR.bus.emit("gsr", this.snapshot());
    }

    _toMicroSiemens(raw) {
      // MockSensor emits microsiemens. Firmware emits a raw 12-bit ADC count.
      // The ADC conversion is deliberately labelled approximate because the
      // CJMCU-6701 module is not factory-calibrated per user.
      if (raw <= 40) return raw;
      return M.remap(raw, 0, 4095, 0.2, 20.0);
    }

    meanArousal() {
      const arr = this.recentArousal.toArray();
      return arr.length ? M.mean(arr) : NaN;
    }

    snapshot() {
      return {
        hasSignal: this.hasSignal,
        raw: this.raw,
        conductance: this.conductance,
        tonic: this.tonic,
        reactivity: this.reactivity,
        arousal: this.arousal,
        meanArousal: this.meanArousal(),
      };
    }
  }

  NR.GSRProcessor = GSRProcessor;
  console.log("[NR] gsr loaded");
})();

/* =============================================================
   NeuroReadiness — csv.js
   Records the whole session so it can leave the browser:
     • every raw sample (the physiological stream)
     • every task event (stimuli + responses, with timestamps)
   Exports two CSVs with a shared clock so a NeuroKit2 / HeartPy
   notebook can re-derive HR, HRV and event-locked responses offline.
   The in-browser pipeline is the live demo; the CSV is the rigour.
   ============================================================= */
(function () {
  "use strict";
  const NR = window.NR;

  class Recorder {
    constructor() {
      this.samples = [];
      this.events = [];
      this.recording = false;
      this.sessionStart = null;
      NR.bus.on("sample", (s) => { if (this.recording) this.samples.push(s); });
      NR.bus.on("task:event", (e) => { if (this.recording) this.events.push(e); });
    }

    start() {
      this.samples = [];
      this.events = [];
      this.recording = true;
      this.sessionStart = new Date().toISOString();
    }
    stop() { this.recording = false; }

    _download(filename, text) {
      const blob = new Blob([text], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    exportSamples() {
      const rows = ["t_ms,red,ir,ax,ay,az,gsr"];
      for (const s of this.samples) {
        rows.push(`${s.t},${s.red},${s.ir},${s.ax},${s.ay},${s.az},${Number.isFinite(s.gsr) ? s.gsr : ""}`);
      }
      this._download(`neuroreadiness_signal_${this._stamp()}.csv`, rows.join("\n"));
    }

    exportEvents() {
      // Long format: one row per event, varying fields flattened to JSON.
      const rows = ["t_ms,type,detail"];
      for (const e of this.events) {
        const { t, type, ...rest } = e;
        rows.push(`${t},${type},"${JSON.stringify(rest).replace(/"/g, "'")}"`);
      }
      this._download(`neuroreadiness_events_${this._stamp()}.csv`, rows.join("\n"));
    }

    exportAll() {
      this.exportSamples();
      setTimeout(() => this.exportEvents(), 150); // stagger so both downloads fire
    }

    _stamp() {
      return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    }

    stats() {
      return {
        sampleCount: this.samples.length,
        eventCount: this.events.length,
        durationS: this.samples.length
          ? (this.samples[this.samples.length - 1].t - this.samples[0].t) / 1000
          : 0,
      };
    }
  }

  NR.Recorder = Recorder;
  console.log("[NR] csv loaded");
})();

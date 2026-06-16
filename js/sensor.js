/* =============================================================
   NeuroReadiness — sensor.js
   Shared sensor-source contract for simulated and live streams.

   Both MockSensor and SerialSensor emit the exact same event:
       NR.bus.emit("sample", { t, red, ir, ax, ay, az, gsr })
   ...at NR.config.SAMPLE_RATE_HZ. Every analytics/UI module listens
   to "sample" and neither knows nor cares where the data came from.

   The source is selected from the app URL. Firmware in /firmware emits the
   CSV protocol consumed by SerialSensor.
   ============================================================= */
(function () {
  "use strict";
  const NR = window.NR;
  const { randn } = NR.math;
  const SR = NR.config.SAMPLE_RATE_HZ;

  // --- Base class: defines the contract ------------------------------------
  class SensorSource {
    constructor() {
      this.running = false;
      this.kind = "base";
    }
    async start() { throw new Error("not implemented"); }
    async stop() { throw new Error("not implemented"); }
    // Subclasses call this to publish one sample.
    _emit(sample) {
      NR.bus.emit("sample", sample);
    }
  }

  /* ===========================================================
     MockSensor — synthetic MAX30102-style red/IR PPG + MPU6050 motion.
     Modelled so the demo looks and behaves like real hardware:
       - heart rate with slow drift + respiratory sinus arrhythmia (HRV)
       - a two-lobe pulse shape (systolic peak + dicrotic notch)
       - IR DC > red DC, like the real sensor
       - baseline wander from respiration
       - injectable motion artifacts (so we can show the confidence
         system reacting — that's the whole point of the product)
     Cognitive load is wired in: during tasks HR rises and HRV falls,
     which is what the physiological-load score keys off.
     =========================================================== */
  class MockSensor extends SensorSource {
    constructor() {
      super();
      this.kind = "mock";
      this.phase = 0;       // cardiac phase in [0,1)
      this.respPhase = 0;   // respiration phase
      this.t0 = 0;
      this.lastEmit = 0;
      this.timer = null;

      // Physiological state (mutated by setLoad()).
      this.hrTarget = 64;   // bpm
      this.hr = 64;
      this.hrvAmp = 1.0;    // 1 = relaxed (high HRV), →0 under load
      this.motionUntil = 0; // timestamp; motion artifact active until then
      this.motionMag = 0;
      this.perfusionScale = 1.0; // 1 = finger; temple mode weakens this
      this.mode = "finger";
      this.loadLevel = 0;
      this.gsrTarget = 4.2; // microsiemens, synthetic electrodermal conductance
      this.gsrTonic = 4.2;
      this.gsrFast = 4.2;
    }

    // "finger" gives a strong clean PPG; "temple" mimics the weak, noisy
    // superficial-perfusion signal you actually get at the forehead — so the
    // confidence system visibly reacts and the demo stays honest.
    setMode(mode) {
      this.mode = mode;
      this.perfusionScale = mode === "temple" ? 0.45 : 1.0;
    }

    // Called by the app when entering/leaving cognitive tasks so the
    // synthetic physiology responds to "workload" realistically.
    setLoad(level /* 0..1 */) {
      this.loadLevel = level;
      this.hrTarget = 62 + level * 26;     // 62 → 88 bpm
      this.hrvAmp = 1.0 - level * 0.65;    // relaxed → suppressed HRV
      this.gsrTarget = 4.2 + level * 4.5;   // higher sympathetic arousal under load
    }

    // Simulate the user bumping/adjusting the headband. The confidence
    // meter should visibly drop while this is active.
    injectMotion(durationMs = 1500, magnitude = 0.9) {
      this.motionUntil = performance.now() + durationMs;
      this.motionMag = magnitude;
    }

    async start() {
      if (this.running) return;
      this.running = true;
      this.t0 = performance.now();
      this.lastEmit = this.t0;
      NR.bus.emit("sensor:status", { kind: this.kind, connected: true });

      const dt = 1 / SR; // seconds per sample
      // Drive with a coarse timer but generate every sample that is "due"
      // based on real elapsed time, so the stream stays at SR even if the
      // timer is throttled. Timestamps come out clean.
      const tick = () => {
        if (!this.running) return;
        const now = performance.now();
        const due = Math.floor(((now - this.lastEmit) / 1000) * SR);
        for (let i = 0; i < due; i++) {
          this.lastEmit += (1000 / SR);
          this._step(dt, this.lastEmit - this.t0);
        }
        this.timer = setTimeout(tick, 1000 / SR);
      };
      tick();
    }

    _step(dt, tMs) {
      // Ease HR toward target; add slow sinusoidal drift.
      this.hr += (this.hrTarget - this.hr) * 0.02;
      const drift = 2 * Math.sin((tMs / 1000) * 0.05 * 2 * Math.PI);

      // Respiration ~0.25 Hz drives both baseline wander and RSA (HRV).
      this.respPhase = (this.respPhase + 0.25 * dt) % 1;
      const resp = Math.sin(this.respPhase * 2 * Math.PI);
      const instHr = this.hr + drift + resp * 4 * this.hrvAmp; // RSA

      // Advance cardiac phase.
      const f = instHr / 60; // Hz
      this.phase = (this.phase + f * dt) % 1;

      // Two-lobe pulse: systolic upstroke + smaller dicrotic wave.
      const p = this.phase;
      const systolic = Math.exp(-Math.pow((p - 0.18) / 0.07, 2));
      const dicrotic = 0.35 * Math.exp(-Math.pow((p - 0.45) / 0.10, 2));
      const pulse = systolic + dicrotic; // ~0..1.35

      // DC + AC. IR carries more DC than red (typical MAX30102 behaviour).
      const irDC = 118000, redDC = 92000;
      const irAC = 2600 * this.perfusionScale, redAC = 1700 * this.perfusionScale;
      const wander = resp * 600; // respiration-induced baseline drift
      // Temple mode adds extra superficial noise on top of the weaker pulse.
      const extraNoise = this.mode === "temple" ? 110 : 0;

      // Motion artifact: large, irregular excursions + accelerometer spikes.
      let motion = 0;
      let ax = randn() * 0.01, ay = randn() * 0.01, az = 1 + randn() * 0.01;
      if (performance.now() < this.motionUntil) {
        const burst = (Math.sin(tMs * 0.05) + randn() * 0.6) * this.motionMag;
        motion = burst * 5000;
        ax += burst * 0.8;
        ay += burst * 0.5;
        az += burst * 0.3;
      }

      // Electrodermal activity changes slowly. The mock stream models tonic
      // conductance in microsiemens plus a small task-linked phasic rise.
      this.gsrTonic += (this.gsrTarget - this.gsrTonic) * 0.006;
      const phasic = this.loadLevel * Math.max(0, Math.sin((tMs / 1000) * 0.035 * 2 * Math.PI)) * 0.7;
      this.gsrFast += (this.gsrTonic + phasic - this.gsrFast) * 0.03;
      const gsr = Math.max(0.2, this.gsrFast + randn() * 0.04 + Math.abs(motion) / 40000);

      const ir = irDC + irAC * pulse + wander + motion + randn() * (120 + extraNoise);
      const red = redDC + redAC * pulse + wander * 0.8 + motion * 0.8 + randn() * (110 + extraNoise);

      this._emit({
        t: Math.round(tMs),
        red: Math.round(red),
        ir: Math.round(ir),
        ax: +ax.toFixed(3),
        ay: +ay.toFixed(3),
        az: +az.toFixed(3),
        gsr: +gsr.toFixed(3),
      });
    }

    async stop() {
      this.running = false;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      NR.bus.emit("sensor:status", { kind: this.kind, connected: false });
    }
  }

  /* ===========================================================
     SerialSensor — real ESP32 over Web Serial (Chromium only).
     Expects newline-delimited CSV lines from the firmware:
         t_ms,red,ir,ax,ay,az,gsr
     Lines that don't start with a digit are ignored (so the firmware
     can print a "# NRDY,2" banner or debug text harmlessly).
     The 7th GSR column is optional: v1 firmware streams still work.
     This is wired and ready; it just needs the board plugged in.
     =========================================================== */
  class SerialSensor extends SensorSource {
    constructor() {
      super();
      this.kind = "serial";
      this.port = null;
      this.reader = null;
      this._buf = "";
      this._t0 = null;
    }

    async start() {
      if (!("serial" in navigator)) {
        throw new Error(
          "Web Serial is not available. Use Chrome or Edge (desktop), served over https or localhost."
        );
      }
      // Must be triggered by a user gesture (button click) — the browser
      // shows its port picker here.
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: NR.config.SERIAL_BAUD });
      this.running = true;
      NR.bus.emit("sensor:status", { kind: this.kind, connected: true });
      this._readLoop();
    }

    async _readLoop() {
      const decoder = new TextDecoderStream();
      this.port.readable.pipeTo(decoder.writable).catch(() => {});
      this.reader = decoder.readable.getReader();
      try {
        while (this.running) {
          const { value, done } = await this.reader.read();
          if (done) break;
          this._buf += value;
          let nl;
          while ((nl = this._buf.indexOf("\n")) >= 0) {
            const line = this._buf.slice(0, nl).trim();
            this._buf = this._buf.slice(nl + 1);
            this._parseLine(line);
          }
        }
      } catch (e) {
        console.error("[serial] read error", e);
      }
    }

    _parseLine(line) {
      if (!line || !/^\d/.test(line)) return; // ignore banners/debug
      const parts = line.split(",");
      if (parts.length < 3) return;
      const [t, red, ir, ax, ay, az, gsr] = parts.map(Number);
      if ([t, red, ir].some(Number.isNaN)) return;
      if (this._t0 == null) this._t0 = t;
      this._emit({
        t: t - this._t0,
        red, ir,
        ax: ax || 0, ay: ay || 0, az: az || 0,
        gsr: Number.isFinite(gsr) ? gsr : NaN,
      });
    }

    async stop() {
      this.running = false;
      try { if (this.reader) await this.reader.cancel(); } catch (e) {}
      try { if (this.port) await this.port.close(); } catch (e) {}
      this.reader = null;
      this.port = null;
      NR.bus.emit("sensor:status", { kind: this.kind, connected: false });
    }
  }

  NR.SensorSource = SensorSource;
  NR.MockSensor = MockSensor;
  NR.SerialSensor = SerialSensor;
  console.log("[NR] sensor loaded");
})();

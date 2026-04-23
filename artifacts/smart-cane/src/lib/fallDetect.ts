// Phone-based fall detection using DeviceMotion.
//
// Algorithm (jerk + impact):
//   1. Track the magnitude of total acceleration (|a|, m/s²) at every
//      devicemotion sample (~60 Hz on Android).
//   2. Compute the instantaneous "jerk" — the rate of change of |a|
//      between samples (m/s³). A real fall (or being thrown) causes a
//      sudden, hard change. A slow lift (e.g. picking the phone up off a
//      table) has a tiny jerk even though |a| temporarily rises.
//   3. Fire the alert when in a short window (PEAK_WINDOW_MS) we see BOTH
//      a peak |a| above IMPACT_HIGH AND a peak jerk above JERK_HIGH.
//   4. After firing, suppress for COOLDOWN_MS so a single tumble doesn't
//      spawn a stream of alerts.
//
// Sensitivity is adjustable from the Settings page (1 = most sensitive,
// 10 = least sensitive). Setting 5 is the default.

const PEAK_WINDOW_MS = 350;     // peaks must co-occur within this window
const COOLDOWN_MS    = 6000;
const SAMPLE_MIN_DT  = 0.005;   // clamp dt to avoid huge jerk on stutters

// Sensitivity 1 (most) → 10 (least).
//   sensitivity 1  → impact >= 16 m/s² (~1.6 g),  jerk >=  80 m/s³
//   sensitivity 5  → impact >= 22 m/s² (~2.2 g),  jerk >= 140 m/s³  (default)
//   sensitivity 10 → impact >= 32 m/s² (~3.3 g),  jerk >= 240 m/s³
function thresholdsFor(sensitivity: number): { impact: number; jerk: number } {
  const s = Math.max(1, Math.min(10, sensitivity));
  const t = (s - 1) / 9;                // 0..1
  return {
    impact: 16 + 16 * t,                // 16 → 32
    jerk:   80 + 160 * t,               // 80 → 240
  };
}

type FallListener = () => void;

interface MotionLike {
  accelerationIncludingGravity?: { x: number | null; y: number | null; z: number | null } | null;
  acceleration?: { x: number | null; y: number | null; z: number | null } | null;
}

export class FallDetector {
  private listeners: FallListener[] = [];
  private armed = false;
  private suppressed = false;
  private sensitivity = 5;
  private lastFiredAt = 0;
  private lastSampleT = 0;
  private lastMag = 9.8;
  private peakMag = 0;
  private peakJerk = 0;
  private windowStart = 0;

  constructor(sensitivity = 5) {
    this.sensitivity = sensitivity;
  }

  setSensitivity(s: number) {
    this.sensitivity = Math.max(1, Math.min(10, s));
  }

  private onMotion = (e: Event) => {
    const m = e as unknown as MotionLike;
    // Prefer linear acceleration (no gravity), fall back to total.
    const usedLinear = !!(m.acceleration && m.acceleration.x != null);
    const src = usedLinear ? m.acceleration! : m.accelerationIncludingGravity;
    if (!src || src.x == null || src.y == null || src.z == null) return;

    const ax = src.x as number, ay = src.y as number, az = src.z as number;
    let mag = Math.sqrt(ax * ax + ay * ay + az * az);
    // If gravity is baked in, subtract a static 1g so the "resting"
    // magnitude is ~0 and impact spikes are unambiguous.
    if (!usedLinear) {
      mag = Math.abs(mag - 9.8);
    }

    const now = performance.now();
    if (this.suppressed) { this.lastSampleT = now; this.lastMag = mag; return; }
    if (now - this.lastFiredAt < COOLDOWN_MS) { this.lastSampleT = now; this.lastMag = mag; return; }

    const dt = this.lastSampleT === 0 ? SAMPLE_MIN_DT : Math.max(SAMPLE_MIN_DT, (now - this.lastSampleT) / 1000);
    const jerk = Math.abs(mag - this.lastMag) / dt;
    this.lastSampleT = now;
    this.lastMag = mag;

    const { impact, jerk: jerkThresh } = thresholdsFor(this.sensitivity);

    // Open / refresh the peak window.
    if (this.windowStart === 0 || now - this.windowStart > PEAK_WINDOW_MS) {
      this.windowStart = now;
      this.peakMag = 0;
      this.peakJerk = 0;
    }
    if (mag  > this.peakMag)  this.peakMag  = mag;
    if (jerk > this.peakJerk) this.peakJerk = jerk;

    if (this.peakMag >= impact && this.peakJerk >= jerkThresh) {
      this.lastFiredAt = now;
      this.windowStart = 0;
      this.peakMag = 0;
      this.peakJerk = 0;
      for (const fn of this.listeners) {
        try { fn(); } catch { /* swallow */ }
      }
    }
  };

  async start(): Promise<boolean> {
    if (this.armed) return true;
    if (typeof window === "undefined") return false;

    // iOS gate
    const anyEv = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
    if (anyEv?.requestPermission) {
      try {
        const r = await anyEv.requestPermission();
        if (r !== "granted") return false;
      } catch { /* ignore */ }
    }

    window.addEventListener("devicemotion", this.onMotion);
    this.armed = true;
    return true;
  }

  stop() {
    if (!this.armed) return;
    window.removeEventListener("devicemotion", this.onMotion);
    this.armed = false;
    this.windowStart = 0;
    this.peakMag = 0;
    this.peakJerk = 0;
    this.lastSampleT = 0;
  }

  setSuppressed(s: boolean) {
    this.suppressed = s;
    if (s) {
      this.windowStart = 0;
      this.peakMag = 0;
      this.peakJerk = 0;
    }
  }

  onFall(fn: FallListener): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }
}

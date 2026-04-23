// Phone-based fall detection using DeviceMotion.
//
// Heuristic (simple but robust enough for a 48h prototype):
//   1. Watch the magnitude of acceleration (m/s^2). Earth gravity is ~9.8.
//   2. We require a "free-fall-ish" dip below 4 m/s^2 OR a sharp impact
//      spike above 25 m/s^2 — falls usually have one or both.
//   3. After the trigger we check stillness: if the |a-g| stays under 1.5
//      for at least IMPACT_STILLNESS_MS (default 800 ms), call it a fall.
//
// Triggering twice within COOLDOWN_MS is suppressed so a single tumble
// doesn't fire ten alerts in a row.
//
// We listen to either:
//   - "devicemotion" (iOS/most Android browsers)
//   - Capacitor "@capacitor/motion" plugin if available (better on Android)
//
// Permissions: iOS Safari requires DeviceMotionEvent.requestPermission()
// after a user gesture. We try silently — if it throws we just skip iOS.

const IMPACT_HIGH        = 25;   // m/s^2
const FREEFALL_LOW       = 4;    // m/s^2 — magnitude well below 1g
const STILLNESS_BAND     = 1.5;  // |a - g| while still
const STILLNESS_MS       = 900;  // must remain still this long after impact
const POST_IMPACT_WINDOW = 1500; // we have this long to confirm stillness
const COOLDOWN_MS        = 6000; // ignore re-triggers in this window

type FallListener = () => void;

interface MotionLike {
  accelerationIncludingGravity?: { x: number | null; y: number | null; z: number | null } | null;
  acceleration?: { x: number | null; y: number | null; z: number | null } | null;
}

export class FallDetector {
  private listeners: FallListener[] = [];
  private armed = false;
  private impactAt = 0;
  private stillSince = 0;
  private lastFiredAt = 0;
  private suppressed = false;

  private onMotion = (e: Event) => {
    const m = e as unknown as MotionLike;
    const g = m.accelerationIncludingGravity;
    if (!g || g.x == null || g.y == null || g.z == null) return;
    const ax = g.x as number, ay = g.y as number, az = g.z as number;
    const mag = Math.sqrt(ax * ax + ay * ay + az * az);
    const now = performance.now();

    if (this.suppressed) return;
    if (now - this.lastFiredAt < COOLDOWN_MS) return;

    // Trigger a "watch window" on freefall or hard impact.
    if (this.impactAt === 0) {
      if (mag < FREEFALL_LOW || mag > IMPACT_HIGH) {
        this.impactAt = now;
        this.stillSince = 0;
      }
      return;
    }

    // Inside the window: look for stillness near 1g.
    const offset = Math.abs(mag - 9.8);
    if (offset < STILLNESS_BAND) {
      if (this.stillSince === 0) this.stillSince = now;
      if (now - this.stillSince >= STILLNESS_MS) {
        // Confirmed.
        this.lastFiredAt = now;
        this.impactAt = 0;
        this.stillSince = 0;
        for (const fn of this.listeners) {
          try { fn(); } catch { /* swallow */ }
        }
      }
    } else {
      // Too much motion — restart stillness clock.
      this.stillSince = 0;
    }

    // Window expired — no stillness, probably a false alarm (e.g. running).
    if (now - this.impactAt > POST_IMPACT_WINDOW) {
      this.impactAt = 0;
      this.stillSince = 0;
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
    this.impactAt = 0;
    this.stillSince = 0;
  }

  // Pause detection while a fall alert is active so we don't re-fire.
  setSuppressed(s: boolean) {
    this.suppressed = s;
    if (s) {
      this.impactAt = 0;
      this.stillSince = 0;
    }
  }

  onFall(fn: FallListener): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }
}

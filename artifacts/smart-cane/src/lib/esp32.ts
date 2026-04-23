/**
 * IntelliCane ESP32-CAM client.
 *
 * The ESP32 firmware (see attached_assets/IntelliCane) exposes:
 *   GET /            — MJPEG stream (rendered as <img src=...>)
 *   GET /frame.jpg   — single JPEG snapshot
 *   GET /sensors     — JSON with the latest Nano reading
 *   GET /sos         — JSON; returns the SOS press once then clears
 *
 * There is no WebSocket on the device, so this client polls /sensors at
 * ~10 Hz and /sos at ~1 Hz. The "connected" state means the last /sensors
 * poll succeeded (HTTP 200 + parseable JSON).
 */

export interface SensorReading {
  front: number;
  fl: number;     // front-left
  fr: number;     // front-right
  left: number;   // alias kept for the rest of the app
  right: number;  // alias kept for the rest of the app
  side: number;
  ground: number;
  alert: number;
  ts: number;
  age_ms?: number;
}

export type ButtonEventType = "sos" | "call1" | "call2" | "ack";

export interface SosEvent {
  type: ButtonEventType;
  time: number;   // ms since ESP32 boot
  receivedAt: number;
}

export type ConnState = "disconnected" | "connecting" | "connected" | "error";

type SensorListener = (reading: SensorReading) => void;
type StateListener  = (state: ConnState) => void;
type SosListener    = (evt: SosEvent) => void;

// Polling rates are deliberately conservative because the ESP32 httpd
// has only ~13 sockets and is also serving a long-lived MJPEG stream
// to the same phone. Hammering /sensors at 10 Hz used to fill the
// socket pool within seconds, after which fetches started erroring
// (errno 104 in the ESP-IDF logs), the JS flipped to state="error",
// the <img> unmounted, and the user got the "connect to IntelliCane
// WiFi" screen even though the SoftAP was still up.
const SENSOR_POLL_MS = 250;   // 4 Hz — plenty for distance UI.
const SOS_POLL_MS    = 700;   // ~1.4 Hz — catches even short presses.
const SENSOR_FAIL_BACKOFF_MS = 1500;
// We only flip to "error" after a sustained string of failures so a
// single dropped poll (e.g. the camera tab swap) doesn't blow away
// the live feed.
const SENSOR_FAIL_ERROR_THRESHOLD = 8;

export class ESP32Client {
  private host: string;
  private sensorListeners: SensorListener[] = [];
  private stateListeners:  StateListener[]  = [];
  private sosListeners:    SosListener[]    = [];
  private state: ConnState = "disconnected";
  private sensorTimer: number | null = null;
  private sosTimer:    number | null = null;
  private running = false;
  private failCount = 0;

  constructor(host: string) {
    this.host = host.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  get streamUrl(): string {
    // Root URL serves MJPEG in the IntelliCane firmware.
    return `http://${this.host}/`;
  }

  get snapshotUrl(): string {
    return `http://${this.host}/frame.jpg?t=${Date.now()}`;
  }

  get connectionState(): ConnState {
    return this.state;
  }

  get hostname(): string {
    return this.host;
  }

  // POST /vibrate?on=1|0 — tells the Nano (via ESP32 UART) to drive the
  // vibration motor non-stop, used during a suspected-fall countdown.
  async setVibrate(on: boolean): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const tid = window.setTimeout(() => ctrl.abort(), 1500);
      const resp = await fetch(`http://${this.host}/vibrate?on=${on ? 1 : 0}`, {
        method: "POST",
        cache: "no-store",
        signal: ctrl.signal,
      });
      window.clearTimeout(tid);
      return resp.ok;
    } catch {
      return false;
    }
  }

  connect() {
    if (this.running) return;
    this.running = true;
    this.setState("connecting");
    this.scheduleSensorPoll(0);
    this.scheduleSosPoll(SOS_POLL_MS);
  }

  disconnect() {
    this.running = false;
    if (this.sensorTimer !== null) { window.clearTimeout(this.sensorTimer); this.sensorTimer = null; }
    if (this.sosTimer !== null)    { window.clearTimeout(this.sosTimer);    this.sosTimer    = null; }
    this.setState("disconnected");
  }

  onSensor(fn: SensorListener): () => void {
    this.sensorListeners.push(fn);
    return () => { this.sensorListeners = this.sensorListeners.filter(l => l !== fn); };
  }

  onState(fn: StateListener): () => void {
    this.stateListeners.push(fn);
    fn(this.state);
    return () => { this.stateListeners = this.stateListeners.filter(l => l !== fn); };
  }

  onSos(fn: SosListener): () => void {
    this.sosListeners.push(fn);
    return () => { this.sosListeners = this.sosListeners.filter(l => l !== fn); };
  }

  private setState(s: ConnState) {
    if (this.state === s) return;
    this.state = s;
    for (const fn of this.stateListeners) fn(s);
  }

  private scheduleSensorPoll(delay: number) {
    if (!this.running) return;
    if (this.sensorTimer !== null) window.clearTimeout(this.sensorTimer);
    this.sensorTimer = window.setTimeout(() => this.pollSensors(), delay);
  }

  private scheduleSosPoll(delay: number) {
    if (!this.running) return;
    if (this.sosTimer !== null) window.clearTimeout(this.sosTimer);
    this.sosTimer = window.setTimeout(() => this.pollSos(), delay);
  }

  private async pollSensors() {
    try {
      const ctrl = new AbortController();
      const tid = window.setTimeout(() => ctrl.abort(), 1500);
      const resp = await fetch(`http://${this.host}/sensors`, {
        cache: "no-store",
        signal: ctrl.signal,
      });
      window.clearTimeout(tid);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = await resp.json();
      this.failCount = 0;
      this.setState("connected");

      if (body && body.data && typeof body.data === "object") {
        const d = body.data;
        const reading: SensorReading = {
          front:  num(d.front),
          fl:     num(d.fl),
          fr:     num(d.fr),
          side:   num(d.side),
          left:   num(d.fl),   // alias for downstream code
          right:  num(d.fr),   // alias for downstream code
          ground: num(d.ground),
          alert:  d.alert ? 1 : 0,
          ts:     Date.now(),
          age_ms: typeof body.age_ms === "number" ? body.age_ms : undefined,
        };
        for (const fn of this.sensorListeners) fn(reading);
      }
      // body.status === "idle" — Nano has not sent anything yet, just loop.
    } catch {
      this.failCount++;
      if (this.failCount >= SENSOR_FAIL_ERROR_THRESHOLD) this.setState("error");
    } finally {
      const delay = this.failCount > 0 ? SENSOR_FAIL_BACKOFF_MS : SENSOR_POLL_MS;
      this.scheduleSensorPoll(delay);
    }
  }

  private async pollSos() {
    try {
      const ctrl = new AbortController();
      const tid = window.setTimeout(() => ctrl.abort(), 1500);
      const resp = await fetch(`http://${this.host}/sos`, {
        cache: "no-store",
        signal: ctrl.signal,
      });
      window.clearTimeout(tid);
      if (resp.ok) {
        const body = await resp.json();
        if (body && typeof body.type === "string" && body.type !== "idle") {
          const t = body.type as ButtonEventType;
          if (t === "sos" || t === "call1" || t === "call2" || t === "ack") {
            const evt: SosEvent = {
              type: t,
              time: typeof body.time === "number" ? body.time : Date.now(),
              receivedAt: Date.now(),
            };
            for (const fn of this.sosListeners) fn(evt);
          }
        }
      }
    } catch {
      // network blip is fine; we'll try again next tick.
    } finally {
      this.scheduleSosPoll(SOS_POLL_MS);
    }
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : -1;
}

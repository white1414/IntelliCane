import { createContext, useContext, useEffect, useState, useRef, ReactNode, useCallback } from "react";
import { ESP32Client, SensorReading, ConnState, SosEvent } from "@/lib/esp32";
import {
  getHost, getGuardianPhone, getUserName,
  getPerson1Phone, getPerson2Phone, getFallDetectEnabled,
  getFallSensitivity,
} from "@/lib/settings";
import { announceObstacle, speakUrgent } from "@/lib/tts";
import { getLocationOnce, googleMapsLink } from "@/lib/geo";
import { sendSms, buildSosMessage, placeCall } from "@/lib/sms";
import { FallDetector } from "@/lib/fallDetect";

export interface SosOutcome {
  ok: boolean;
  message: string;
  mapsLink?: string;
}

export interface FallAlertState {
  active: boolean;
  startedAt: number;   // performance.now() basis
  totalMs: number;
  remainingMs: number;
}

interface SmartCaneContextValue {
  client: ESP32Client | null;
  state: ConnState;
  latestSensor: SensorReading | null;
  sensorLog: SensorReading[];
  audioMuted: boolean;
  setAudioMuted: (muted: boolean) => void;
  reconnect: () => void;
  lastSos: SosEvent | null;
  lastSosOutcome: SosOutcome | null;
  triggerSos: (opts?: { alsoCall?: boolean; kind?: "sos" | "fall" }) => Promise<SosOutcome>;
  fallAlert: FallAlertState;
  cancelFallAlert: () => void;
  // Manual debug trigger for the fall flow (used by Settings → Test).
  simulateFall: () => void;
}

const SmartCaneContext = createContext<SmartCaneContextValue | undefined>(undefined);

const FALL_COUNTDOWN_MS = 25_000;

export function SmartCaneProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<ESP32Client | null>(null);
  const [state, setState] = useState<ConnState>("disconnected");
  const [latestSensor, setLatestSensor] = useState<SensorReading | null>(null);
  const [sensorLog, setSensorLog] = useState<SensorReading[]>([]);
  const [audioMuted, setAudioMuted] = useState(false);
  const [lastSos, setLastSos] = useState<SosEvent | null>(null);
  const [lastSosOutcome, setLastSosOutcome] = useState<SosOutcome | null>(null);
  const [fallAlert, setFallAlert] = useState<FallAlertState>({
    active: false, startedAt: 0, totalMs: FALL_COUNTDOWN_MS, remainingMs: 0,
  });

  const lastObstacleAnnounce = useRef<{ dir: string; time: number } | null>(null);
  const audioMutedRef = useRef(audioMuted);
  audioMutedRef.current = audioMuted;
  const sosInFlight = useRef(false);
  const clientRef = useRef<ESP32Client | null>(null);
  const fallTimerRef = useRef<number | null>(null);
  const fallTickRef  = useRef<number | null>(null);
  const fallActiveRef = useRef(false);
  const fallDetectorRef = useRef<FallDetector | null>(null);

  const triggerSos = useCallback(async (opts?: { alsoCall?: boolean; kind?: "sos" | "fall" }): Promise<SosOutcome> => {
    const alsoCall = opts?.alsoCall ?? false;
    const kind = opts?.kind ?? "sos";
    if (sosInFlight.current) {
      return { ok: false, message: "SOS already in progress." };
    }
    sosInFlight.current = true;
    try {
      const phone = getGuardianPhone();
      if (!phone) {
        const out: SosOutcome = {
          ok: false,
          message: "No guardian phone number set. Open Settings to add one.",
        };
        setLastSosOutcome(out);
        speakUrgent("Danger detected. No guardian number set.");
        return out;
      }

      if (kind === "fall") {
        speakUrgent("Sending fall alert and calling guardian.");
      } else {
        speakUrgent(alsoCall ? "Sending S O S and calling guardian." : "Sending S O S to guardian.");
      }

      let mapsLink = "(location unavailable)";
      try {
        const fix = await getLocationOnce(8000);
        mapsLink = googleMapsLink(fix.lat, fix.lng);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "unknown";
        speakUrgent(`Could not get location. Sending without it.`);
        mapsLink = `(location unavailable: ${reason})`;
      }

      const body = buildSosMessage({ userName: getUserName(), mapsLink, kind });
      const result = await sendSms(phone, body);

      let smsMsg: string;
      let smsOk: boolean;
      if (result.sent) {
        smsMsg = kind === "fall" ? "Fall alert sent to guardian." : "SOS sent to guardian.";
        smsOk = true;
      } else if (result.openedComposer) {
        smsMsg = "Opened your SMS app — tap Send to dispatch.";
        smsOk = true;
      } else {
        smsMsg = result.error ?? "Failed to send SOS.";
        smsOk = false;
      }

      let callMsg = "";
      let callOk = true;
      if (alsoCall) {
        // SOS / fall calls always force speakerphone + max volume so the
        // user can hear hands-free even if the phone is in their pocket.
        const callRes = await placeCall(phone, { speakerOn: true, maxVolume: true });
        if (callRes.placed) {
          callMsg = " Calling guardian now.";
        } else if (callRes.openedDialer) {
          callMsg = " Dialer opened — tap call.";
        } else {
          callMsg = ` Call failed: ${callRes.error ?? "unknown"}.`;
          callOk = false;
        }
      }

      const out: SosOutcome = {
        ok: smsOk && callOk,
        message: smsMsg + callMsg,
        mapsLink,
      };

      if (smsOk && (!alsoCall || callOk)) {
        speakUrgent(alsoCall ? "S O S sent. Calling guardian." : "S O S sent.");
      } else if (!smsOk && alsoCall && callOk) {
        speakUrgent("Message failed, calling guardian.");
      } else {
        speakUrgent("S O S send failed.");
      }

      setLastSosOutcome(out);
      return out;
    } finally {
      sosInFlight.current = false;
    }
  }, []);

  // ------------- Speed dial helpers -------------
  const speedDial = useCallback(async (which: "person1" | "person2") => {
    const phone = which === "person1" ? getPerson1Phone() : getPerson2Phone();
    const label = which === "person1" ? "Person 1" : "Person 2";
    if (!phone) {
      speakUrgent(`No number set for ${label}.`);
      return;
    }
    speakUrgent(`Calling ${label}.`);
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(60);
    await placeCall(phone, { speakerOn: true, maxVolume: true });
  }, []);

  // ------------- Fall alert flow -------------
  const stopVibrate = useCallback(() => {
    const c = clientRef.current;
    if (c) { void c.setVibrate(false); }
  }, []);

  const cancelFallAlert = useCallback(() => {
    if (!fallActiveRef.current) return;
    fallActiveRef.current = false;
    if (fallTimerRef.current !== null) { clearTimeout(fallTimerRef.current); fallTimerRef.current = null; }
    if (fallTickRef.current  !== null) { clearInterval(fallTickRef.current);  fallTickRef.current  = null; }
    stopVibrate();
    fallDetectorRef.current?.setSuppressed(false);
    setFallAlert({ active: false, startedAt: 0, totalMs: FALL_COUNTDOWN_MS, remainingMs: 0 });
    speakUrgent("Fall alert cancelled. Glad you are okay.");
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([0, 60, 60, 60]);
  }, [stopVibrate]);

  const startFallAlert = useCallback(() => {
    if (fallActiveRef.current) return;
    fallActiveRef.current = true;
    fallDetectorRef.current?.setSuppressed(true);

    // Tell the cane to vibrate non-stop.
    const c = clientRef.current;
    if (c) { void c.setVibrate(true); }

    // Big, distinctive phone buzz so user knows the alert started.
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate([0, 400, 120, 400, 120, 400]);
    }
    speakUrgent("Possible fall detected. Press the cane button or the I'm OK button if you are okay. Otherwise help will be called in 25 seconds.");

    const startedAt = performance.now();
    setFallAlert({ active: true, startedAt, totalMs: FALL_COUNTDOWN_MS, remainingMs: FALL_COUNTDOWN_MS });

    fallTickRef.current = window.setInterval(() => {
      const remaining = Math.max(0, FALL_COUNTDOWN_MS - (performance.now() - startedAt));
      setFallAlert((prev) => prev.active ? { ...prev, remainingMs: remaining } : prev);
    }, 250);

    fallTimerRef.current = window.setTimeout(async () => {
      // Time's up — fire fall SOS + call.
      fallTimerRef.current = null;
      if (!fallActiveRef.current) return;
      fallActiveRef.current = false;
      if (fallTickRef.current !== null) { clearInterval(fallTickRef.current); fallTickRef.current = null; }
      setFallAlert({ active: false, startedAt: 0, totalMs: FALL_COUNTDOWN_MS, remainingMs: 0 });
      stopVibrate();
      fallDetectorRef.current?.setSuppressed(false);
      await triggerSos({ alsoCall: true, kind: "fall" });
    }, FALL_COUNTDOWN_MS);
  }, [stopVibrate, triggerSos]);

  const simulateFall = useCallback(() => { startFallAlert(); }, [startFallAlert]);

  // ------------- Connection / event wiring -------------
  const initClient = useCallback(() => {
    setClient((prev) => {
      if (prev) prev.disconnect();
      const host = getHost();
      const c = new ESP32Client(host);
      clientRef.current = c;

      c.onState((s) => setState(s));

      c.onSensor((reading) => {
        setLatestSensor(reading);
        setSensorLog((prevLog) => [reading, ...prevLog].slice(0, 20));

        if (audioMutedRef.current) return;

        let nearestDir: "front" | "left" | "right" | null = null;
        let minDist = Infinity;
        const check = (dist: number, dir: "front" | "left" | "right") => {
          if (dist > 0 && dist < 80 && dist < minDist) {
            minDist = dist;
            nearestDir = dir;
          }
        };
        check(reading.front, "front");
        check(reading.fl, "left");
        check(reading.fr, "right");

        if (nearestDir) {
          const now = Date.now();
          const last = lastObstacleAnnounce.current;
          if (!last || last.dir !== nearestDir || now - last.time > 4000) {
            announceObstacle(minDist, nearestDir);
            lastObstacleAnnounce.current = { dir: nearestDir, time: now };
          }
        }
      });

      c.onSos((evt) => {
        setLastSos(evt);
        switch (evt.type) {
          case "sos":
            // Long-hold panic. If a fall alert is active, treat it as a
            // confirmation cancel instead — the user is conscious.
            if (fallActiveRef.current) {
              cancelFallAlert();
            } else {
              triggerSos({ alsoCall: true });
            }
            break;
          case "ack":
            // Single click. Cancels an active fall countdown; otherwise
            // we still announce it so the user gets audible confirmation
            // that the cane button (or a wire-to-GND test) is reaching
            // the app — useful when bench-testing the GPIO15 hookup.
            if (fallActiveRef.current) {
              cancelFallAlert();
            } else {
              speakUrgent("Cane button received.");
            }
            break;
          case "call1":
            if (fallActiveRef.current) cancelFallAlert();
            else void speedDial("person1");
            break;
          case "call2":
            if (fallActiveRef.current) cancelFallAlert();
            else void speedDial("person2");
            break;
        }
      });

      c.connect();
      return c;
    });
  }, [triggerSos, speedDial, cancelFallAlert]);

  // Mount: connect ESP32 client + arm fall detector.
  useEffect(() => {
    initClient();
    if (getFallDetectEnabled()) {
      const fd = new FallDetector(getFallSensitivity());
      fallDetectorRef.current = fd;
      fd.onFall(() => startFallAlert());
      void fd.start();
    }
    return () => {
      fallDetectorRef.current?.stop();
      if (fallTimerRef.current !== null) clearTimeout(fallTimerRef.current);
      if (fallTickRef.current  !== null) clearInterval(fallTickRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SmartCaneContext.Provider
      value={{
        client,
        state,
        latestSensor,
        sensorLog,
        audioMuted,
        setAudioMuted,
        reconnect: initClient,
        lastSos,
        lastSosOutcome,
        triggerSos,
        fallAlert,
        cancelFallAlert,
        simulateFall,
      }}
    >
      {children}
    </SmartCaneContext.Provider>
  );
}

export function useSmartCane() {
  const ctx = useContext(SmartCaneContext);
  if (!ctx) throw new Error("useSmartCane must be used within SmartCaneProvider");
  return ctx;
}

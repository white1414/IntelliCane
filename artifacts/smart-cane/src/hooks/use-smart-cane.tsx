import { createContext, useContext, useEffect, useState, useRef, ReactNode, useCallback } from "react";
import { ESP32Client, SensorReading, ConnState, SosEvent } from "@/lib/esp32";
import { getHost, getGuardianPhone, getUserName } from "@/lib/settings";
import { announceObstacle, speakUrgent } from "@/lib/tts";
import { getLocationOnce, googleMapsLink } from "@/lib/geo";
import { sendSms, buildSosMessage } from "@/lib/sms";

export interface SosOutcome {
  ok: boolean;
  message: string;
  mapsLink?: string;
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
  triggerSos: () => Promise<SosOutcome>;
}

const SmartCaneContext = createContext<SmartCaneContextValue | undefined>(undefined);

export function SmartCaneProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<ESP32Client | null>(null);
  const [state, setState] = useState<ConnState>("disconnected");
  const [latestSensor, setLatestSensor] = useState<SensorReading | null>(null);
  const [sensorLog, setSensorLog] = useState<SensorReading[]>([]);
  const [audioMuted, setAudioMuted] = useState(false);
  const [lastSos, setLastSos] = useState<SosEvent | null>(null);
  const [lastSosOutcome, setLastSosOutcome] = useState<SosOutcome | null>(null);

  const lastObstacleAnnounce = useRef<{ dir: string; time: number } | null>(null);
  const audioMutedRef = useRef(audioMuted);
  audioMutedRef.current = audioMuted;
  const sosInFlight = useRef(false);

  const triggerSos = useCallback(async (): Promise<SosOutcome> => {
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

      speakUrgent("Sending S O S to guardian.");

      let mapsLink = "(location unavailable)";
      try {
        const fix = await getLocationOnce(8000);
        mapsLink = googleMapsLink(fix.lat, fix.lng);
      } catch (err) {
        // We still send the SMS — the message will just say location unavailable.
        const reason = err instanceof Error ? err.message : "unknown";
        speakUrgent(`Could not get location. Sending without it.`);
        mapsLink = `(location unavailable: ${reason})`;
      }

      const body = buildSosMessage({ userName: getUserName(), mapsLink });
      const result = await sendSms(phone, body);

      let out: SosOutcome;
      if (result.sent) {
        out = { ok: true, message: "SOS sent to guardian.", mapsLink };
        speakUrgent("S O S sent.");
      } else if (result.openedComposer) {
        out = {
          ok: true,
          message: "Opened your SMS app — tap Send to dispatch.",
          mapsLink,
        };
        speakUrgent("Opened messages. Please send.");
      } else {
        out = { ok: false, message: result.error ?? "Failed to send SOS.", mapsLink };
        speakUrgent("S O S send failed.");
      }
      setLastSosOutcome(out);
      return out;
    } finally {
      sosInFlight.current = false;
    }
  }, []);

  const initClient = useCallback(() => {
    setClient((prev) => {
      if (prev) prev.disconnect();
      const host = getHost();
      const c = new ESP32Client(host);

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
        // Fire and forget — UI subscribes to lastSosOutcome for the result.
        triggerSos();
      });

      c.connect();
      return c;
    });
  }, [triggerSos]);

  useEffect(() => {
    initClient();
    return () => {
      // captured in initClient closure; nothing to clean here directly
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

import { useState } from "react";
import { useSmartCane } from "@/hooks/use-smart-cane";
import { isModelLoaded } from "@/lib/yolo";
import { speakUrgent, ttsAvailable } from "@/lib/tts";
import { useWakeLock } from "@/lib/wakeLock";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { geolocationAvailable, getLocationOnce, googleMapsLink } from "@/lib/geo";
import { smsCapability } from "@/lib/sms";

export default function DiagnosticsPage() {
  const { state, sensorLog, client, lastSos, lastSosOutcome } = useSmartCane();
  const { supported: wakeLockSupported } = useWakeLock(false);
  const ttsOk = ttsAvailable();
  const geoOk = geolocationAvailable();
  const wsOk = typeof fetch !== "undefined";
  const sms = smsCapability();
  const [gpsResult, setGpsResult] = useState<string | null>(null);

  const handleTTSTest = () => {
    speakUrgent("IntelliCane test successful.");
  };

  const handleGpsTest = async () => {
    setGpsResult("Locating...");
    try {
      const fix = await getLocationOnce(8000);
      setGpsResult(`OK — ${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)} (±${Math.round(fix.accuracy)}m) → ${googleMapsLink(fix.lat, fix.lng)}`);
    } catch (e) {
      setGpsResult(`Failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  };

  return (
    <div className="p-4 flex flex-col gap-6 max-w-md mx-auto w-full">
      <div className="space-y-2">
        <h2 className="text-3xl font-bold">Diagnostics</h2>
        <p className="text-muted-foreground text-sm">Quick checks for sighted helpers.</p>
      </div>

      <div className="bg-card rounded-xl border border-border p-4 space-y-4">
        <h3 className="font-semibold text-lg border-b border-border pb-2">Browser Capabilities</h3>
        <ul className="space-y-3 text-sm">
          <li className="flex justify-between items-center">
            <span>Speech Synthesis (TTS)</span>
            <Badge variant={ttsOk ? "default" : "destructive"}>{ttsOk ? "OK" : "Missing"}</Badge>
          </li>
          <li className="flex justify-between items-center">
            <span>Screen Wake Lock</span>
            <Badge variant={wakeLockSupported ? "default" : "destructive"}>{wakeLockSupported ? "OK" : "Missing"}</Badge>
          </li>
          <li className="flex justify-between items-center">
            <span>Network (fetch)</span>
            <Badge variant={wsOk ? "default" : "destructive"}>{wsOk ? "OK" : "Missing"}</Badge>
          </li>
          <li className="flex justify-between items-center">
            <span>Geolocation</span>
            <Badge variant={geoOk ? "default" : "destructive"}>{geoOk ? "OK" : "Missing"}</Badge>
          </li>
          <li className="flex justify-between items-center">
            <span>SMS Capability</span>
            <Badge variant={sms === "none" ? "destructive" : "default"}>
              {sms === "native-silent" ? "Native silent" : sms === "composer" ? "Composer (PWA)" : "None"}
            </Badge>
          </li>
          <li className="flex justify-between items-center">
            <span>YOLO ONNX Model</span>
            <Badge variant={isModelLoaded() ? "default" : "secondary"}>
              {isModelLoaded() ? "Loaded" : "Not loaded yet"}
            </Badge>
          </li>
        </ul>
        <div className="flex gap-2">
          <Button onClick={handleTTSTest} variant="secondary" className="flex-1" data-testid="button-test-tts">Test TTS</Button>
          <Button onClick={handleGpsTest} variant="secondary" className="flex-1" data-testid="button-test-gps">Test GPS</Button>
        </div>
        {gpsResult && (
          <div className="bg-black text-green-400 font-mono text-[10px] p-3 rounded break-all">{gpsResult}</div>
        )}
      </div>

      <div className="bg-card rounded-xl border border-border p-4 space-y-4">
        <h3 className="font-semibold text-lg border-b border-border pb-2">Hardware Connection</h3>
        <div className="flex justify-between items-center">
          <span className="text-sm">Sensor poll state</span>
          <Badge variant={state === "connected" ? "default" : "secondary"}>{state}</Badge>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm">ESP32 host</span>
          <span className="font-mono text-xs">{client?.hostname ?? "—"}</span>
        </div>

        <div className="space-y-2">
          <span className="text-sm block">MJPEG stream</span>
          <div className="w-full aspect-video bg-black rounded-lg overflow-hidden flex items-center justify-center border border-border">
            {state === "connected" && client ? (
              <img src={client.streamUrl} crossOrigin="anonymous" className="w-full h-full object-contain" alt="Camera test stream" />
            ) : (
              <span className="text-muted-foreground text-xs font-mono">No stream</span>
            )}
          </div>
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border p-4 space-y-3">
        <h3 className="font-semibold text-lg border-b border-border pb-2">SOS</h3>
        <div className="flex justify-between text-sm">
          <span>Last button press received</span>
          <span className="font-mono text-xs">{lastSos ? new Date(lastSos.receivedAt).toLocaleTimeString() : "never"}</span>
        </div>
        {lastSosOutcome && (
          <div className={`text-xs p-3 rounded ${lastSosOutcome.ok ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive"}`}>
            {lastSosOutcome.message}
            {lastSosOutcome.mapsLink && (
              <div className="mt-1 break-all opacity-80">{lastSosOutcome.mapsLink}</div>
            )}
          </div>
        )}
      </div>

      <div className="bg-card rounded-xl border border-border p-4 space-y-4 flex-1 min-h-[300px] flex flex-col">
        <h3 className="font-semibold text-lg border-b border-border pb-2">Raw Sensor Feed (last 20)</h3>
        <div className="bg-black text-green-400 font-mono text-[10px] p-3 rounded flex-1 overflow-y-auto">
          {sensorLog.length === 0 ? (
            <span className="text-muted-foreground">Waiting for data from the cane...</span>
          ) : (
            sensorLog.map((log, i) => (
              <div key={log.ts + "-" + i} className="whitespace-pre-wrap mb-1">{JSON.stringify(log)}</div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

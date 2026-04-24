import { useEffect, useRef, useState } from "react";
import { useSmartCane } from "@/hooks/use-smart-cane";
import { isModelLoaded, getActiveBackend } from "@/lib/yolo";
import { speakUrgent, ttsAvailable, stopSpeaking } from "@/lib/tts";
import { useWakeLock } from "@/lib/wakeLock";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { geolocationAvailable, getLocationOnce, googleMapsLink } from "@/lib/geo";
import { smsCapability, placeCall } from "@/lib/sms";
import { getGuardianPhone } from "@/lib/settings";
import { useToast } from "@/hooks/use-toast";
import { ShieldAlert, Volume2, VolumeX, Phone, Hand, Flashlight } from "lucide-react";
import { ESP32Client, type SosEvent } from "@/lib/esp32";

// Snapshot preview that polls /frame.jpg directly. We don't reuse the
// home-page poller because that one lives inside the page; the
// diagnostics card needs its own self-contained refresher. Same fix
// as on home: crossOrigin="anonymous" so the WebView treats it as
// CORS-clean (the firmware sends ACAO:* on /frame.jpg).
function DiagnosticsSnapshot({ client, state }: { client: ESP32Client | null; state: string }) {
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (!client) return;
    const tick = () => { if (imgRef.current) imgRef.current.src = client.snapshotUrl; };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [client]);
  return (
    <div className="space-y-2">
      <span className="text-sm block">Camera snapshot (live, ~4 fps)</span>
      <div className="w-full aspect-video bg-black rounded-lg overflow-hidden flex items-center justify-center border border-border">
        {client ? (
          <img
            ref={imgRef}
            crossOrigin="anonymous"
            className="w-full h-full object-contain"
            alt="Camera test snapshot"
            data-testid="img-test-stream"
          />
        ) : (
          <span className="text-muted-foreground text-xs font-mono">No client ({state})</span>
        )}
      </div>
    </div>
  );
}

// Diagnostics is also where the SOS hold-button and the audio mute
// toggle now live (they used to be in the global header). The Active
// page is now distraction-free, and a sighted helper / judge can do
// every demo from this one screen.
export default function DiagnosticsPage() {
  const {
    state, sensorLog, client, lastSos, lastSosOutcome,
    audioMuted, setAudioMuted,
    triggerSos, simulateSos, sosHistory,
  } = useSmartCane();
  const { supported: wakeLockSupported } = useWakeLock(false);
  const { toast } = useToast();

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

  // ---- Audio mute toggle (was in header) ---------------------------------
  const toggleMute = () => {
    const newMuted = !audioMuted;
    setAudioMuted(newMuted);
    if (newMuted) {
      stopSpeaking();
      toast({ title: "Audio muted", description: "Voice announcements disabled." });
    } else {
      toast({ title: "Audio enabled", description: "Voice announcements enabled." });
    }
  };

  // ---- SOS hold-button (was in header) -----------------------------------
  // Press-and-hold semantics, identical to the old header button:
  //   < 900 ms      -> nothing (prevents pocket-misfires)
  //   ≥ 900 ms      -> send SMS to guardian with location
  //   ≥ 2000 ms     -> additionally place the emergency call
  const SMS_HOLD_MS = 900;
  const CALL_HOLD_MS = 2000;
  const smsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const smsFired = useRef(false);

  const fireSos = async (alsoCall: boolean) => {
    toast({
      title: alsoCall ? "Sending SOS + calling" : "Sending SOS",
      description: "Getting your location...",
    });
    const result = await triggerSos({ alsoCall });
    toast({
      title: result.ok ? (alsoCall ? "SOS sent + calling guardian" : "SOS triggered") : "SOS failed",
      description: result.message,
      variant: result.ok ? "default" : "destructive",
    });
  };

  const placeCallEscalation = async () => {
    const phone = getGuardianPhone();
    if (!phone) return;
    toast({ title: "Calling guardian", description: "Placing emergency call..." });
    const res = await placeCall(phone);
    toast({
      title: res.placed || res.openedDialer ? "Calling guardian" : "Call failed",
      description: res.placed
        ? "Call started."
        : res.openedDialer
        ? "Dialer opened — tap call."
        : res.error ?? "Unknown error.",
      variant: res.placed || res.openedDialer ? "default" : "destructive",
    });
  };

  const clearSosTimers = () => {
    if (smsTimer.current) { clearTimeout(smsTimer.current); smsTimer.current = null; }
    if (callTimer.current) { clearTimeout(callTimer.current); callTimer.current = null; }
  };

  const handleSosPressStart = () => {
    smsFired.current = false;
    clearSosTimers();
    smsTimer.current = setTimeout(() => {
      smsFired.current = true;
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(80);
      fireSos(false);
    }, SMS_HOLD_MS);
    callTimer.current = setTimeout(() => {
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([0, 200, 80, 200]);
      placeCallEscalation();
    }, CALL_HOLD_MS);
  };

  const handleSosPressEnd = () => clearSosTimers();
  const handleSosClick = () => { if (smsFired.current) smsFired.current = false; };

  // Pretty label for an SOS event row in the history list.
  const labelFor = (t: SosEvent["type"]) => {
    switch (t) {
      case "sos":   return "Long-hold SOS (text + call)";
      case "ack":   return "Single tap (ack / cancel)";
      case "call1": return "Speed-dial Person 1";
      case "call2": return "Speed-dial Person 2";
      case "led":   return "4-tap LED toggle";
    }
  };

  return (
    <div className="p-4 flex flex-col gap-6 max-w-md mx-auto w-full">
      <div className="space-y-2">
        <h2 className="text-3xl font-bold">Diagnostics</h2>
        <p className="text-muted-foreground text-sm">Quick checks for sighted helpers.</p>
      </div>

      {/* ---- SOS + Audio control panel (moved here from the header) ---- */}
      <div className="bg-card rounded-xl border border-border p-4 space-y-4">
        <h3 className="font-semibold text-lg border-b border-border pb-2">SOS &amp; Audio</h3>

        <div className="flex gap-3">
          <button
            onClick={handleSosClick}
            onMouseDown={handleSosPressStart}
            onMouseUp={handleSosPressEnd}
            onMouseLeave={handleSosPressEnd}
            onTouchStart={handleSosPressStart}
            onTouchEnd={handleSosPressEnd}
            onTouchCancel={handleSosPressEnd}
            onContextMenu={(e) => e.preventDefault()}
            className="flex-1 px-4 py-4 rounded-xl flex items-center justify-center gap-2 bg-destructive/15 text-destructive border border-destructive/30 active:scale-95 transition-transform font-bold select-none"
            aria-label="Send SOS to guardian. Hold for nearly one second to text. Keep holding for two seconds to also call."
            data-testid="button-sos-hold"
          >
            <ShieldAlert className="w-6 h-6" />
            <span>HOLD FOR SOS</span>
          </button>

          <button
            onClick={toggleMute}
            className={`px-4 py-4 rounded-xl flex items-center justify-center transition-colors ${
              audioMuted
                ? "bg-destructive/10 text-destructive border border-destructive/20"
                : "bg-primary/10 text-primary border border-primary/20"
            }`}
            aria-label={audioMuted ? "Unmute audio" : "Mute audio"}
            aria-pressed={!audioMuted}
            data-testid="button-mute"
          >
            {audioMuted ? <VolumeX className="w-6 h-6" /> : <Volume2 className="w-6 h-6" />}
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground -mt-1">
          Hold ≥ 0.9 s to text guardian, ≥ 2 s to also call. Short taps are ignored.
        </p>
      </div>

      {/* ---- Demo button-event simulators -------------------------------
          These bypass the physical cane button and inject a synthetic
          event into the same handler the real /sos poll uses. Lets you
          demo every mode without anyone touching the cane. */}
      <div className="bg-card rounded-xl border border-border p-4 space-y-3">
        <h3 className="font-semibold text-lg border-b border-border pb-2">Simulate cane button</h3>
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => simulateSos("ack")}   variant="secondary" data-testid="button-sim-ack">
            <Hand className="w-4 h-4 mr-2" /> Single tap
          </Button>
          <Button onClick={() => simulateSos("sos")}   variant="destructive" data-testid="button-sim-sos">
            <ShieldAlert className="w-4 h-4 mr-2" /> Long-hold SOS
          </Button>
          <Button onClick={() => simulateSos("call1")} variant="secondary" data-testid="button-sim-call1">
            <Phone className="w-4 h-4 mr-2" /> Speed-dial 1
          </Button>
          <Button onClick={() => simulateSos("call2")} variant="secondary" data-testid="button-sim-call2">
            <Phone className="w-4 h-4 mr-2" /> Speed-dial 2
          </Button>
          <Button onClick={() => simulateSos("led")} variant="secondary" className="col-span-2" data-testid="button-sim-led">
            <Flashlight className="w-4 h-4 mr-2" /> 4-tap LED toggle (simulated)
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Goes through the real handler — speech, fall-cancel, SMS, calls all behave exactly the same.
        </p>
      </div>

      {/* ---- Real hardware LED test --------------------------------------
          Calls GET /led?on=1|0 directly on the ESP32 so you can verify
          the white flash LED on GPIO 4 actually turns on, separately
          from the 4-click button path. */}
      <div className="bg-card rounded-xl border border-border p-4 space-y-3">
        <h3 className="font-semibold text-lg border-b border-border pb-2">Cane flashlight (hardware)</h3>
        <div className="grid grid-cols-2 gap-2">
          <Button
            onClick={async () => {
              if (!client) return;
              const ok = await client.setLed(true);
              toast({
                title: ok ? "Flashlight on" : "Flashlight command failed",
                description: ok ? "ESP32 GPIO 4 driven HIGH." : "Could not reach the cane.",
                variant: ok ? "default" : "destructive",
              });
            }}
            className="bg-primary text-primary-foreground"
            data-testid="button-led-on"
          >
            <Flashlight className="w-4 h-4 mr-2" /> Light ON
          </Button>
          <Button
            onClick={async () => {
              if (!client) return;
              const ok = await client.setLed(false);
              toast({
                title: ok ? "Flashlight off" : "Flashlight command failed",
                description: ok ? "ESP32 GPIO 4 driven LOW." : "Could not reach the cane.",
                variant: ok ? "default" : "destructive",
              });
            }}
            variant="secondary"
            data-testid="button-led-off"
          >
            <Flashlight className="w-4 h-4 mr-2" /> Light OFF
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Sends GET /led?on=1 / on=0 directly. Bypasses the 4-click handler.
        </p>
      </div>

      {/* ---- Last 5 cane-button events ---------------------------------- */}
      <div className="bg-card rounded-xl border border-border p-4 space-y-3">
        <h3 className="font-semibold text-lg border-b border-border pb-2">Last 5 button events</h3>
        {sosHistory.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No button events yet. Press the cane button or use a simulator above.</p>
        ) : (
          <ol className="space-y-2">
            {sosHistory.map((evt, i) => (
              <li
                key={`${evt.receivedAt}-${i}`}
                className="flex items-center justify-between gap-3 text-sm p-2 rounded-lg bg-background border border-border"
                data-testid={`row-sos-history-${i}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Badge
                    variant={evt.type === "sos" ? "destructive" : "secondary"}
                    className="shrink-0 font-mono uppercase"
                  >
                    {evt.type}
                  </Badge>
                  <span className="truncate">{labelFor(evt.type)}</span>
                </div>
                <span className="font-mono text-xs text-muted-foreground shrink-0">
                  {new Date(evt.receivedAt).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ol>
        )}
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
            <span>YOLO TFLite Model</span>
            <Badge variant={isModelLoaded() ? "default" : "secondary"}>
              {isModelLoaded() ? "Loaded" : "Not loaded yet"}
            </Badge>
          </li>
          <li className="flex justify-between items-center">
            <span>TF Backend (pre/post)</span>
            <Badge variant={getActiveBackend() === "webgpu" || getActiveBackend() === "webgl" ? "default" : "secondary"}>
              {getActiveBackend() === "webgpu" ? "WebGPU (GPU)" : getActiveBackend() === "webgl" ? "WebGL (GPU)" : getActiveBackend() === "wasm" ? "WASM (CPU)" : getActiveBackend() === "cpu" ? "CPU" : getActiveBackend()}
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

        <DiagnosticsSnapshot client={client} state={state} />
      </div>

      {/* End of HW connection card (snapshot inserted above). */}

      <div className="bg-card rounded-xl border border-border p-4 space-y-3">
        <h3 className="font-semibold text-lg border-b border-border pb-2">Latest SOS</h3>
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

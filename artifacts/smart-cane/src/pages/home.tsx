import { useEffect, useRef, useState } from "react";
import { ESP32Client } from "@/lib/esp32";
import { useSmartCane } from "@/hooks/use-smart-cane";
import { loadModel, detect, Detection, isModelLoaded, getActiveBackend } from "@/lib/yolo";
import { getConfThreshold, getTargetFps } from "@/lib/settings";
import { announceDetection } from "@/lib/tts";
import { useWakeLock } from "@/lib/wakeLock";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Play, Square, Loader2, WifiOff, Accessibility, Wifi } from "lucide-react";

export default function Home() {
  const { client, state, latestSensor, audioMuted } = useSmartCane();
  const [isRunning, setIsRunning] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  // Surfaced to the user as a banner. Without this, a model load
  // failure (e.g. Capacitor 404 on /yolo.tflite, or all tf-core
  // backends failing init) just leaves the START DETECTION button
  // greyed out forever with no on-screen explanation.
  const [modelError, setModelError] = useState<string | null>(null);
  // Most recent error from the per-frame detect() call. We log every
  // failure to console.warn but on Android there's no console — so we
  // also surface the latest one in the perf overlay.
  const [detectError, setDetectError] = useState<string | null>(null);
  // Number of detection ticks we've actually run since pressing Start.
  // If this stays at 0 while isRunning=true, the loop's image-ready
  // guard is failing — which means the <img> isn't decoding frames.
  const [tickCount, setTickCount] = useState(0);
  const [fps, setFps] = useState(0);
  const [infTime, setInfTime] = useState(0);
  // We rerender the "last contact" pill once per second so the seconds
  // counter ticks up live even when no fresh data is arriving — that's
  // exactly the situation we want the user (and the judge) to see.
  const [healthTick, setHealthTick] = useState(0);
  // Counter of MJPEG frames the WebView has actually decoded since
  // mount. If this stays at 0 while `state==="connected"` you know the
  // /sensors poll is fine but the stream socket on :81 is dead.
  const [frameCount, setFrameCount] = useState(0);
  // Live-feed strategy: poll /frame.jpg as JPEG snapshots at ~7 fps. The
  // multipart MJPEG <img> stream worked in desktop Chrome but was wildly
  // unreliable in the Capacitor Android WebView (some WebView builds
  // never fire onLoad per-frame, so detection saw naturalWidth=0 and
  // skipped every tick → 0 fps forever). Snapshot polling is ~5 KB/frame
  // over local WiFi, which is nothing, and the WebView fires onLoad
  // every time so the YOLO loop gets a fresh frame each tick.
  const SNAPSHOT_INTERVAL_MS = 140;

  const imgRef = useRef<HTMLImageElement>(null);
  const snapshotTimerRef = useRef<number | null>(null);
  const scratchCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const loopRef = useRef<number | null>(null);
  const lastDetectTime = useRef<number>(0);
  
  useWakeLock(isRunning);

  useEffect(() => {
    const id = window.setInterval(() => setHealthTick(t => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Snapshot poller — keeps a fresh JPEG flowing into <img>.
  //
  // CRITICAL: we *chain* the next request off the previous one's load /
  // error event. The naïve setInterval(140 ms) approach we tried first
  // is what caused the ESP-IDF log spam:
  //
  //   W httpd_txrx: httpd_sock_err: error in send : 104
  //   W httpd_uri:  httpd_uri: uri handler execution failed
  //
  // A JPEG over the ESP32's SoftAP takes ~200–500 ms to deliver. With
  // a fixed 140 ms timer we kept reassigning img.src while the previous
  // fetch was still in flight — the WebView immediately cancelled the
  // old TCP connection, the ESP32's send() returned ECONNRESET, the
  // /frame.jpg handler was reported as "execution failed", AND no
  // frame ever finished loading → img.naturalWidth stayed 0 → the YOLO
  // loop skipped every tick → "no object detection".
  //
  // Chaining via onLoad/onError guarantees AT MOST ONE in-flight
  // request per <img> at any time, which makes the ESP32 happy and
  // gives the model real frames to chew on.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    let backoffMs = 0;

    const requestNext = () => {
      if (cancelled) return;
      const img = imgRef.current;
      if (!img) {
        // <img> not mounted yet — try again shortly.
        snapshotTimerRef.current = window.setTimeout(requestNext, 100);
        return;
      }
      img.src = (client as ESP32Client).snapshotUrl;
    };

    // Bound to the <img>'s onLoad in JSX below: scheduleNextFrame() is
    // exposed via the ref through the onLoad handler in the snapshot-
    // chained handlers below. We can't attach listeners here cleanly
    // because React owns the element; instead we expose the chain via
    // window-scoped refs that the JSX onLoad/onError invoke.
    (window as unknown as { __icSnapNext?: () => void }).__icSnapNext = () => {
      if (cancelled) return;
      // Pace the next request slightly so we don't pin the WiFi at
      // 100% utilisation; ~7 fps is plenty for YOLO's needs.
      backoffMs = 0;
      snapshotTimerRef.current = window.setTimeout(requestNext, 80);
    };
    (window as unknown as { __icSnapErr?: () => void }).__icSnapErr = () => {
      if (cancelled) return;
      // Exponential backoff up to 2 s on errors so we don't DoS the cane
      // while it's struggling.
      backoffMs = Math.min(2000, backoffMs === 0 ? 250 : backoffMs * 2);
      snapshotTimerRef.current = window.setTimeout(requestNext, backoffMs);
    };

    requestNext();

    return () => {
      cancelled = true;
      if (snapshotTimerRef.current) {
        window.clearTimeout(snapshotTimerRef.current);
        snapshotTimerRef.current = null;
      }
      delete (window as unknown as { __icSnapNext?: () => void }).__icSnapNext;
      delete (window as unknown as { __icSnapErr?:  () => void }).__icSnapErr;
    };
  }, [client]);

  // Pre-load model
  useEffect(() => {
    if (!isModelLoaded()) {
      setModelLoading(true);
      setModelError(null);
      const url = import.meta.env.BASE_URL.replace(/\/$/, "") + "/yolo.tflite";
      loadModel(url).then(() => {
        setModelReady(true);
        setModelLoading(false);
      }).catch(e => {
        console.error("Failed to load model", e);
        // Surface a short message in the UI so the user knows WHY the
        // START DETECTION button is greyed out. Common causes:
        //   - 404 on /yolo.tflite (asset not bundled in APK)
        //   - 404 on /tflite-wasm/tflite_web_api_client.js
        //   - All tf-core backends failed init (very rare)
        setModelError(String(e?.message ?? e));
        setModelLoading(false);
      });
    } else {
      setModelReady(true);
    }
  }, []);

  const toggleRunning = () => {
    setIsRunning(!isRunning);
  };

  useEffect(() => {
    // IMPORTANT: detection no longer waits for state === "connected".
    // The connection state is driven by the /sensors poll on :80 — but
    // detection only needs the <img> to be decoding /frame.jpg snapshots,
    // which is independent. If the Nano UART stalls but the camera is
    // fine, we'd previously freeze detection with no on-screen explanation.
    if (isRunning && modelReady) {
      const targetFps = getTargetFps();
      const intervalMs = 1000 / targetFps;
      const confThresh = getConfThreshold();
      let detecting = false;

      const loop = async () => {
        if (!isRunning || !modelReady) return;
        const now = Date.now();
        if (!detecting && now - lastDetectTime.current >= intervalMs) {
          lastDetectTime.current = now;
          detecting = true;
          const img = imgRef.current;
          const scratch = scratchCanvasRef.current;
          if (img && scratch && img.naturalWidth > 0 && img.naturalHeight > 0) {
            try {
              const start = performance.now();
              const detections = await detect(img, scratch, {
                confThreshold: confThresh
              });
              const end = performance.now();
              setInfTime(Math.round(end - start));
              setFps(Math.round(1000 / (end - start)));
              setTickCount(c => c + 1);
              setDetectError(null);

              drawDetections(detections);

              if (detections.length > 0 && !audioMuted) {
                announceDetection(detections[0].className);
              }
            } catch (e) {
              const msg = String((e as Error)?.message ?? e);
              console.warn("[YOLO] Detection tick failed:", e);
              setDetectError(msg.slice(0, 120));
            }
          }
          detecting = false;
        }
        loopRef.current = requestAnimationFrame(loop);
      };

      loopRef.current = requestAnimationFrame(loop);

      return () => {
        if (loopRef.current) cancelAnimationFrame(loopRef.current);
      };
    }

    if (loopRef.current) cancelAnimationFrame(loopRef.current);
    if (drawCanvasRef.current) {
      const ctx = drawCanvasRef.current.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, drawCanvasRef.current.width, drawCanvasRef.current.height);
    }
    setFps(0);
    setInfTime(0);
    return undefined;
  }, [isRunning, modelReady, audioMuted]);

  // Sync draw canvas size with img
  useEffect(() => {
    const img = imgRef.current;
    const canvas = drawCanvasRef.current;
    if (!img || !canvas) return;

    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        canvas.width = entry.contentRect.width;
        canvas.height = entry.contentRect.height;
      }
    });
    observer.observe(img);
    return () => observer.disconnect();
  }, [state]); // Re-bind if img remounts

  const drawDetections = (detections: Detection[]) => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const w = canvas.width;
    const h = canvas.height;
    
    detections.forEach(det => {
      const bx = det.x * w;
      const by = det.y * h;
      const bw = det.w * w;
      const bh = det.h * h;
      
      ctx.strokeStyle = "hsl(38 92% 50%)"; // primary
      ctx.lineWidth = 4;
      ctx.strokeRect(bx, by, bw, bh);
      
      ctx.fillStyle = "hsl(38 92% 50%)";
      const text = `${det.className} ${Math.round(det.confidence * 100)}%`;
      ctx.font = "bold 16px sans-serif";
      const tm = ctx.measureText(text);
      ctx.fillRect(bx, by - 24, tm.width + 8, 24);
      
      ctx.fillStyle = "#000";
      ctx.fillText(text, bx + 4, by - 6);
    });
  };

  const getDistanceColor = (cm: number) => {
    if (cm <= 0) return "text-muted-foreground";
    if (cm < 50) return "text-destructive";
    if (cm < 100) return "text-primary";
    return "text-foreground";
  };

  return (
    <div className="flex flex-col h-full">
      <canvas ref={scratchCanvasRef} className="hidden" />
      
      {/* Viewport.
          The MJPEG <img> stays mounted as long as we have a client — even
          if `state` momentarily flips to "error" — because unmounting it
          tears down the long-lived MJPEG socket. That socket is what
          actually feeds the live preview, so dropping it on every
          transient blip is what made the preview die a few seconds after
          you hit Start Detection. We just dim the viewport and overlay a
          status pill instead. */}
      <div className="relative w-full aspect-[4/3] bg-card flex-shrink-0 flex flex-col items-center justify-center border-b border-border overflow-hidden">
        {client ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              // crossOrigin="anonymous" is REQUIRED so the YOLO detect()
              // step can drawImage() this <img> onto the scratch canvas
              // without tainting it. Without this attribute every
              // detection tick throws SecurityError silently and the
              // overlay never gets bounding boxes drawn → 0 fps.
              // The ESP32 firmware sends Access-Control-Allow-Origin: *
              // on /frame.jpg so this is safe.
              crossOrigin="anonymous"
              className={`absolute inset-0 w-full h-full object-contain transition-opacity ${state === "connected" ? "opacity-100" : "opacity-50"}`}
              alt="Live feed from smart cane"
              onLoad={() => {
                (client as ESP32Client).markFrameReceived();
                setFrameCount(c => c + 1);
                // Chain the next snapshot request so we never have two
                // /frame.jpg fetches in flight at once. See the long
                // comment on the snapshot poller useEffect above.
                (window as unknown as { __icSnapNext?: () => void }).__icSnapNext?.();
              }}
              onError={() => {
                (client as ESP32Client).reportStreamError();
                (window as unknown as { __icSnapErr?: () => void }).__icSnapErr?.();
              }}
            />
            <canvas
              ref={drawCanvasRef}
              className="absolute inset-0 w-full h-full object-contain pointer-events-none"
            />

            {/* Health pill — top-right. Always visible so you can see
                ESP32 link state at a glance, especially while the model
                is running and pegging the CPU. The "last contact"
                seconds counter reads the most recent of: /sensors poll,
                /health poll, or a delivered MJPEG frame — so it ticks
                up the moment the cane truly stops talking, not just
                when one specific endpoint stalls. Frame count proves
                the live stream socket is delivering, separately from
                the polled control endpoints. */}
            <div className="absolute top-2 right-2 bg-black/70 backdrop-blur text-white text-[10px] px-2 py-1 rounded-md font-mono flex items-center gap-2 pointer-events-none">
              <span className={`inline-block w-2 h-2 rounded-full ${
                state === "connected" && (client.lastContactMs ?? 99999) < 4000
                  ? "bg-green-400"
                  : state === "connecting"
                    ? "bg-yellow-400 animate-pulse"
                    : "bg-red-400"
              }`} />
              <span>{state}</span>
              {client.lastContactMs !== null && (
                <span className="opacity-70" data-tick={healthTick}>
                  {(Math.max(0, client.lastContactMs) / 1000).toFixed(1)}s
                </span>
              )}
              <span className="opacity-60 border-l border-white/20 pl-2">
                {frameCount}f
              </span>
              {(client as ESP32Client).isStreamFallback && (
                <span className="opacity-60 border-l border-white/20 pl-2 text-yellow-300">
                  SNAP
                </span>
              )}
            </div>

            {/* Perf overlay — top-left, only while detecting. */}
            {isRunning && (
              <div className="absolute top-2 left-2 bg-black/60 backdrop-blur text-white text-xs px-2 py-1 rounded-md font-mono flex flex-col max-w-[60%]">
                <span>{infTime}ms · {fps} FPS</span>
                <span className="text-[10px] opacity-60">{getActiveBackend()} · {tickCount}t</span>
                {detectError && (
                  <span className="text-[10px] text-red-300 break-words">{detectError}</span>
                )}
              </div>
            )}

            {/* Model-status pill — bottom-left of viewport. Rendered AFTER
                the status overlay so it stacks on top and remains visible
                even during a connection blip. */}
            <div className="absolute bottom-2 left-2 z-10 bg-black/70 backdrop-blur text-white text-[10px] px-2 py-1 rounded-md font-mono flex items-center gap-2 pointer-events-none max-w-[80%]">
              <span className={`inline-block w-2 h-2 rounded-full ${
                modelError ? "bg-red-400" :
                modelReady ? "bg-green-400" :
                "bg-yellow-400 animate-pulse"
              }`} />
              <span>
                AI: {modelError ? "error" : modelReady ? `ready (${getActiveBackend()})` : "loading"}
              </span>
              {modelError && (
                <span className="opacity-80 truncate">{modelError}</span>
              )}
            </div>

            {/* Status overlay shown only when we're not "connected". */}
            {state !== "connected" && (
              <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center text-center p-6 text-white">
                {state === "connecting" ? (
                  <Loader2 className="w-10 h-10 animate-spin mb-3 text-primary" />
                ) : (
                  <WifiOff className="w-10 h-10 mb-3" />
                )}
                <h2 className="text-lg font-semibold mb-1">
                  {state === "connecting" ? "Connecting…" : "Reconnecting…"}
                </h2>
                <p className="text-xs max-w-xs opacity-80">
                  Lost contact with the cane. The live feed will resume automatically once /sensors responds.
                </p>
              </div>
            )}
          </>
        ) : (
          <div className="text-center p-6 flex flex-col items-center text-muted-foreground">
            <WifiOff className="w-10 h-10 mb-4" />
            <h2 className="text-xl font-semibold mb-2 text-foreground">Camera Disconnected</h2>
            <p className="text-sm max-w-xs">
              Make sure your phone is connected to the "IntelliCane" WiFi network.
            </p>
          </div>
        )}
      </div>

      {/* Controls & Sensors */}
      <div className="flex-1 p-4 flex flex-col gap-6 overflow-y-auto">
        
        {/* Main Action Button */}
        <Button 
          size="lg"
          className={`w-full h-24 text-2xl font-bold rounded-2xl flex flex-col gap-2 ${isRunning ? "bg-destructive hover:bg-destructive/90 text-destructive-foreground" : "bg-primary hover:bg-primary/90 text-primary-foreground"}`}
          onClick={toggleRunning}
          disabled={!modelReady}
          aria-live="polite"
        >
          {isRunning ? (
            <>
              <Square className="w-8 h-8 fill-current" />
              STOP DETECTION
            </>
          ) : (
            <>
              <Play className="w-8 h-8 fill-current" />
              {modelLoading ? "LOADING AI..." : "START DETECTION"}
            </>
          )}
        </Button>

        {/* Quick status */}
        <div className="flex justify-between items-center px-2">
          <span className="text-muted-foreground text-sm font-medium uppercase tracking-wider">Status</span>
          <Badge variant={state === "connected" ? "default" : "secondary"}>
            {state.toUpperCase()}
          </Badge>
        </div>

        {/* Sensor Dashboard.
            Reflects the actual physical sensor head: 1 ultrasonic at 0°
            on top, plus 4 ToF lasers on the semicircular disc at ±20°
            (inner) and ±45° (outer). The ground channel was removed —
            the HC-SR04 was relabeled as the front (0°) channel. The
            center cell of the bottom row is the IntelliCane logo, both
            because there's no sixth sensor to put there and because
            it visually anchors the surrounding readings around the
            cane itself. */}
        <div className="bg-card rounded-2xl border border-border p-4 shadow-sm">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4 text-center">Distance Sensors</h3>

          <div className="grid grid-cols-3 gap-3">
            {/* Top row — outer-left (-45°), front (0°), outer-right (+45°). */}
            <SensorCell label="Outer L" sublabel="-45°" cm={latestSensor?.outL ?? -1} colorFn={getDistanceColor} />
            <SensorCell label="Front"   sublabel="0°"   cm={latestSensor?.front ?? -1} colorFn={getDistanceColor} />
            <SensorCell label="Outer R" sublabel="+45°" cm={latestSensor?.outR ?? -1} colorFn={getDistanceColor} />

            {/* Bottom row — inner-left (-20°), logo, inner-right (+20°). */}
            <SensorCell label="Inner L" sublabel="-20°" cm={latestSensor?.inL ?? -1} colorFn={getDistanceColor} />

            {/* Logo cell: a cane icon with a small wifi badge to evoke
                "smart cane that senses around it". Uses the primary
                accent so it pops against the neutral sensor cells. */}
            <div
              className="flex flex-col items-center justify-center p-3 rounded-xl bg-primary/10 border border-primary/30 relative overflow-hidden"
              aria-hidden
            >
              <div className="relative">
                <Accessibility className="w-9 h-9 text-primary stroke-[2.2px]" />
                <Wifi className="w-4 h-4 text-primary absolute -top-1 -right-2 rotate-12" />
              </div>
              <span className="text-[10px] font-bold tracking-widest text-primary mt-1">INTELLICANE</span>
            </div>

            <SensorCell label="Inner R" sublabel="+20°" cm={latestSensor?.inR ?? -1} colorFn={getDistanceColor} />
          </div>
        </div>

      </div>
    </div>
  );
}

// One distance readout cell. Pulled out so the 5 cells stay in sync if
// we tweak typography or padding. `cm <= 0` means "no reading" and we
// render a dim "--" instead of a misleading number.
function SensorCell({
  label,
  sublabel,
  cm,
  colorFn,
}: {
  label: string;
  sublabel: string;
  cm: number;
  colorFn: (cm: number) => string;
}) {
  return (
    <div className="flex flex-col items-center p-3 rounded-xl bg-background border border-border">
      <span className="text-xs text-muted-foreground mb-0.5">{label}</span>
      <span className="text-[10px] text-muted-foreground/70 mb-1 font-mono">{sublabel}</span>
      <span className={`text-xl font-bold ${colorFn(cm)}`}>
        {cm > 0 ? cm : "--"}<span className="text-xs ml-1 opacity-50">cm</span>
      </span>
    </div>
  );
}

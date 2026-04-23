import { useEffect, useRef, useState } from "react";
import { useSmartCane } from "@/hooks/use-smart-cane";
import { loadModel, detect, Detection, isModelLoaded } from "@/lib/yolo";
import { getConfThreshold, getTargetFps } from "@/lib/settings";
import { announceDetection } from "@/lib/tts";
import { useWakeLock } from "@/lib/wakeLock";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Play, Square, Loader2, WifiOff } from "lucide-react";

export default function Home() {
  const { client, state, latestSensor, audioMuted } = useSmartCane();
  const [isRunning, setIsRunning] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [fps, setFps] = useState(0);
  const [infTime, setInfTime] = useState(0);
  
  const imgRef = useRef<HTMLImageElement>(null);
  const scratchCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const loopRef = useRef<number | null>(null);
  const lastDetectTime = useRef<number>(0);
  
  useWakeLock(isRunning);

  // Pre-load model
  useEffect(() => {
    if (!isModelLoaded()) {
      setModelLoading(true);
      const url = import.meta.env.BASE_URL.replace(/\/$/, "") + "/yolo.tflite";
      loadModel(url).then(() => {
        setModelReady(true);
        setModelLoading(false);
      }).catch(e => {
        console.error("Failed to load model", e);
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
    if (isRunning && modelReady && state === "connected") {
      const targetFps = getTargetFps();
      const intervalMs = 1000 / targetFps;
      const confThresh = getConfThreshold();

      const loop = async () => {
        const now = Date.now();
        if (now - lastDetectTime.current >= intervalMs) {
          lastDetectTime.current = now;
          if (imgRef.current && scratchCanvasRef.current) {
            try {
              const start = performance.now();
              const detections = await detect(imgRef.current, scratchCanvasRef.current, {
                confThreshold: confThresh
              });
              const end = performance.now();
              setInfTime(Math.round(end - start));
              setFps(Math.round(1000 / (end - start)));
              
              drawDetections(detections);
              
              if (detections.length > 0 && !audioMuted) {
                // announce the most confident detection
                announceDetection(detections[0].className);
              }
            } catch (e) {
              console.error("Detect error", e);
            }
          }
        }
        loopRef.current = requestAnimationFrame(loop);
      };
      
      loopRef.current = requestAnimationFrame(loop);
      
      return () => {
        if (loopRef.current) cancelAnimationFrame(loopRef.current);
      };
    } else {
      if (loopRef.current) cancelAnimationFrame(loopRef.current);
      // clear canvas
      if (drawCanvasRef.current) {
        const ctx = drawCanvasRef.current.getContext("2d");
        if (ctx) ctx.clearRect(0, 0, drawCanvasRef.current.width, drawCanvasRef.current.height);
      }
      setFps(0);
      setInfTime(0);
    }
  }, [isRunning, modelReady, state, audioMuted]);

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
      
      {/* Viewport */}
      <div className="relative w-full aspect-[4/3] bg-card flex-shrink-0 flex flex-col items-center justify-center border-b border-border overflow-hidden">
        {state === "connected" && client ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img 
              ref={imgRef}
              src={client.streamUrl} 
              crossOrigin="anonymous"
              className="absolute inset-0 w-full h-full object-contain"
              alt="Live feed from smart cane"
            />
            <canvas 
              ref={drawCanvasRef} 
              className="absolute inset-0 w-full h-full object-contain pointer-events-none"
            />
            
            {/* Perf overlay */}
            {isRunning && (
              <div className="absolute top-2 left-2 bg-black/60 backdrop-blur text-white text-xs px-2 py-1 rounded-md font-mono flex flex-col">
                <span>{infTime}ms</span>
                <span>{fps} FPS</span>
              </div>
            )}
          </>
        ) : (
          <div className="text-center p-6 flex flex-col items-center text-muted-foreground">
            {state === "connecting" ? (
              <Loader2 className="w-10 h-10 animate-spin mb-4 text-primary" />
            ) : (
              <WifiOff className="w-10 h-10 mb-4" />
            )}
            <h2 className="text-xl font-semibold mb-2 text-foreground">
              {state === "connecting" ? "Connecting..." : "Camera Disconnected"}
            </h2>
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
          disabled={state !== "connected" || !modelReady}
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

        {/* Sensor Dashboard */}
        <div className="bg-card rounded-2xl border border-border p-4 shadow-sm">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4 text-center">Distance Sensors</h3>
          
          {/* Spatial layout of sensors */}
          <div className="grid grid-cols-3 gap-3">
            {/* Top row */}
            <div className="flex flex-col items-center p-3 rounded-xl bg-background border border-border">
              <span className="text-xs text-muted-foreground mb-1">Front Left</span>
              <span className={`text-xl font-bold ${getDistanceColor(latestSensor?.fl ?? -1)}`}>
                {latestSensor?.fl ?? "--"}<span className="text-xs ml-1 opacity-50">cm</span>
              </span>
            </div>
            <div className="flex flex-col items-center p-3 rounded-xl bg-background border border-border">
              <span className="text-xs text-muted-foreground mb-1">Front</span>
              <span className={`text-xl font-bold ${getDistanceColor(latestSensor?.front ?? -1)}`}>
                {latestSensor?.front ?? "--"}<span className="text-xs ml-1 opacity-50">cm</span>
              </span>
            </div>
            <div className="flex flex-col items-center p-3 rounded-xl bg-background border border-border">
              <span className="text-xs text-muted-foreground mb-1">Front Right</span>
              <span className={`text-xl font-bold ${getDistanceColor(latestSensor?.fr ?? -1)}`}>
                {latestSensor?.fr ?? "--"}<span className="text-xs ml-1 opacity-50">cm</span>
              </span>
            </div>
            
            {/* Bottom row */}
            <div className="flex flex-col items-center p-3 rounded-xl bg-background border border-border">
              <span className="text-xs text-muted-foreground mb-1">Left</span>
              <span className={`text-xl font-bold ${getDistanceColor(latestSensor?.left ?? -1)}`}>
                {latestSensor?.left ?? "--"}<span className="text-xs ml-1 opacity-50">cm</span>
              </span>
            </div>
            <div className="flex flex-col items-center p-3 rounded-xl bg-background border border-border">
              <span className="text-xs text-muted-foreground mb-1">Ground</span>
              <span className={`text-xl font-bold ${getDistanceColor(latestSensor?.ground ?? -1)}`}>
                {latestSensor?.ground ?? "--"}<span className="text-xs ml-1 opacity-50">cm</span>
              </span>
            </div>
            <div className="flex flex-col items-center p-3 rounded-xl bg-background border border-border">
              <span className="text-xs text-muted-foreground mb-1">Right</span>
              <span className={`text-xl font-bold ${getDistanceColor(latestSensor?.right ?? -1)}`}>
                {latestSensor?.right ?? "--"}<span className="text-xs ml-1 opacity-50">cm</span>
              </span>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

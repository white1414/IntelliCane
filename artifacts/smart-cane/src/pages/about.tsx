import { CLASS_NAMES } from "@/lib/labels";
import { Badge } from "@/components/ui/badge";

export default function AboutPage() {
  return (
    <div className="p-4 flex flex-col gap-6 max-w-md mx-auto w-full mb-8">
      <div className="space-y-2">
        <h2 className="text-3xl font-bold">About IntelliCane</h2>
        <p className="text-muted-foreground text-sm">Assistive vision for a smart cane. v1.1</p>
      </div>

      <div className="prose prose-sm dark:prose-invert max-w-none">
        <p>
          IntelliCane runs entirely in your browser. It connects to the cane's
          ESP32-CAM over WiFi, displays the live camera feed, runs object
          detection locally on your phone, and reads out what's ahead through
          your earbuds.
        </p>
        <p>
          Because the AI runs on the phone, <strong>no internet is required</strong> once the app is open
          (or installed) — total privacy and faster reactions.
        </p>

        <h3>Hardware</h3>
        <ul>
          <li>ESP32-CAM module — WiFi access point, camera, and SOS button host</li>
          <li>Arduino Nano — drives 4 ToF sensors, an HC-SR04, the buzzer, and the vibrator</li>
          <li>2-second-hold push button on the cane to fire the SOS SMS</li>
        </ul>

        <h3>Emergency (SOS)</h3>
        <p>
          Holding the SOS button for two seconds, or tapping the SOS chip in the
          header, gets your phone's GPS fix and texts the guardian number you
          set in Settings with a Google Maps link.
        </p>

        <h3>Recognizable objects ({CLASS_NAMES.length})</h3>
      </div>

      <div className="flex flex-wrap gap-2 mt-2">
        {CLASS_NAMES.map((name) => (
          <Badge key={name} variant="secondary" className="bg-card border-border">
            {name}
          </Badge>
        ))}
      </div>

      <div className="mt-8 text-center text-xs text-muted-foreground">
        <p>Built with React, ONNX Runtime Web, and Tailwind CSS.</p>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  getHost, setHost,
  getConfThreshold, setConfThreshold,
  getTargetFps, setTargetFps,
  getGuardianPhone, setGuardianPhone,
  getUserName, setUserName,
} from "@/lib/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useSmartCane } from "@/hooks/use-smart-cane";
import { useToast } from "@/hooks/use-toast";
import { Activity, Info, Download, ShieldAlert } from "lucide-react";
import { smsCapability } from "@/lib/sms";

export default function SettingsPage() {
  const { reconnect, audioMuted, setAudioMuted, triggerSos } = useSmartCane();
  const { toast } = useToast();

  const [hostVal, setHostVal] = useState("");
  const [confVal, setConfVal] = useState([0.45]);
  const [fpsVal, setFpsVal] = useState([2]);
  const [guardian, setGuardian] = useState("");
  const [userName, setUserNameLocal] = useState("");
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [smsMode, setSmsMode] = useState<"native-silent" | "composer" | "none">("none");

  useEffect(() => {
    setHostVal(getHost());
    setConfVal([getConfThreshold()]);
    setFpsVal([getTargetFps()]);
    setGuardian(getGuardianPhone());
    setUserNameLocal(getUserName());
    setSmsMode(smsCapability());

    const handler = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const handleSaveHost = () => {
    setHost(hostVal);
    reconnect();
    toast({ title: "Saved", description: "Reconnecting to the new host..." });
  };

  const handleSaveSos = () => {
    setGuardianPhone(guardian);
    setUserName(userName);
    toast({ title: "Saved", description: "Guardian contact updated." });
  };

  const handleTestSos = async () => {
    const result = await triggerSos();
    toast({
      title: result.ok ? "SOS test" : "SOS test failed",
      description: result.message,
      variant: result.ok ? "default" : "destructive",
    });
  };

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") setDeferredPrompt(null);
  };

  return (
    <div className="p-4 flex flex-col gap-8 max-w-md mx-auto w-full">
      <div className="space-y-2">
        <h2 className="text-3xl font-bold">Settings</h2>
        <p className="text-muted-foreground text-sm">Configure your IntelliCane connection, AI, and SOS contact.</p>
      </div>

      {/* Connection */}
      <div className="space-y-6 bg-card p-6 rounded-2xl border border-border">
        <div className="space-y-3">
          <Label htmlFor="host" className="text-base font-semibold">ESP32 Host Address</Label>
          <div className="flex gap-2">
            <Input
              id="host"
              value={hostVal}
              onChange={(e) => setHostVal(e.target.value)}
              className="text-lg bg-background"
              data-testid="input-host"
            />
            <Button onClick={handleSaveHost} variant="secondary" data-testid="button-apply-host">Apply</Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Default <code>192.168.4.1</code> when joined to the IntelliCane WiFi (password <code>sotgofa1</code>).
          </p>
        </div>

        <div className="w-full h-px bg-border" />

        <div className="space-y-4">
          <div className="flex justify-between">
            <Label className="text-base font-semibold">AI Confidence</Label>
            <span className="font-mono bg-secondary px-2 rounded">{Math.round(confVal[0] * 100)}%</span>
          </div>
          <Slider
            min={0.2} max={0.8} step={0.05}
            value={confVal}
            onValueChange={(v) => { setConfVal(v); setConfThreshold(v[0]); }}
            className="py-2"
          />
          <p className="text-xs text-muted-foreground">Higher = fewer false detections, but might miss real ones.</p>
        </div>

        <div className="space-y-4">
          <div className="flex justify-between">
            <Label className="text-base font-semibold">Target FPS</Label>
            <span className="font-mono bg-secondary px-2 rounded">{fpsVal[0]} fps</span>
          </div>
          <Slider
            min={1} max={5} step={1}
            value={fpsVal}
            onValueChange={(v) => { setFpsVal(v); setTargetFps(v[0]); }}
            className="py-2"
          />
          <p className="text-xs text-muted-foreground">How often the AI runs. Lower this if your phone gets hot.</p>
        </div>

        <div className="w-full h-px bg-border" />

        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label className="text-base font-semibold">Mute All Audio</Label>
            <p className="text-xs text-muted-foreground">Disables voice announcements</p>
          </div>
          <Switch checked={audioMuted} onCheckedChange={setAudioMuted} data-testid="switch-mute" />
        </div>
      </div>

      {/* SOS Contact */}
      <div className="space-y-6 bg-card p-6 rounded-2xl border border-border">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-destructive" />
          <h3 className="font-semibold text-lg">Emergency (SOS)</h3>
        </div>

        <div className="space-y-3">
          <Label htmlFor="guardian" className="text-base font-semibold">Guardian Phone Number</Label>
          <Input
            id="guardian"
            type="tel"
            inputMode="tel"
            placeholder="+15551234567"
            value={guardian}
            onChange={(e) => setGuardian(e.target.value)}
            className="text-lg bg-background"
            data-testid="input-guardian"
          />
          <p className="text-xs text-muted-foreground">
            Include the country code with a plus sign. Example: <code>+15551234567</code>.
          </p>
        </div>

        <div className="space-y-3">
          <Label htmlFor="username" className="text-base font-semibold">Your Name (optional)</Label>
          <Input
            id="username"
            placeholder="e.g. Sam"
            value={userName}
            onChange={(e) => setUserNameLocal(e.target.value)}
            className="text-lg bg-background"
            data-testid="input-name"
          />
          <p className="text-xs text-muted-foreground">If set, the SOS message reads "Sam is in danger" instead of "Person in danger".</p>
        </div>

        <div className="flex gap-2">
          <Button onClick={handleSaveSos} variant="secondary" className="flex-1" data-testid="button-save-sos">Save</Button>
          <Button onClick={handleTestSos} variant="outline" className="flex-1" data-testid="button-test-sos">Test SOS</Button>
        </div>

        <div className="bg-secondary/50 p-4 rounded-xl text-xs text-secondary-foreground space-y-2">
          <p>
            <strong>SOS sending mode:</strong>{" "}
            {smsMode === "native-silent" && "Native (sends silently, no confirmation)"}
            {smsMode === "composer"      && "Web (opens your SMS app prefilled — you tap Send)"}
            {smsMode === "none"          && "Unsupported on this device"}
          </p>
          <p>
            Browsers can't send SMS without your tap. To enable silent sending,
            wrap this PWA as an Android app — see the README in <code>attached_assets/IntelliCane</code>.
          </p>
        </div>
      </div>

      {deferredPrompt && (
        <Button onClick={handleInstall} className="w-full py-6 text-lg rounded-xl flex items-center gap-2 bg-primary text-primary-foreground" data-testid="button-install-pwa">
          <Download className="w-5 h-5" />
          Install as App
        </Button>
      )}

      <div className="bg-secondary/50 p-4 rounded-xl text-sm text-secondary-foreground">
        <strong>Screen-on:</strong> while detection is running the app keeps your screen awake. If the screen turns off, the camera and AI both pause.
      </div>

      <div className="flex gap-4 mt-2">
        <Link href="/diagnostics" className="flex-1">
          <Button variant="outline" className="w-full h-14 rounded-xl flex items-center gap-2">
            <Activity className="w-5 h-5" /> Diagnostics
          </Button>
        </Link>
        <Link href="/about" className="flex-1">
          <Button variant="outline" className="w-full h-14 rounded-xl flex items-center gap-2">
            <Info className="w-5 h-5" /> About
          </Button>
        </Link>
      </div>
    </div>
  );
}

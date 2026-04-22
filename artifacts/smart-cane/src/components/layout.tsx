import { ReactNode, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Camera, Settings, Activity, Info, Volume2, VolumeX, ShieldAlert } from "lucide-react";
import { useSmartCane } from "@/hooks/use-smart-cane";
import { stopSpeaking } from "@/lib/tts";
import { useToast } from "@/hooks/use-toast";

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { state, audioMuted, setAudioMuted, triggerSos } = useSmartCane();
  const { toast } = useToast();

  const toggleMute = () => {
    const newMuted = !audioMuted;
    setAudioMuted(newMuted);
    if (newMuted) {
      stopSpeaking();
      toast({ title: "Audio Muted", description: "Voice announcements disabled." });
    } else {
      toast({ title: "Audio Enabled", description: "Voice announcements enabled." });
    }
  };

  const handleManualSos = async () => {
    toast({ title: "Sending SOS", description: "Getting your location..." });
    const result = await triggerSos();
    toast({
      title: result.ok ? "SOS triggered" : "SOS failed",
      description: result.message,
      variant: result.ok ? "default" : "destructive",
    });
  };

  useEffect(() => {
    const ariaLive = document.getElementById("connection-status-aria");
    if (ariaLive) ariaLive.textContent = `Camera status: ${state}`;
  }, [state]);

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground dark selection:bg-primary/30">
      <div
        id="connection-status-aria"
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
      />

      <header className="flex items-center justify-between p-4 border-b border-border bg-card sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center text-primary-foreground font-bold">
            IC
          </div>
          <h1 className="font-bold text-xl tracking-tight">IntelliCane</h1>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleManualSos}
            className="px-3 py-2 rounded-full flex items-center gap-2 bg-destructive/15 text-destructive border border-destructive/30 active:scale-95 transition-transform font-semibold"
            aria-label="Send SOS to guardian"
            data-testid="button-sos-header"
          >
            <ShieldAlert className="w-5 h-5" />
            <span className="text-sm">SOS</span>
          </button>

          <button
            onClick={toggleMute}
            className={`p-3 rounded-full flex items-center justify-center transition-colors ${
              audioMuted
                ? "bg-destructive/10 text-destructive border border-destructive/20"
                : "bg-primary/10 text-primary border border-primary/20"
            }`}
            aria-label={audioMuted ? "Unmute audio" : "Mute audio"}
            aria-pressed={!audioMuted}
            data-testid="button-mute"
          >
            {audioMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-x-hidden flex flex-col relative pb-20">
        {children}
      </main>

      <nav className="fixed bottom-0 left-0 right-0 border-t border-border bg-card/95 backdrop-blur-md pb-safe z-50">
        <div className="flex items-center justify-around p-2">
          <NavItem href="/" icon={Camera} label="Active" active={location === "/"} />
          <NavItem href="/settings" icon={Settings} label="Settings" active={location === "/settings"} />
          <NavItem href="/diagnostics" icon={Activity} label="Status" active={location === "/diagnostics"} />
          <NavItem href="/about" icon={Info} label="About" active={location === "/about"} />
        </div>
      </nav>
    </div>
  );
}

function NavItem({ href, icon: Icon, label, active }: { href: string; icon: any; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`flex flex-col items-center justify-center p-2 min-w-[64px] rounded-xl transition-all ${
        active ? "text-primary" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <Icon className={`w-6 h-6 mb-1 ${active ? "stroke-[2.5px]" : "stroke-2"}`} />
      <span className="text-[11px] font-medium">{label}</span>
    </Link>
  );
}

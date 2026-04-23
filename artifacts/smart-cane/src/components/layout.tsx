import { ReactNode, useEffect, useRef } from "react";
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

  const smsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const smsFired = useRef(false);

  const SMS_HOLD_MS = 900;
  const CALL_HOLD_MS = 2000;

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

  const clearSosTimers = () => {
    if (smsTimer.current) {
      clearTimeout(smsTimer.current);
      smsTimer.current = null;
    }
    if (callTimer.current) {
      clearTimeout(callTimer.current);
      callTimer.current = null;
    }
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
      // Escalate: place the call. SMS already fired at 900ms, so call only.
      placeCallEscalation();
    }, CALL_HOLD_MS);
  };

  const placeCallEscalation = async () => {
    // Direct call only — SMS has already gone out.
    const { placeCall } = await import("@/lib/sms");
    const { getGuardianPhone } = await import("@/lib/settings");
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

  const handleSosPressEnd = () => {
    clearSosTimers();
  };

  const handleSosClick = () => {
    // Swallow the click — short taps do nothing; user must hold ≥ 900ms.
    if (smsFired.current) {
      smsFired.current = false;
    }
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
            onClick={handleSosClick}
            onMouseDown={handleSosPressStart}
            onMouseUp={handleSosPressEnd}
            onMouseLeave={handleSosPressEnd}
            onTouchStart={handleSosPressStart}
            onTouchEnd={handleSosPressEnd}
            onTouchCancel={handleSosPressEnd}
            onContextMenu={(e) => e.preventDefault()}
            className="px-3 py-2 rounded-full flex items-center gap-2 bg-destructive/15 text-destructive border border-destructive/30 active:scale-95 transition-transform font-semibold select-none"
            aria-label="Send SOS to guardian. Hold for nearly one second to text. Keep holding for two seconds to also call."
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

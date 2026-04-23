import { ReactNode, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Camera, Settings, Activity, Info } from "lucide-react";
import { useSmartCane } from "@/hooks/use-smart-cane";
import { FallAlertOverlay } from "@/components/fall-alert-overlay";

// Header used to also host the SOS hold-button and the audio mute
// toggle. Both moved to the Diagnostics page so the Active screen
// stays focused on the live feed and so they live alongside the rest
// of the demo / hardware-test controls. See diagnostics.tsx.
export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { state, fallAlert, cancelFallAlert } = useSmartCane();

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

        {/* Tiny live connection state in the header — replaces the
            removed SOS / mute buttons. Full controls live on the
            Diagnostics tab. */}
        <div className="flex items-center gap-2 text-xs font-mono">
          <span className={`inline-block w-2 h-2 rounded-full ${
            state === "connected" ? "bg-green-400" :
            state === "connecting" ? "bg-yellow-400 animate-pulse" :
            "bg-red-400"
          }`} />
          <span className="opacity-70">{state}</span>
        </div>
      </header>

      <main className="flex-1 overflow-x-hidden flex flex-col relative pb-20">
        {children}
      </main>

      <FallAlertOverlay
        active={fallAlert.active}
        remainingMs={fallAlert.remainingMs}
        totalMs={fallAlert.totalMs}
        onCancel={cancelFallAlert}
      />

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

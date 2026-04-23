import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";

// Full-screen overlay shown when the phone suspects a fall.
// User can press the big "I'M OK" button OR click the cane's hardware
// SOS button (single click) to cancel. Otherwise SOS fires at 0s.
export function FallAlertOverlay({
  active,
  remainingMs,
  totalMs,
  onCancel,
}: {
  active: boolean;
  remainingMs: number;
  totalMs: number;
  onCancel: () => void;
}) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => force(x => x + 1), 200);
    return () => clearInterval(id);
  }, [active]);

  if (!active) return null;
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const pct = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));

  return (
    <div
      className="fixed inset-0 z-[100] bg-destructive/95 backdrop-blur-sm flex flex-col items-center justify-center text-destructive-foreground p-6 animate-in fade-in"
      role="alertdialog"
      aria-live="assertive"
      aria-label={`Possible fall detected. Calling for help in ${seconds} seconds. Tap I'm OK to cancel.`}
      data-testid="overlay-fall-alert"
    >
      <ShieldAlert className="w-20 h-20 mb-4 animate-pulse" />
      <h1 className="text-3xl font-bold tracking-tight mb-2 text-center">
        Possible fall detected
      </h1>
      <p className="text-lg text-center opacity-90 max-w-sm mb-8">
        Tap below or click the cane button if you're okay. Otherwise SOS will
        be sent in {seconds} second{seconds === 1 ? "" : "s"}.
      </p>

      <div className="w-full max-w-sm h-3 bg-black/30 rounded-full overflow-hidden mb-8">
        <div
          className="h-full bg-white transition-all duration-200 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>

      <button
        onClick={onCancel}
        className="w-full max-w-sm py-8 rounded-3xl bg-white text-destructive text-3xl font-extrabold shadow-2xl active:scale-95 transition-transform"
        data-testid="button-fall-cancel"
        aria-label="I am okay. Cancel the SOS."
      >
        I'M OK
      </button>

      <div className="mt-6 text-5xl font-mono font-bold tabular-nums">
        {seconds}
      </div>
    </div>
  );
}

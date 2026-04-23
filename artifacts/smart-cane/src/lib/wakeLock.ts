import { useEffect, useRef, useState } from "react";

interface WakeLockSentinel {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
}

interface WakeLockNavigator {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
}

export function useWakeLock(active: boolean) {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  const [supported, setSupported] = useState(false);
  const [held, setHeld] = useState(false);

  useEffect(() => {
    setSupported(typeof navigator !== "undefined" && "wakeLock" in navigator);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const nav = navigator as WakeLockNavigator;

    async function acquire() {
      if (!nav.wakeLock) return;
      try {
        const sentinel = await nav.wakeLock.request("screen");
        if (cancelled) {
          await sentinel.release();
          return;
        }
        sentinelRef.current = sentinel;
        setHeld(true);
        sentinel.addEventListener("release", () => {
          setHeld(false);
          sentinelRef.current = null;
        });
      } catch {
        setHeld(false);
      }
    }

    async function release() {
      if (sentinelRef.current) {
        try {
          await sentinelRef.current.release();
        } catch {
          // ignore
        }
        sentinelRef.current = null;
        setHeld(false);
      }
    }

    if (active) {
      acquire();
      const onVis = () => {
        if (document.visibilityState === "visible" && active) acquire();
      };
      document.addEventListener("visibilitychange", onVis);
      return () => {
        cancelled = true;
        document.removeEventListener("visibilitychange", onVis);
        release();
      };
    } else {
      release();
    }

    return () => {
      cancelled = true;
    };
  }, [active]);

  return { supported, held };
}

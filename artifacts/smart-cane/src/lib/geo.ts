// Wrapper around navigator.geolocation that returns a Promise.
// We try Capacitor's native Geolocation plugin first if it's there
// (it works without WiFi and with much better accuracy on real hardware),
// and fall back to the browser API.

export interface Fix {
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
}

export function geolocationAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as unknown as { Capacitor?: { Plugins?: { Geolocation?: unknown } } }).Capacitor;
  if (cap?.Plugins?.Geolocation) return true;
  return typeof navigator !== "undefined" && !!navigator.geolocation;
}

export async function getLocationOnce(timeoutMs = 8000): Promise<Fix> {
  // Capacitor first (only present in the native APK build).
  const cap = (window as unknown as {
    Capacitor?: { Plugins?: { Geolocation?: { getCurrentPosition: (opts: unknown) => Promise<{ coords: { latitude: number; longitude: number; accuracy: number }; timestamp: number }> } } };
  }).Capacitor;
  const native = cap?.Plugins?.Geolocation;
  if (native) {
    const pos = await native.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: timeoutMs,
      maximumAge: 30_000,
    });
    return {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      timestamp: pos.timestamp,
    };
  }

  // Web Geolocation fallback.
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    throw new Error("Geolocation is not available in this browser.");
  }
  return new Promise<Fix>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        accuracy: p.coords.accuracy,
        timestamp: p.timestamp,
      }),
      (err) => reject(new Error(err.message || "Failed to get location.")),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

export function googleMapsLink(lat: number, lng: number): string {
  const la = lat.toFixed(6);
  const ln = lng.toFixed(6);
  return `https://maps.google.com/?q=${la},${ln}`;
}

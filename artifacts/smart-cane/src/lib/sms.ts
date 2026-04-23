// Send an SMS, two ways:
//   - In a Capacitor native build: use the SmsManager plugin and send
//     directly with no user confirmation (requires SEND_SMS Android perm).
//   - In a plain web/PWA build: open the phone's default SMS app prefilled
//     with the number + body. The user still has to hit Send — browsers
//     don't allow silent SMS, ever.

export interface SendSmsResult {
  sent: boolean;          // true only when the native plugin actually sent
  openedComposer: boolean; // true when we opened the sms: link
  error?: string;
}

interface SmsPlugin {
  send(opts: { numbers: string[]; text: string }): Promise<unknown>;
  placeCall?(opts: { number: string; speakerOn?: boolean; maxVolume?: boolean }): Promise<unknown>;
}

let cachedNative: SmsPlugin | null | undefined = undefined;

function getNativeSms(): SmsPlugin | null {
  if (cachedNative !== undefined) return cachedNative;
  if (typeof window === "undefined") {
    cachedNative = null;
    return null;
  }
  const cap = (window as unknown as {
    Capacitor?: {
      isNativePlatform?: () => boolean;
      registerPlugin?: <T>(name: string) => T;
      Plugins?: {
        SmsManager?: SmsPlugin;
        SMSPlugin?: SmsPlugin;
      };
    };
  }).Capacitor;
  if (!cap?.isNativePlatform?.()) {
    cachedNative = null;
    return null;
  }
  // Prefer the modern registerPlugin path (Capacitor 4+).
  const registered = cap.registerPlugin?.<SmsPlugin>("SmsManager");
  cachedNative = registered ?? cap.Plugins?.SmsManager ?? cap.Plugins?.SMSPlugin ?? null;
  return cachedNative;
}

export function smsCapability(): "native-silent" | "composer" | "none" {
  if (typeof window === "undefined") return "none";
  if (getNativeSms()) return "native-silent";
  // Almost all phones can handle sms: links — desktop browsers can't.
  if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return "composer";
  return "none";
}

export async function sendSms(phone: string, body: string): Promise<SendSmsResult> {
  const cleanedPhone = phone.replace(/[^\d+]/g, "");
  if (!cleanedPhone) {
    return { sent: false, openedComposer: false, error: "No phone number set." };
  }

  const native = getNativeSms();
  if (native) {
    try {
      await native.send({ numbers: [cleanedPhone], text: body });
      return { sent: true, openedComposer: false };
    } catch (e) {
      return {
        sent: false,
        openedComposer: false,
        error: e instanceof Error ? e.message : "Native SMS failed.",
      };
    }
  }

  // PWA fallback — open the system composer.
  try {
    const url = `sms:${cleanedPhone}?body=${encodeURIComponent(body)}`;
    window.location.href = url;
    return { sent: false, openedComposer: true };
  } catch (e) {
    return {
      sent: false,
      openedComposer: false,
      error: e instanceof Error ? e.message : "Could not open SMS app.",
    };
  }
}

export interface PlaceCallResult {
  placed: boolean;        // true when the native plugin actually started a call
  openedDialer: boolean;  // true when we opened the tel: link as a fallback
  error?: string;
}

export interface PlaceCallOptions {
  // Force speakerphone on after the call connects (Android only — uses
  // AudioManager.setSpeakerphoneOn). Useful for SOS / fall calls where
  // the user needs to hear hands-free.
  speakerOn?: boolean;
  // Set the in-call (voice) stream to the device's maximum volume.
  maxVolume?: boolean;
}

export async function placeCall(phone: string, opts?: PlaceCallOptions): Promise<PlaceCallResult> {
  const cleanedPhone = phone.replace(/[^\d+]/g, "");
  if (!cleanedPhone) {
    return { placed: false, openedDialer: false, error: "No phone number set." };
  }

  const native = getNativeSms();
  if (native?.placeCall) {
    try {
      await native.placeCall({
        number: cleanedPhone,
        speakerOn: opts?.speakerOn ?? false,
        maxVolume: opts?.maxVolume ?? false,
      });
      return { placed: true, openedDialer: false };
    } catch (e) {
      return {
        placed: false,
        openedDialer: false,
        error: e instanceof Error ? e.message : "Native call failed.",
      };
    }
  }

  // Web/PWA fallback — open the system dialer.
  try {
    if (typeof window !== "undefined") {
      window.location.href = `tel:${cleanedPhone}`;
      return { placed: false, openedDialer: true };
    }
    return { placed: false, openedDialer: false, error: "Window not available." };
  } catch (e) {
    return {
      placed: false,
      openedDialer: false,
      error: e instanceof Error ? e.message : "Could not open dialer.",
    };
  }
}

export function buildSosMessage(opts: {
  userName?: string;
  mapsLink: string;
  kind?: "sos" | "fall";
}): string {
  const name = opts.userName?.trim();
  if (opts.kind === "fall") {
    const who = name ? `${name} may have fallen` : "User may have fallen";
    return `${who}. IntelliCane detected a possible fall and got no response. Location: ${opts.mapsLink}`;
  }
  const who = name ? `${name} is in danger` : "Person in danger";
  return `${who}. SOS — current location: ${opts.mapsLink}`;
}

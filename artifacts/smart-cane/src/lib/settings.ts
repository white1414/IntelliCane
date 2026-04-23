// IntelliCane app settings, persisted in localStorage.
// Keys are prefixed with "intellicane." so we can evolve them without
// stepping on whatever the old "smartcane.*" keys held.

const HOST_KEY      = "intellicane.host";
const CONF_KEY      = "intellicane.confThreshold";
const FPS_KEY       = "intellicane.targetFps";
const GUARDIAN_KEY  = "intellicane.guardianPhone";
const PERSON1_KEY   = "intellicane.person1Phone";
const PERSON2_KEY   = "intellicane.person2Phone";
const USER_NAME_KEY = "intellicane.userName";
const FALL_DETECT_KEY = "intellicane.fallDetectEnabled";

// Backwards-compat: read old smartcane.* keys if no new value exists.
function read(key: string, legacy: string, fallback: string): string {
  if (typeof localStorage === "undefined") return fallback;
  return localStorage.getItem(key) ?? localStorage.getItem(legacy) ?? fallback;
}

export function getHost(): string {
  return read(HOST_KEY, "smartcane.host", "192.168.4.1");
}
export function setHost(host: string) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(HOST_KEY, host);
}

export function getConfThreshold(): number {
  const v = parseFloat(read(CONF_KEY, "smartcane.confThreshold", "0.45"));
  return Number.isFinite(v) ? v : 0.45;
}
export function setConfThreshold(v: number) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(CONF_KEY, String(v));
}

export function getTargetFps(): number {
  const v = parseInt(read(FPS_KEY, "smartcane.targetFps", "2"), 10);
  return Number.isFinite(v) && v > 0 ? v : 2;
}
export function setTargetFps(v: number) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(FPS_KEY, String(v));
}

// SOS settings.
export function getGuardianPhone(): string {
  return read(GUARDIAN_KEY, "", "");
}
export function setGuardianPhone(v: string) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(GUARDIAN_KEY, v.trim());
}

export function getPerson1Phone(): string {
  return read(PERSON1_KEY, "", "");
}
export function setPerson1Phone(v: string) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PERSON1_KEY, v.trim());
}

export function getPerson2Phone(): string {
  return read(PERSON2_KEY, "", "");
}
export function setPerson2Phone(v: string) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PERSON2_KEY, v.trim());
}

export function getFallDetectEnabled(): boolean {
  return read(FALL_DETECT_KEY, "", "1") !== "0";
}
export function setFallDetectEnabled(v: boolean) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(FALL_DETECT_KEY, v ? "1" : "0");
}

export function getUserName(): string {
  return read(USER_NAME_KEY, "", "");
}
export function setUserName(v: string) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(USER_NAME_KEY, v.trim());
}

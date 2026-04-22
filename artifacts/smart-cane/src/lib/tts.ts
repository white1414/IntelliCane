import { SPOKEN_NAMES } from "./labels";

interface QueueItem {
  text: string;
  priority: number;
  key: string;
}

let queue: QueueItem[] = [];
let speaking = false;
const recentSpoken = new Map<string, number>();
const COOLDOWN_MS = 4000;

export function speak(text: string, opts?: { priority?: number; key?: string; cooldown?: number }) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const key = opts?.key ?? text;
  const cooldown = opts?.cooldown ?? COOLDOWN_MS;
  const last = recentSpoken.get(key) ?? 0;
  if (Date.now() - last < cooldown) return;
  recentSpoken.set(key, Date.now());

  queue.push({ text, priority: opts?.priority ?? 1, key });
  queue.sort((a, b) => b.priority - a.priority);
  if (!speaking) drain();
}

export function speakUrgent(text: string, key?: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  queue = [];
  speaking = false;
  speak(text, { priority: 10, key: key ?? text, cooldown: 1500 });
}

export function announceDetection(className: string) {
  const phrase = SPOKEN_NAMES[className] ?? className;
  speak(phrase, { key: className, cooldown: 5000 });
}

export function announceObstacle(distanceCm: number, direction?: string) {
  let msg = "Obstacle";
  if (direction) msg += ` ${direction}`;
  if (distanceCm > 0) msg += `, ${Math.round(distanceCm)} centimeters`;
  speakUrgent(msg, `obstacle-${direction ?? "front"}`);
}

function drain() {
  if (queue.length === 0) {
    speaking = false;
    return;
  }
  speaking = true;
  const item = queue.shift()!;
  const utter = new SpeechSynthesisUtterance(item.text);
  utter.rate = 1.1;
  utter.volume = 1;
  utter.onend = drain;
  utter.onerror = drain;
  window.speechSynthesis.speak(utter);
}

export function stopSpeaking() {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  queue = [];
  speaking = false;
}

export function ttsAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

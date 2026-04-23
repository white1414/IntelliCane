/*
 * IntelliCane — Arduino Nano firmware (v3: semicircle disc layout)
 *
 * Physical sensor head (looking down on the top of the cane, USER's
 * forward direction = up the page):
 *
 *                       FRONT (HC-SR04, 0°)
 *                              │
 *           outL (-45°)        │        outR (+45°)
 *                  ┌───────────┼───────────┐
 *                  │  inL(-20) │  inR(+20) │
 *                  └─────┐     │     ┌─────┘
 *                        └─────┴─────┘
 *                              ║
 *                            (cane)
 *
 *   - 4 x VL53L0X ToF lasers mounted on a 3D-printed semicircular disc
 *     around the head of the cane:
 *        outL = far-left  laser, ~45° off-center
 *        inL  = near-left laser, ~20° off-center
 *        inR  = near-right laser, ~20° off-center
 *        outR = far-right laser, ~45° off-center
 *     There is intentionally NO laser at exactly 0° — that gap is
 *     covered by the ultrasonic above.
 *   - 1 x HC-SR04 ultrasonic mounted at the very top, dead-center,
 *     pointing straight forward. This is the "front" channel.
 *
 *  All 5 channels are alert candidates — if any is below the user-set
 *  threshold the buzzer + vibrator fire and `alert:1` is broadcast.
 *
 *  JSON shape sent to the ESP32-CAM (every ~50 ms):
 *      {"front":F,"inL":IL,"inR":IR,"outL":OL,"outR":OR,
 *       "alert":0|1,"fall":0|1}
 *  All values are in centimeters; -1 means "no reading".
 *
 *  LISTENS on Serial for single-byte commands from the ESP32-CAM:
 *      'V' -> turn the vibrator ON continuously (fall-alert mode).
 *      'S' -> stop continuous vibrate, return to normal proximity mode.
 *  While in continuous-vibrate mode the local proximity buzzer/vibrator
 *  logic is suppressed so the user gets a clear, distinct alert.
 *
 * Wiring:
 *   D2 -> XSHUT of ToF #0 = outL (far-left, -45°)
 *   D3 -> XSHUT of ToF #1 = inL  (near-left, -20°)
 *   D4 -> XSHUT of ToF #2 = inR  (near-right, +20°)
 *   D5 -> XSHUT of ToF #3 = outR (far-right, +45°)
 *   A4 -> SDA  (all VL53L0X share, with 4.7k pull-up to 3.3V)
 *   A5 -> SCL  (all VL53L0X share, with 4.7k pull-up to 3.3V)
 *   D6 -> HC-SR04 TRIG  (front, 0°)
 *   D7 <- HC-SR04 ECHO  (use a 1k/2k divider so 5V echo becomes ~3.3V)
 *   D8 -> piezo buzzer
 *   D9 -> vibration motor
 *
 *   D1 (TX) -> ESP32-CAM GPIO 14 (UART2 RX) via 1k/2k divider 5V -> 3.3V.
 *   D0 (RX) <- ESP32-CAM GPIO 13 (UART2 TX) DIRECT (3.3V -> 5V Nano is OK).
 *   GND <-> ESP32-CAM GND
 *
 *   ⚠ While the ESP32-CAM TX line is connected to D0, you cannot upload to
 *   the Nano over USB (the two TX sources fight on RX). Disconnect the wire
 *   from D0 while flashing, then plug it back.
 *
 *   ⚠ If after flashing the directions feel mirrored (left/right swapped,
 *   inner/outer swapped), just permute the xshutPins[] array below — the
 *   firmware initializes ToF in the order they appear there, so reordering
 *   that single line fixes any wiring mismatch without needing to resolder.
 *
 * Library required:
 *   "VL53L0X" by Pololu
 */

#include <Wire.h>
#include <VL53L0X.h>

// --- SETTINGS ---
const int thresholdCm = 30; // local alert threshold for buzzer/vibrator

// --- PINS ---
// Order matters — index 0 becomes outL, index 1 becomes inL, etc.
// Re-order this array if a sensor's physical position doesn't match.
const int xshutPins[] = {2, 3, 4, 5};
#define TRIG_PIN   6
#define ECHO_PIN   7
#define BUZZER_PIN 8
#define VIB_PIN    9

VL53L0X tofs[4];

// --- send-rate limiter ---
unsigned long lastSendMs = 0;
const unsigned long SEND_INTERVAL_MS = 50;

// --- Continuous-vibrate (fall-alert) mode ---
// When true, VIB_PIN is held HIGH non-stop and proximity alerts are
// suppressed (so the user doesn't get confused which alert is which).
bool forceVibrate = false;

void setup() {
  // 9600 baud matches what the ESP32-CAM UART2 is configured for.
  Serial.begin(9600);
  Wire.begin();

  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(VIB_PIN, OUTPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  // Bring all ToF sensors down so we can address them one by one.
  for (int i = 0; i < 4; i++) {
    pinMode(xshutPins[i], OUTPUT);
    digitalWrite(xshutPins[i], LOW);
  }
  delay(10);

  // Wake them up one at a time and assign 0x30, 0x31, 0x32, 0x33.
  for (int i = 0; i < 4; i++) {
    digitalWrite(xshutPins[i], HIGH);
    delay(10);
    if (!tofs[i].init()) {
      Serial.print(F("{\"err\":\"tof_init_fail\",\"i\":"));
      Serial.print(i);
      Serial.println("}");
      continue;
    }
    tofs[i].setAddress(0x30 + i);
    tofs[i].setTimeout(500);
    tofs[i].startContinuous();
  }
}

int readUltrasonicCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long dur = pulseIn(ECHO_PIN, HIGH, 20000); // 20ms timeout (~3.4m)
  if (dur <= 0) return -1;
  int cm = (int)(dur * 0.0343 / 2.0);
  if (cm <= 0 || cm > 400) return -1;
  return cm;
}

int readToFCm(int i) {
  uint16_t mm = tofs[i].readRangeContinuousMillimeters();
  if (tofs[i].timeoutOccurred() || mm == 0 || mm > 2000) return -1;
  return (int)(mm / 10);
}

// Drain any waiting bytes from the ESP32-CAM and update forceVibrate.
// We only ever expect single-byte commands so this is dead simple.
void pollSerialCommands() {
  while (Serial.available() > 0) {
    int b = Serial.read();
    if (b == 'V' || b == 'v') {
      forceVibrate = true;
    } else if (b == 'S' || b == 's') {
      forceVibrate = false;
    }
    // Anything else (newline, junk) — ignore.
  }
}

void loop() {
  // 0) Check for incoming control bytes from the ESP32.
  pollSerialCommands();

  // 1) Read everything. ToF index → semicircle position is documented at
  //    the top of this file.
  int outL  = readToFCm(0);   // -45°
  int inL   = readToFCm(1);   // -20°
  int inR   = readToFCm(2);   // +20°
  int outR  = readToFCm(3);   // +45°
  int front = readUltrasonicCm();   // 0°, HC-SR04 mounted on top

  // 2) Decide local alert state.
  //    - Fall-alert (forceVibrate) ALWAYS wins: vibrator on, buzzer off so
  //      the pattern is unambiguous.
  //    - Otherwise normal proximity logic applies across ALL 5 channels.
  bool alert = false;
  if (forceVibrate) {
    digitalWrite(VIB_PIN, HIGH);
    noTone(BUZZER_PIN);
    alert = true;  // reflected in JSON for visibility
  } else {
    int candidates[5] = { front, inL, inR, outL, outR };
    for (int i = 0; i < 5; i++) {
      if (candidates[i] > 0 && candidates[i] <= thresholdCm) {
        alert = true;
        break;
      }
    }
    if (alert) {
      digitalWrite(VIB_PIN, HIGH);
      tone(BUZZER_PIN, 1000);
    } else {
      digitalWrite(VIB_PIN, LOW);
      noTone(BUZZER_PIN);
    }
  }

  // 3) Forward sensor JSON to ESP32 every SEND_INTERVAL_MS.
  unsigned long now = millis();
  if (now - lastSendMs >= SEND_INTERVAL_MS) {
    lastSendMs = now;
    Serial.print("{\"front\":"); Serial.print(front);
    Serial.print(",\"inL\":");    Serial.print(inL);
    Serial.print(",\"inR\":");    Serial.print(inR);
    Serial.print(",\"outL\":");   Serial.print(outL);
    Serial.print(",\"outR\":");   Serial.print(outR);
    Serial.print(",\"alert\":");  Serial.print(alert ? 1 : 0);
    Serial.print(",\"fall\":");   Serial.print(forceVibrate ? 1 : 0);
    Serial.println("}");
  }

  delay(20);
}

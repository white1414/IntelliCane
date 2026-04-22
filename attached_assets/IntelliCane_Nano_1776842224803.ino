/*
 * IntelliCane — Arduino Nano firmware
 *
 * What it does:
 *   - Reads 4 x VL53L0X Time-of-Flight sensors over I2C (different XSHUT pins
 *     so we can hand each one a unique I2C address at boot).
 *   - Reads 1 x HC-SR04 ultrasonic, pointed slightly forward / down (catches
 *     ground drops like steps and curbs).
 *   - Drives a piezo buzzer + a vibration motor whenever ANY of those is
 *     under the user-set distance threshold.
 *   - ALSO sends one JSON line every ~50 ms over Serial (TX/RX) so the
 *     ESP32-CAM can forward the same readings to the phone — that's how the
 *     PWA speaks the obstacle direction + distance.
 *
 * Wiring (matches your existing layout):
 *   D2 -> XSHUT of ToF #1 (front)
 *   D3 -> XSHUT of ToF #2 (front-left)
 *   D4 -> XSHUT of ToF #3 (front-right)
 *   D5 -> XSHUT of ToF #4 (side)
 *   A4 -> SDA  (all VL53L0X share, with 4.7k pull-up to 3.3V)
 *   A5 -> SCL  (all VL53L0X share, with 4.7k pull-up to 3.3V)
 *   D6 -> HC-SR04 TRIG
 *   D7 <- HC-SR04 ECHO  (use a 1k/2k divider so 5V echo becomes ~3.3V)
 *   D8 -> piezo buzzer
 *   D9 -> vibration motor
 *
 *   TX (D1) -> ESP32-CAM GPIO 14 (the UART2 RX we configured in main.c)
 *              via a 1k/2k divider 5V -> 3.3V (DON'T connect 5V TX directly
 *              to a 3.3V input or you'll cook the ESP32 over time).
 *   GND <-> ESP32-CAM GND
 *
 * Library required:
 *   "VL53L0X" by Pololu (the same library your existing sketch uses)
 */

#include <Wire.h>
#include <VL53L0X.h>

// --- SETTINGS ---
const int thresholdCm = 30; // local alert threshold for buzzer/vibrator

// --- PINS ---
const int xshutPins[] = {2, 3, 4, 5};
#define TRIG_PIN   6
#define ECHO_PIN   7
#define BUZZER_PIN 8
#define VIB_PIN    9

// Sensor index -> human name (used inside the JSON we send to the ESP32)
//   0 = front center
//   1 = front-left
//   2 = front-right
//   3 = side
VL53L0X tofs[4];

// --- send-rate limiter ---
unsigned long lastSendMs = 0;
const unsigned long SEND_INTERVAL_MS = 50;

void setup() {
  // 9600 baud matches what the ESP32-CAM UART2 is configured to read.
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
      // If a sensor fails we keep going — it'll just send -1 forever.
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

void loop() {
  // 1) Read everything
  int front  = readToFCm(0);
  int fl     = readToFCm(1);
  int fr     = readToFCm(2);
  int side   = readToFCm(3);
  int ground = readUltrasonicCm();

  // 2) Decide local alert (buzzer + vibrator)
  bool alert = false;
  int candidates[5] = { front, fl, fr, side, ground };
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

  // 3) Forward sensor JSON to ESP32 every SEND_INTERVAL_MS
  unsigned long now = millis();
  if (now - lastSendMs >= SEND_INTERVAL_MS) {
    lastSendMs = now;
    Serial.print("{\"front\":"); Serial.print(front);
    Serial.print(",\"fl\":");     Serial.print(fl);
    Serial.print(",\"fr\":");     Serial.print(fr);
    Serial.print(",\"side\":");   Serial.print(side);
    Serial.print(",\"ground\":"); Serial.print(ground);
    Serial.print(",\"alert\":");  Serial.print(alert ? 1 : 0);
    Serial.println("}");
  }

  delay(20);
}

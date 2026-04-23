# IntelliCane

> A smart cane for the visually impaired that **sees, speaks, and screams for help**.

IntelliCane is an open-hardware assistive device built around an ESP32-CAM, an Arduino Nano, a fan of distance sensors, and a Capacitor-wrapped Android app. It streams what's in front of the user, calls out obstacles by direction and distance, recognizes everyday objects with on-device AI, detects falls from the phone's IMU, and can dispatch an SMS + phone call to a guardian with a Google Maps link to the user's location — all from a single hold of the cane button.

This README explains every part of the system from scratch — pretend you've just been handed the device and have never seen the project before.

---

## Table of Contents

1. [What it does, in one minute](#what-it-does-in-one-minute)
2. [System architecture](#system-architecture)
3. [Hardware bill of materials](#hardware-bill-of-materials)
4. [Sensor head layout (the semicircular disc)](#sensor-head-layout-the-semicircular-disc)
5. [Wiring](#wiring)
6. [Firmware: Arduino Nano](#firmware-arduino-nano)
7. [Firmware: ESP32-CAM](#firmware-esp32-cam)
8. [The phone app (Capacitor + React)](#the-phone-app-capacitor--react)
9. [End-to-end data flow](#end-to-end-data-flow)
10. [SOS & fall-detection logic](#sos--fall-detection-logic)
11. [Building & flashing everything](#building--flashing-everything)
12. [Demo walkthrough](#demo-walkthrough)
13. [Troubleshooting](#troubleshooting)
14. [Repo layout](#repo-layout)
15. [Roadmap](#roadmap)
16. [License & credits](#license--credits)

---

## What it does, in one minute

A blind user holds the IntelliCane like a normal white cane. Mounted on the cane head are:

- **5 distance sensors** in a semicircle: 1 ultrasonic dead-ahead and 4 laser ToF lasers spread at ±20° and ±45°.
- A **camera** for AI object recognition.
- A **physical button** for SOS / single-tap acknowledge / two speed-dial buttons.
- A **piezo buzzer + vibration motor** for non-audio feedback.

Everything is governed by an ESP32-CAM that broadcasts its own WiFi access point called `IntelliCane`. The user's phone joins that AP and runs the IntelliCane Android app, which:

- Shows the live camera view with bounding boxes for detected objects (people, chairs, cars, doors, stairs, etc.) using a quantized YOLO model running **on the phone** through TensorFlow Lite.
- Speaks every detection and every dangerous-proximity reading aloud with native text-to-speech ("**Person ahead, 80 centimeters**").
- Watches the phone's accelerometer for a fall; if one happens, starts a 25-second countdown the user can cancel by pressing any button on the cane. If the countdown elapses, an SMS with location + a phone call go out to the guardian automatically.
- Accepts **press-and-hold** SOS (text at 0.9 s, also call at 2 s) so a panic press always works even if the user can't navigate menus.

That's the elevator pitch. The rest of this document explains *how*.

---

## System architecture

```
                          ┌────────────────────────────┐
                          │  Android phone (Capacitor) │
                          │  ─ React + Vite UI         │
                          │  ─ TFLite object detection │
                          │  ─ TTS / SMS / Call / GPS  │
                          │  ─ Fall detector (IMU)     │
                          └──────────────┬─────────────┘
                                         │ WiFi STA
                                         │ (joins SSID "IntelliCane")
                                         ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │ ESP32-CAM  (SoftAP 192.168.4.1)                                 │
   │  ┌─────────────────────────────────────────────────────────┐    │
   │  │  Control HTTP server (port 80)                          │    │
   │  │     GET /sensors  → latest Nano JSON + age              │    │
   │  │     GET /sos      → next button event (long-poll)       │    │
   │  │     POST /vibrate?on=1|0 → tells Nano to buzz           │    │
   │  │     GET /health   → uptime, free heap, version          │    │
   │  └─────────────────────────────────────────────────────────┘    │
   │  ┌─────────────────────────────────────────────────────────┐    │
   │  │  MJPEG stream server (port 81)                          │    │
   │  │     GET /stream   → multipart/x-mixed-replace           │    │
   │  └─────────────────────────────────────────────────────────┘    │
   │  Camera (OV2640) ──► JPEG frames ──► /stream                    │
   │  Button GPIO (active-low) ──► SOS event queue ──► /sos          │
   │  UART2 (GPIO13/14, 9600 8N1) ◄──► Arduino Nano                  │
   └──────────────────────────────────┬──────────────────────────────┘
                                      │ Serial
                                      ▼
            ┌────────────────────────────────────────────────┐
            │ Arduino Nano                                   │
            │  4x VL53L0X ToF (I²C, individual XSHUT)        │
            │  1x HC-SR04 ultrasonic                         │
            │  Buzzer + vibration motor                      │
            │  TX every ~50 ms:                              │
            │     {"front":F,"inL":IL,"inR":IR,              │
            │      "outL":OL,"outR":OR,"alert":A,"fall":B}   │
            │  RX single-byte commands:                      │
            │     'V' → vibrate continuously (fall mode)     │
            │     'S' → stop continuous vibrate              │
            └────────────────────────────────────────────────┘
```

Why split the work this way?
- **Nano** is dirt-cheap, has plenty of GPIO, and never has to know about WiFi. It's the analog heart: read sensors fast, drive haptics, push JSON.
- **ESP32-CAM** has the camera, WiFi, and enough RAM for two HTTP servers. It is a *bridge*: it relays Nano JSON to the phone and accepts vibrate commands back.
- **Phone** does heavy lifting it's already good at: AI inference, TTS, GPS, SMS, calls, fall detection from the IMU, and the user-facing UI.

This separation means the cane works **without internet** — the phone joins the cane's own AP. The only outbound traffic is the SMS / phone call, which uses the phone's normal cellular connection.

---

## Hardware bill of materials

| Qty | Part                              | Notes                                                    |
|----:|-----------------------------------|----------------------------------------------------------|
| 1   | ESP32-CAM (AI-Thinker)            | OV2640 camera onboard. 5 V or 3.3 V supply.              |
| 1   | Arduino Nano                      | ATmega328P, 5 V logic.                                   |
| 4   | VL53L0X ToF sensor breakout       | All on the same I²C bus, addressed via XSHUT pins.       |
| 1   | HC-SR04 ultrasonic                | 5 V, needs a 1k/2k divider on ECHO into the Nano D7.     |
| 1   | Piezo buzzer                      | Driven from D8 with `tone()`.                            |
| 1   | Vibration motor + 1 NPN driver    | D9 → base of transistor → motor → 5 V.                   |
| 1   | Tactile push-button (SPST)        | Wired between ESP32 GPIO15 and GND, active-low.          |
| 1   | 3D-printed semicircular sensor disc | Holds the 4 ToF lasers around the cane head.           |
| 1   | White PVC cane body               | 22 mm OD works with the printed disc.                    |
| 1   | LiPo / 18650 + buck converter     | 3.7 V → 5 V; the ESP32-CAM is the heaviest draw.         |

You also need a USB-TTL adapter to flash the ESP32-CAM (the AI-Thinker board has no on-board USB).

---

## Sensor head layout (the semicircular disc)

Looking down on top of the cane, with the user's forward direction = up:

```
                    FRONT (HC-SR04, 0°)
                           │
        outL (-45°)        │        outR (+45°)
               ┌───────────┼───────────┐
               │  inL(-20) │  inR(+20) │
               └─────┐     │     ┌─────┘
                     └─────┴─────┘
                           ║
                         (cane)
```

- **`front`** — the HC-SR04 ultrasonic mounted on top of the disc, pointing dead-ahead at 0°. Wide cone (~30°) catches anything centered in front.
- **`inL` / `inR`** — the two **inner** ToF lasers at -20° / +20°. They cover the immediate cone the user's body will walk into.
- **`outL` / `outR`** — the two **outer** ToF lasers at -45° / +45°. They cover the wider arc — walls, doorframes, side obstacles.

There is intentionally **no laser at exactly 0°** because the ultrasonic already has that covered with a wider beam, and bouncing two beams off each other at the same angle is wasted hardware.

If after assembly the directions feel mirrored (e.g. the app says "front-left" when you wave at the right), just swap entries in the Nano's `xshutPins[]` array — that single line change re-numbers the lasers without resoldering.

---

## Wiring

**Arduino Nano**

| Nano pin | Connected to                                            |
|----------|---------------------------------------------------------|
| D2       | XSHUT of ToF #0 → assigned address 0x30 → reported as `outL` (-45°) |
| D3       | XSHUT of ToF #1 → address 0x31 → `inL` (-20°)           |
| D4       | XSHUT of ToF #2 → address 0x32 → `inR` (+20°)           |
| D5       | XSHUT of ToF #3 → address 0x33 → `outR` (+45°)          |
| A4 (SDA) | All four ToF SDA, with 4.7 kΩ pull-up to 3.3 V          |
| A5 (SCL) | All four ToF SCL, with 4.7 kΩ pull-up to 3.3 V          |
| D6       | HC-SR04 TRIG                                            |
| D7       | HC-SR04 ECHO **through 1k/2k divider** (5 V → 3.3 V-ish)|
| D8       | Piezo buzzer +                                          |
| D9       | Base of NPN driving the vibration motor                 |
| D1 (TX)  | ESP32 GPIO14 (UART2 RX) **through 1k/2k divider**       |
| D0 (RX)  | ESP32 GPIO13 (UART2 TX) — direct (3.3 V→5 V is OK)      |
| GND      | Common ground with ESP32 + battery                      |

> ⚠ While D0 is wired to the ESP32 you **cannot** USB-flash the Nano — the two TX sources fight on RX. Disconnect that one wire while flashing, then put it back.

**ESP32-CAM**

| ESP32 pin | Connected to                                |
|-----------|---------------------------------------------|
| GPIO13    | UART2 TX → Nano D0 (direct)                 |
| GPIO14    | UART2 RX ← Nano D1 (through divider)        |
| GPIO15    | SOS button → GND (active low, internal pullup) |
| 5V / 3V3  | From battery via buck converter             |
| GND       | Common with Nano                            |
| GPIO0     | Pull to GND only when flashing, then release |

---

## Firmware: Arduino Nano

File: [`attached_assets/IntelliCane_Nano_1776842224803.ino`](attached_assets/IntelliCane_Nano_1776842224803.ino)

### What it does, every loop

1. **Drain incoming serial bytes from the ESP32** for single-byte commands:
   - `'V'` → enter *force-vibrate* mode (used for fall alerts).
   - `'S'` → leave force-vibrate mode.
2. **Read all 5 distance channels** (4 ToF + 1 HC-SR04). A reading of `-1` means "no echo / timeout".
3. **Decide local alert**:
   - If force-vibrate is on, pin the vibration motor HIGH, silence the buzzer, set `alert:1` in JSON.
   - Otherwise, if any of the 5 channels is below the threshold (default **30 cm**), buzz + vibrate + `alert:1`.
4. **Every 50 ms (≈20 Hz)**, push one JSON line over Serial:
   ```json
   {"front":120,"inL":85,"inR":-1,"outL":200,"outR":140,"alert":0,"fall":0}
   ```

### Why VL53L0X needs XSHUT trickery

All four ToF chips ship with the same I²C address (0x29). To use them on the same bus we keep them in shutdown via XSHUT, then bring them up one at a time and reassign each to a unique address (0x30…0x33). That is exactly what `setup()` does — failure on any of the four prints `{"err":"tof_init_fail","i":N}` so you can see which sensor didn't respond.

---

## Firmware: ESP32-CAM

File: [`attached_assets/cam_project_1776842203828.c`](attached_assets/cam_project_1776842203828.c)

### Boot sequence

1. Brings up the camera (OV2640) at QVGA 320×240 JPEG, quality 12.
2. Starts a SoftAP with SSID `IntelliCane` (WPA2, password compiled in). Default IP is `192.168.4.1`.
3. Starts UART2 on GPIO13/14 at 9600 baud and a background task that parses one JSON line at a time from the Nano into a thread-safe latest-reading struct.
4. Configures GPIO15 as input-pullup with an interrupt on falling edge. Press time is measured in the ISR; on release the press duration is classified into one of:
   - **`ack`** — short tap (< 700 ms)
   - **`call1`** — medium hold (700–1500 ms)
   - **`call2`** — long-medium hold (1500–2500 ms)
   - **`sos`** — long hold (≥ 2500 ms)
   The event is pushed onto a small queue.
5. Starts **two** HTTP servers:
   - **Control** on port **80** with 4 sockets.
   - **Stream** on port **81** with 3 sockets.

The split is critical: we keep the long-lived MJPEG socket on its own server so it can't starve the short-lived control sockets. The total socket budget (4+3) plus DHCP/DNS sockets stays under LWIP's 10-socket cap, which is what was silently breaking the original "single big server" build.

### HTTP endpoints

| Method | Path        | Purpose                                                      |
|--------|-------------|--------------------------------------------------------------|
| GET    | `/sensors`  | Returns `{ status:"ok", age_ms, data: <Nano JSON> }`.        |
| GET    | `/sos`      | Long-poll the next button event from the queue (or `{type:"none"}` after a timeout). |
| POST   | `/vibrate`  | `?on=1` or `?on=0` — forwards `'V'` / `'S'` to the Nano.     |
| GET    | `/health`   | `{ ok, uptime_ms, free_heap, stream_port, version }`.        |
| GET    | `/stream`   | (port 81) MJPEG `multipart/x-mixed-replace` boundary stream. |

### Sensor JSON shape relayed to the phone

The ESP32 doesn't reinterpret Nano data — it just wraps it:

```json
{
  "status": "ok",
  "age_ms": 38,
  "data": {
    "front": 130, "inL": 75, "inR": 90,
    "outL": 220, "outR": 180,
    "alert": 0, "fall": 0
  }
}
```

`age_ms` is "how long ago we received this from the Nano" — useful to spot a dead serial link.

---

## The phone app (Capacitor + React)

Path: [`artifacts/smart-cane/`](artifacts/smart-cane/)

A **Vite + React + TypeScript** SPA wrapped by Capacitor for Android. UI uses Tailwind + a small set of shadcn-style components.

### Top-level pages (bottom nav)

| Tab        | What lives there                                                  |
|------------|-------------------------------------------------------------------|
| **Active** | Live MJPEG feed, START/STOP detection, the 5-sensor dashboard with the IntelliCane logo cell. |
| **Settings** | Cane host IP, guardian phone, two speed-dial numbers, user name, target FPS, confidence threshold, fall-detection on/off + sensitivity. |
| **Status** (Diagnostics) | Browser-capability checks, **HOLD-FOR-SOS** button, mute toggle, **Simulate cane button** demo grid, **Last 5 button events** log, hardware connection panel, raw sensor feed. |
| **About** | Brief project description and credits. |

### Key client modules

- **`src/lib/esp32.ts`** — `ESP32Client`. Polls `/sensors` at ~10 Hz and `/sos` at long-poll cadence, polls `/health` every 3 s, and tracks `lastContactMs` (max of any successful network event). Exposes `streamUrl`, `markFrameReceived()`, `setVibrate()`.
- **`src/hooks/use-smart-cane.tsx`** — React context provider that owns the client, tracks `audioMuted`, runs the obstacle announcer, runs the SOS pipeline (`triggerSos`), runs the fall countdown, and now exposes `sosHistory` (last 5 events) + `simulateSos(type)` for the diagnostics demo grid.
- **`src/lib/yolo.ts`** — Loads `public/yolo.tflite` and runs inference on a `<canvas>` capture of the MJPEG `<img>`. Returns class + confidence + normalized bbox.
- **`src/lib/tts.ts`** — TTS facade. Prefers the Capacitor native plugin (so it works while the screen is off); falls back to `window.speechSynthesis` in the browser. Has a per-key cooldown so we don't spam "person, person, person".
- **`src/lib/sms.ts`** — Wraps Capacitor's SMS plugin (silent send on Android with permission) and falls back to `sms:` composer URI on the web. Has `placeCall(phone, {speakerOn, maxVolume})` for emergency calls.
- **`src/lib/geo.ts`** — `getLocationOnce(timeoutMs)` + `googleMapsLink(lat, lng)`.
- **`src/lib/fallDetect.ts`** — Subscribes to `DeviceMotionEvent`, computes magnitude, triggers a fall when free-fall (low magnitude) is followed by a hard impact (high magnitude). Sensitivity is a numeric threshold the user sets in Settings.
- **`src/lib/wakeLock.ts`** — Holds the screen wake lock while detection is running.

### The 5-sensor dashboard (Active page)

A 3×2 grid mirroring the physical disc:

```
[ Outer L  -45° ] [ Front  0°  ] [ Outer R  +45° ]
[ Inner L  -20° ] [INTELLICANE  ] [ Inner R  +20° ]
                  cane + wifi logo
```

Distance text turns **destructive red** below 50 cm and **primary orange** below 100 cm so a sighted helper can see a hazard at a glance. The center-bottom cell is the IntelliCane logo (a cane icon with a wifi badge) — there's no sixth physical sensor to put there, and the logo visually anchors the four directional cells around the cane itself.

### The Diagnostics console

Built as a one-stop demo console:

- **HOLD-FOR-SOS** — same press-and-hold as the in-app SOS used to be, but living next to its siblings. < 0.9 s does nothing (no pocket misfires); ≥ 0.9 s sends an SMS with location; ≥ 2 s also places the call.
- **Mute toggle** — silences all TTS instantly and stops the queue.
- **Simulate cane button** — four buttons that inject a synthetic event of each type (`ack`, `sos`, `call1`, `call2`) into the same handler the real `/sos` poll uses. Speech, fall-cancel, SMS, and calls all behave exactly the same — useful for stage demos when you don't want to keep tapping a physical button.
- **Last 5 button events** — newest-first list with a coloured badge per type and a localized timestamp. Updates whether the event came from the cane or the simulator.
- **Browser capabilities** — TTS / wake lock / network / geolocation / SMS / TFLite model status with green / red badges.
- **Hardware connection** — current poll state, ESP32 hostname, and a small live MJPEG preview separate from the main one (so you can confirm the stream socket is alive while running detection on the Active tab).
- **Latest SOS** — last received button event timestamp + the latest send outcome (with the maps link).
- **Raw sensor feed** — last 20 raw JSON readings, oldest at the bottom.

---

## End-to-end data flow

A typical "person walks in front of the user" cycle:

1. The Nano's HC-SR04 measures 80 cm. The Nano emits its 50 ms JSON line over UART.
2. The ESP32-CAM's UART2 task captures the line into the latest-reading struct.
3. The phone's `ESP32Client` polls `GET /sensors` (~10 Hz). It receives `{"data":{"front":80,...}}` and calls every `onSensor` listener.
4. The `useSmartCane` provider:
   - Pushes the reading to `sensorLog`.
   - Updates `latestSensor` so the Active page rerenders the grid.
   - Picks the closest of the 5 channels (here, `front=80`) and translates it to `"ahead"`.
   - Calls `announceObstacle(80, "ahead")` which queues `"Obstacle ahead, 80 centimeters"` into the TTS engine.
5. Concurrently, the Active page's MJPEG `<img>` is decoding frames at ~15 fps. The detection loop grabs the current image into a hidden canvas, runs YOLO, gets a `person` detection, draws the bbox, and TTS announces `"person"` (with cooldown so it doesn't shout every frame).
6. If the user holds the cane button:
   - The ESP32 ISR captures the press; on release, `'sos'` is queued.
   - The phone's long-poll on `/sos` returns it; the SOS handler runs `triggerSos({alsoCall:true})`.
   - That calls `getLocationOnce()`, builds the SMS body, sends it via the Capacitor plugin, and (because `alsoCall` is true) places the phone call.
   - Result is announced via TTS and shown as a toast.

---

## SOS & fall-detection logic

### Cane-button SOS (real or simulated)

```
press duration   →  event type   →  app behaviour
─────────────────────────────────────────────────────────────────────
< 700 ms             ack             "Cane button received." TTS;
                                     also cancels an active fall countdown.
700–1500 ms          call1           Speed-dial "Person 1" with speaker on.
1500–2500 ms         call2           Speed-dial "Person 2" with speaker on.
≥ 2500 ms            sos             SMS guardian + call guardian (speaker on, max volume).
```

Inside the app there's an additional press-and-hold SOS on the diagnostics page with its own thresholds (0.9 s text, 2 s call) for when the cane button isn't reachable.

### Fall detection

- Listens to `DeviceMotionEvent`. The detector computes the acceleration magnitude.
- A **fall** is registered when the magnitude drops well below 1 g (free-fall) and then spikes well above a configurable threshold (impact).
- On detection, the app:
  1. Sends `'V'` to the cane → vibrate non-stop.
  2. Buzzes the phone with a long pattern.
  3. Speaks `"Possible fall detected. Press the cane button or the I'm OK button if you are okay. Otherwise help will be called in 25 seconds."`
  4. Shows a full-screen overlay with a 25 s countdown ring + a big "I'm OK" button.
- **Cancel** = pressing the cane button (any kind), tapping I'm OK, or calling `cancelFallAlert()` from code.
- If 25 s elapse without cancel: `triggerSos({alsoCall:true, kind:"fall"})` fires, which is the SOS pipeline above but with the SMS body labelled as a fall event.

---

## Building & flashing everything

### 1. Flash the Arduino Nano

```
Arduino IDE
  → install library: "VL53L0X" by Pololu
  → open  attached_assets/IntelliCane_Nano_1776842224803.ino
  → board: Arduino Nano (ATmega328P, Old Bootloader if you have a clone)
  → ⚠ disconnect the wire from D0 first, then upload
  → reconnect D0 after upload
```

### 2. Flash the ESP32-CAM

```
Arduino IDE
  → board manager: install "esp32" by Espressif
  → board: AI Thinker ESP32-CAM
  → flash mode: QIO, partition scheme: Huge APP (3 MB no OTA)
  → bring GPIO0 to GND, press RESET, upload, then release GPIO0 and press RESET again.
```

The compiled-in WiFi credentials live near the top of `cam_project_1776842203828.c`. Change `AP_PASS` before deployment.

### 3. Build the Android APK

```bash
cd artifacts/smart-cane
pnpm install
pnpm build
npx cap sync android
cd android
./gradlew installDebug          # for a connected device
# or
./gradlew assembleDebug         # produces app/build/outputs/apk/debug/*.apk
```

First-launch permissions to grant: Location (for the SOS map link), SMS (for silent send), Phone (for the emergency call), Notifications.

---

## Demo walkthrough

A scripted on-stage demo, ~3 minutes:

1. **Power on the cane.** Phone is already paired with the `IntelliCane` AP. Open the app → Active tab.
2. **Stream + sensors come alive.** The header pill shows green; the Active grid lights up with live distances; the camera feed appears.
3. **Wave a hand at each sensor in turn.** Watch the corresponding cell go red and hear the appropriate spoken direction (`"left"`, `"front-left"`, etc.).
4. **Tap START DETECTION.** Walk a person into frame; bounding box + spoken `"person"` appears.
5. **Switch to Status tab.** Tap **Simulate → Long-hold SOS**. Watch the toast, the spoken confirmation, and the entry that appears in **Last 5 button events**.
6. **Tap Simulate → Speed-dial 1**. Watch the call dialog spawn (or the dialer open if running on a phone without silent-call permission).
7. **Tap the mute button.** All TTS halts mid-sentence.

If you're showing the fall flow, drop the phone onto a soft surface (or use a separate `simulateFall` button) — the 25 s overlay appears, and pressing the cane button cancels it cleanly.

---

## Troubleshooting

**Black stream on the Active tab, but the connection pill says "connected".**
The control endpoints work but the MJPEG socket doesn't. Most common causes:
- Old APK still hits port 80 for the stream → rebuild with `pnpm build && npx cap sync android && ./gradlew installDebug`.
- The ESP32 silently failed to start the stream server. The new firmware logs `*** Stream httpd failed to start on :81 ***` in the ESP-IDF monitor — check there.

**Frame counter on the Active overlay stays at `0f`.**
Same as above — the stream socket isn't delivering. The `<img>`'s `onError` handler will retry every 1.5 s automatically.

**`last contact` seconds counter keeps climbing.**
Phone is no longer talking to the cane. Re-join the `IntelliCane` WiFi.

**Speech says "front" when an obstacle is clearly off to the side.**
Make sure you flashed the **v3 Nano firmware** in this repo and rebuilt the APK; the old build only watched 3 of the 5 channels.

**Directions are mirrored.**
Swap entries in `xshutPins[] = {2,3,4,5}` in the Nano `.ino`. That single line re-numbers the lasers without resoldering.

**`{"err":"tof_init_fail","i":2}` shows up at boot.**
Sensor 2 (D4 XSHUT) didn't init. Check its 4.7 kΩ pull-ups, its 3.3 V supply, and that XSHUT actually pulls high.

**SMS doesn't send silently.**
On Android, the app needs the `SEND_SMS` runtime permission. If denied, the app falls back to opening the SMS composer with the body pre-filled — the user just has to tap Send.

---

## Repo layout

```
.
├── attached_assets/
│   ├── cam_project_1776842203828.c          # ESP32-CAM firmware
│   └── IntelliCane_Nano_1776842224803.ino   # Arduino Nano firmware
├── artifacts/
│   ├── smart-cane/                          # Capacitor Android app (Vite + React)
│   │   ├── src/
│   │   │   ├── components/
│   │   │   │   ├── layout.tsx               # Header + bottom nav
│   │   │   │   └── fall-alert-overlay.tsx   # 25 s countdown overlay
│   │   │   ├── hooks/use-smart-cane.tsx     # ESP32 client + SOS + fall provider
│   │   │   ├── lib/
│   │   │   │   ├── esp32.ts                 # HTTP client (sensors, sos, health)
│   │   │   │   ├── tts.ts                   # Native + web TTS facade
│   │   │   │   ├── sms.ts                   # SMS + call wrapper
│   │   │   │   ├── geo.ts                   # GPS helper
│   │   │   │   ├── fallDetect.ts            # IMU-based fall detector
│   │   │   │   ├── yolo.ts                  # TFLite object detection
│   │   │   │   ├── settings.ts              # Persisted user prefs
│   │   │   │   └── wakeLock.ts              # Screen wake-lock helper
│   │   │   ├── pages/
│   │   │   │   ├── home.tsx                 # Active tab — live feed + sensor grid
│   │   │   │   ├── diagnostics.tsx          # Status tab — demo console
│   │   │   │   ├── settings.tsx
│   │   │   │   └── about.tsx
│   │   │   └── public/yolo.tflite           # Quantized YOLO model
│   │   └── android/                         # Capacitor-generated Android project
│   ├── api-server/                          # Tiny dev API (not used at runtime)
│   └── mockup-sandbox/                      # Component preview server
└── README.md                                # ← you are here
```

---

## Roadmap

- Live distance graph on the Diagnostics page (60-second rolling sparkline per channel).
- BLE pairing fallback when the user can't get the phone onto the cane's AP.
- Indoor wayfinding (compass + step counter) so the app can describe turns.
- A second "guardian" companion app that receives SOS notifications without relying on SMS.
- Offline OCR for reading nearby signs.

---

## License & credits

This project was built for an assistive-technology competition by Team IntelliCane. Hardware design, firmware, and app code are released under the MIT License.

Third-party components used:
- **VL53L0X library** — Pololu, MIT.
- **ESP32 Arduino core** — Espressif, LGPL/Apache.
- **TensorFlow Lite** — Google, Apache 2.0.
- **Capacitor** — Ionic, MIT.
- **lucide-react** icons — ISC.

Open issues and PRs welcome.

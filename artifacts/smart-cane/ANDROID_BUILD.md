# Building IntelliCane as an Android app

Your web app is now wrapped in **Capacitor** and an Android Studio project lives in `artifacts/smart-cane/android/`. Follow these steps to produce an installable `.apk` (or a signed `.aab` for the Play Store).

## What's already done

- Capacitor 8 is installed and configured (`capacitor.config.ts`).
- The Android platform has been generated under `android/`.
- A custom **silent SMS plugin** is wired in: `android/app/src/main/java/com/intellicane/app/SmsManagerPlugin.java`. When the SOS button fires, the SMS is sent through Android's `SmsManager.sendTextMessage()` — **no system composer, no confirmation dialog**.
- `AndroidManifest.xml` requests: `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `SEND_SMS`, `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `WAKE_LOCK`, `VIBRATE`, `MODIFY_AUDIO_SETTINGS`.
- `usesCleartextTraffic="true"` and `androidScheme: "https"` are set so the WebView can talk to the ESP32-CAM at `http://192.168.4.1`.
- The Capacitor Geolocation plugin is installed — `getLocationOnce()` will use the native fix when running on the phone.

## One-time setup on your machine

1. Install **Android Studio** (any recent stable, e.g. Iguana / Jellyfish).
   Inside Android Studio, open `Settings → SDK Manager` and make sure you have:
   - Android SDK Platform **API 34** (or whatever your `android/variables.gradle` requires)
   - Android SDK Build-Tools
   - Android SDK Command-line Tools
2. Install **JDK 17** (Android Studio bundles one — point `JAVA_HOME` to it if needed).
3. Make sure `pnpm` and `node` are installed locally.

## Build steps

From the project root:

```bash
pnpm install
cd artifacts/smart-cane
pnpm run cap:sync     # builds web + copies into android/
pnpm run cap:open:android    # opens Android Studio
```

In Android Studio:

1. Wait for Gradle sync to finish (first time can take 5–10 min while it downloads dependencies).
2. Plug in your phone with USB debugging enabled, or start an emulator.
3. Click **Run ▶**. The app installs and launches.

To produce a release `.apk`:

- `Build → Generate Signed Bundle / APK… → APK → Create new keystore → Release`.
- The APK lands in `android/app/release/app-release.apk`.

## When you change web code

Anytime you edit anything under `artifacts/smart-cane/src/`, run:

```bash
pnpm --filter @workspace/smart-cane run cap:sync
```

That rebuilds the web bundle and copies it into the Android project. Then just press Run again in Android Studio.

## SMS permission flow

On the very first SOS press, Android will pop up a one-time permission dialog asking the user to allow SMS. Once granted, every future SOS sends silently. If the user denies it, the SOS will fail with an error (we don't fall back to the composer in the native build).

You may want to surface a "Grant SMS permission" button on the Settings page that calls the plugin once with a dummy message — but the simpler approach is to pre-grant by holding the SOS button once during setup at home.

## Why your localhost Tailwind looked broken

The original `vite.config.ts` `throw`s if `PORT` and `BASE_PATH` env vars aren't set. When you ran `pnpm dev` locally without those set, the dev server crashed on startup and your browser was loading a stale or empty page — which is why "Tailwind didn't work". I changed it to default to `PORT=5173` and `BASE_PATH=/` for plain local dev, so `pnpm --filter @workspace/smart-cane run dev` now just works.

## Things to know

- The ESP32-CAM serves over plain `http://`. We allow cleartext explicitly. On Android 9+ that requires the `usesCleartextTraffic` flag we already added.
- The MJPEG stream and `/sensors` polling work the same in the WebView as in a browser — the inference, TTS, and SOS pipeline don't need any other changes.
- The TFLite model in your repo (`best_*.tflite`) is **not** what the app currently uses — the app loads `public/yolo.onnx` via `onnxruntime-web`. The bundled WASM (~11 MB) ships inside the APK, so the inference works fully offline once installed.
- If the SOS message also needs the user's name pre-filled, set it once on the Settings page — it's stored in `localStorage` and kept across launches inside the WebView.

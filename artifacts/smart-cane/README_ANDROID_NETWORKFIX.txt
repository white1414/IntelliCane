# Android HTTP Network Fix for ESP32-CAM

This project now includes AndroidManifest.xml and network_security_config.xml changes to allow cleartext HTTP access to the ESP32-CAM (at 192.168.4.1) from the IntelliCane app running as an Android APK (Capacitor wrapper).

**If you still get a black video feed or sensors fail to update:**
- Ensure your phone is joined to the IntelliCane WiFi hotspot, not home WiFi!
- Rebuild and reinstall the app:

    pnpm build && npx cap sync android && cd android && ./gradlew installDebug

- If problems persist, try uninstalling/reinstalling the APK. Some Android versions cache old permissions.
- For debugging, see logcat for CORS, network, or mixed-content errors.

**For further assistance, contact the repo maintainer.**


# Details

- AndroidManifest.xml includes:
    android:usesCleartextTraffic="true"
    android:networkSecurityConfig="@xml/network_security_config"
- network_security_config.xml permits all cleartext requests to 192.168.4.1 and local IP ranges.
- No code changes required in src/lib/esp32.ts unless you want extra diagnostics for failed HTTP(s) requests.

This should fully enable HTTP/MJPEG/SOS traffic to the cane via ESP32-CAM.
package com.intellicane.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.telephony.SmsManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * IntelliCane silent-SMS + emergency-call plugin.
 *
 * - send():       sends an SMS through Android's SmsManager with no UI prompt.
 * - placeCall():  starts an outgoing phone call directly via ACTION_CALL.
 *                 Optional opts:
 *                   speakerOn (boolean, default false) — force speakerphone on.
 *                   maxVolume (boolean, default false) — set in-call volume to max.
 *                 Both run via AudioManager AFTER the call starts. We retry
 *                 the audio routing on a short timer because the dialer
 *                 grabs audio focus asynchronously and would otherwise
 *                 clobber a single setSpeakerphoneOn(true) call.
 *
 * Both methods request their own runtime permission on first use.
 *
 * Exposed as `SmsManager` to JS — matches what src/lib/sms.ts looks for.
 */
@CapacitorPlugin(
    name = "SmsManager",
    permissions = {
        @Permission(strings = { Manifest.permission.SEND_SMS },   alias = "sms"),
        @Permission(strings = { Manifest.permission.CALL_PHONE }, alias = "phone")
    }
)
public class SmsManagerPlugin extends Plugin {

    @PluginMethod
    public void send(PluginCall call) {
        if (getPermissionState("sms") != PermissionState.GRANTED) {
            requestPermissionForAlias("sms", call, "smsPermissionCallback");
            return;
        }
        doSend(call);
    }

    @PermissionCallback
    private void smsPermissionCallback(PluginCall call) {
        if (getPermissionState("sms") == PermissionState.GRANTED) {
            doSend(call);
        } else {
            call.reject("SEND_SMS permission was denied. Cannot send SOS message.");
        }
    }

    private void doSend(PluginCall call) {
        JSArray numbers = call.getArray("numbers");
        String text = call.getString("text");

        if (numbers == null || numbers.length() == 0) {
            call.reject("No phone numbers provided.");
            return;
        }
        if (text == null || text.isEmpty()) {
            call.reject("Empty SMS body.");
            return;
        }

        try {
            SmsManager smsManager;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                smsManager = getContext().getSystemService(SmsManager.class);
            } else {
                smsManager = SmsManager.getDefault();
            }

            ArrayList<String> recipients = new ArrayList<>();
            for (int i = 0; i < numbers.length(); i++) {
                recipients.add(numbers.getString(i));
            }

            int sentCount = 0;
            StringBuilder errors = new StringBuilder();
            for (String number : recipients) {
                try {
                    ArrayList<String> parts = smsManager.divideMessage(text);
                    if (parts.size() > 1) {
                        smsManager.sendMultipartTextMessage(number, null, parts, null, null);
                    } else {
                        smsManager.sendTextMessage(number, null, text, null, null);
                    }
                    sentCount++;
                } catch (Exception inner) {
                    if (errors.length() > 0) errors.append("; ");
                    errors.append(number).append(": ").append(inner.getMessage());
                }
            }

            if (sentCount == 0) {
                call.reject("Failed to send to any recipient. " + errors.toString());
                return;
            }

            JSObject ret = new JSObject();
            ret.put("sent", true);
            ret.put("count", sentCount);
            if (errors.length() > 0) ret.put("partialErrors", errors.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("SmsManager error: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void placeCall(PluginCall call) {
        if (getPermissionState("phone") != PermissionState.GRANTED) {
            requestPermissionForAlias("phone", call, "phonePermissionCallback");
            return;
        }
        doCall(call);
    }

    @PermissionCallback
    private void phonePermissionCallback(PluginCall call) {
        if (getPermissionState("phone") == PermissionState.GRANTED) {
            doCall(call);
        } else {
            call.reject("CALL_PHONE permission was denied. Cannot place SOS call.");
        }
    }

    private void doCall(PluginCall call) {
        String number = call.getString("number");
        if (number == null || number.isEmpty()) {
            call.reject("No phone number provided.");
            return;
        }
        Boolean speakerOn = call.getBoolean("speakerOn", Boolean.FALSE);
        Boolean maxVolume = call.getBoolean("maxVolume", Boolean.FALSE);

        try {
            Intent intent = new Intent(Intent.ACTION_CALL);
            intent.setData(Uri.parse("tel:" + number));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);

            if (Boolean.TRUE.equals(speakerOn) || Boolean.TRUE.equals(maxVolume)) {
                forceCallAudioRouting(Boolean.TRUE.equals(speakerOn), Boolean.TRUE.equals(maxVolume));
            }

            JSObject ret = new JSObject();
            ret.put("placed", true);
            ret.put("speakerOn", Boolean.TRUE.equals(speakerOn));
            ret.put("maxVolume", Boolean.TRUE.equals(maxVolume));
            call.resolve(ret);
        } catch (SecurityException se) {
            call.reject("Missing CALL_PHONE permission: " + se.getMessage(), se);
        } catch (Exception e) {
            call.reject("Failed to place call: " + e.getMessage(), e);
        }
    }

    /**
     * Force speakerphone on and/or set the voice-call stream to max volume.
     *
     * The OS dialer takes audio focus asynchronously, so a single
     * setSpeakerphoneOn(true) right after startActivity() usually gets
     * clobbered. We retry every 500 ms for ~4 s, which is empirically
     * enough on Android 8–14 to make the routing stick once the call
     * actually connects.
     *
     * Requires android.permission.MODIFY_AUDIO_SETTINGS in the manifest.
     */
    private void forceCallAudioRouting(final boolean speakerOn, final boolean maxVolume) {
        final AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        final Handler handler = new Handler(Looper.getMainLooper());
        final Runnable applier = new Runnable() {
            int attempts = 0;
            @Override
            public void run() {
                try {
                    // MODE_IN_CALL is what most dialers settle into; setting
                    // it ourselves nudges the AudioManager to honour our
                    // speakerphone/volume changes immediately.
                    am.setMode(AudioManager.MODE_IN_CALL);
                    if (speakerOn) {
                        am.setSpeakerphoneOn(true);
                    }
                    if (maxVolume) {
                        int max = am.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL);
                        am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, max, 0);
                    }
                } catch (Exception ignored) {
                    // Some OEMs throw if the call hasn't actually connected
                    // yet — that's fine, the next retry will succeed.
                }
                attempts++;
                if (attempts < 8) {
                    handler.postDelayed(this, 500);
                }
            }
        };
        // First attempt slightly delayed so the dialer has time to spawn.
        handler.postDelayed(applier, 800);
    }
}

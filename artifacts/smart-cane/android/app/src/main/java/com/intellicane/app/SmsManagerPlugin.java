package com.intellicane.app;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
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
        try {
            Intent intent = new Intent(Intent.ACTION_CALL);
            intent.setData(Uri.parse("tel:" + number));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);

            JSObject ret = new JSObject();
            ret.put("placed", true);
            call.resolve(ret);
        } catch (SecurityException se) {
            call.reject("Missing CALL_PHONE permission: " + se.getMessage(), se);
        } catch (Exception e) {
            call.reject("Failed to place call: " + e.getMessage(), e);
        }
    }
}

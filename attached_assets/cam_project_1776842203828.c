// main.c — IntelliCane ESP32-CAM (ESP-IDF)  v2
//
// Adds on top of v1:
//   - Multi-click detection on the SOS button (GPIO 15):
//        * Hold >= 2 s            -> "sos"   (panic, full SMS+call)
//        * 2 quick clicks         -> "call1" (speed-dial Person 1)
//        * 3 quick clicks         -> "call2" (speed-dial Person 2)
//        * Single click           -> "ack"   (used to cancel a fall alert)
//     A click is a press shorter than 600 ms; consecutive clicks must arrive
//     within 500 ms of each other to be merged. Once we report a "sos" hold
//     we ignore any further presses until the user releases.
//   - UART2 is now bi-directional: GPIO 13 = TX out to Nano D0 (RX). The
//     phone hits POST /vibrate?on=1 (or 0) and we send 'V' or 'S' down the
//     wire. This lets the phone tell the cane's vibrator to buzz non-stop
//     during a suspected-fall countdown.
//
// Pin map summary (AI-Thinker ESP32-CAM):
//   GPIO 14  — UART2 RX  (Nano TX through 1k/2k divider 5V → 3.3V)
//   GPIO 13  — UART2 TX  (to Nano D0/RX, direct — 3.3V is a valid HIGH for Nano)
//   GPIO 15  — SOS push button to GND (active low, internal pull-up)
//   GPIO 1   — UART0 TX  (ESP-IDF log / programming)
//   GPIO 3   — UART0 RX  (programming)
//
// Endpoints:
//   GET  /            — MJPEG stream (multipart/x-mixed-replace)
//   GET  /frame.jpg   — single JPEG snapshot
//   GET  /sos         — JSON, returns latest button event then clears.
//                       Shape: {"type":"sos|call1|call2|ack","time":1234}
//                       or     {"type":"idle"}
//   GET  /sensors     — JSON, latest Nano sensor reading
//   POST /vibrate?on=1  — start continuous vibrate on the Nano motor
//   POST /vibrate?on=0  — stop continuous vibrate

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_system.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "esp_camera.h"
#include "esp_http_server.h"
#include "driver/gpio.h"
#include "driver/i2c.h"
#include "driver/uart.h"
#include "esp_timer.h"
#include "sdkconfig.h"

static const char *TAG = "intellicane";

/* ---------------- AI-Thinker ESP32-CAM pin mapping ---------------- */
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

/* ---------------- I2C config ---------------- */
#define I2C_MASTER_NUM            I2C_NUM_0
#define I2C_MASTER_SDA_IO         SIOD_GPIO_NUM
#define I2C_MASTER_SCL_IO         SIOC_GPIO_NUM
#define I2C_MASTER_FREQ_HZ        100000

/* ---------------- WiFi AP credentials ---------------- */
#define AP_SSID "IntelliCane"
#define AP_PASS "sotgofa1"

/* ---------------- SOS button ---------------- */
#define SOS_BUTTON_GPIO        15
#define SOS_HOLD_REQUIRED_MS   2000   // long-hold = panic
#define CLICK_MAX_PRESS_MS      600   // press shorter than this counts as a click
#define CLICK_GROUP_GAP_MS      500   // gap between clicks to be considered same group

/* ---------------- Nano UART link (bidirectional) ---------------- */
#define NANO_UART_NUM   UART_NUM_2
#define NANO_UART_RX    14
#define NANO_UART_TX    13
#define NANO_UART_BAUD  9600
#define NANO_UART_BUF   1024

/* ---------------- MJPEG / camera ---------------- */
#define MJPEG_BOUNDARY      "frame"
#define CAMERA_FRAME_SIZE   FRAMESIZE_VGA
#define CAMERA_JPEG_QUALITY 10
#define CAMERA_FB_COUNT     2

/* ---------------- Globals ---------------- */
// Latest pending button event, consumed by /sos handler.
typedef enum {
    EV_NONE = 0,
    EV_SOS,
    EV_CALL1,
    EV_CALL2,
    EV_ACK,
} btn_event_t;

static volatile btn_event_t s_pending_event = EV_NONE;
static volatile int64_t     s_pending_time_ms = 0;
static portMUX_TYPE         s_event_mux = portMUX_INITIALIZER_UNLOCKED;

#define SENSOR_LINE_MAX 256
static char        g_sensors_json[SENSOR_LINE_MAX] = "";
static int64_t     g_sensors_ts_ms                  = 0;
static portMUX_TYPE s_sensors_mux                   = portMUX_INITIALIZER_UNLOCKED;

/* Forward declarations */
void  i2c_init(void);
static esp_err_t      camera_init_board(void);
static void           wifi_init_ap(void);
static esp_err_t      stream_handler(httpd_req_t *req);
static esp_err_t      frame_handler(httpd_req_t *req);
static esp_err_t      sos_handler(httpd_req_t *req);
static esp_err_t      sensors_handler(httpd_req_t *req);
static esp_err_t      vibrate_handler(httpd_req_t *req);
static httpd_handle_t start_webserver(void);
static void           sos_button_init(void);
static void           sos_button_task(void *arg);
static void           nano_uart_init(void);
static void           nano_uart_task(void *arg);
static void           push_event(btn_event_t ev);

/* ---------------- I2C init ---------------- */
void i2c_init() {
    i2c_config_t conf = {
        .mode = I2C_MODE_MASTER,
        .sda_io_num = I2C_MASTER_SDA_IO,
        .scl_io_num = I2C_MASTER_SCL_IO,
        .sda_pullup_en = GPIO_PULLUP_ENABLE,
        .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = I2C_MASTER_FREQ_HZ,
    };
    i2c_param_config(I2C_MASTER_NUM, &conf);
    i2c_driver_install(I2C_MASTER_NUM, conf.mode, 0, 0, 0);
}

/* ---------------- Camera init ---------------- */
static esp_err_t camera_init_board() {
    camera_config_t config;
    memset(&config, 0, sizeof(config));
    config.ledc_channel = LEDC_CHANNEL_0;
    config.ledc_timer   = LEDC_TIMER_0;
    config.pin_d0 = Y2_GPIO_NUM; config.pin_d1 = Y3_GPIO_NUM;
    config.pin_d2 = Y4_GPIO_NUM; config.pin_d3 = Y5_GPIO_NUM;
    config.pin_d4 = Y6_GPIO_NUM; config.pin_d5 = Y7_GPIO_NUM;
    config.pin_d6 = Y8_GPIO_NUM; config.pin_d7 = Y9_GPIO_NUM;
    config.pin_xclk  = XCLK_GPIO_NUM;
    config.pin_pclk  = PCLK_GPIO_NUM;
    config.pin_vsync = VSYNC_GPIO_NUM;
    config.pin_href  = HREF_GPIO_NUM;
    config.pin_sccb_sda = SIOD_GPIO_NUM;
    config.pin_sccb_scl = SIOC_GPIO_NUM;
    config.pin_pwdn  = PWDN_GPIO_NUM;
    config.pin_reset = RESET_GPIO_NUM;
    config.xclk_freq_hz = 20000000;
    config.pixel_format = PIXFORMAT_JPEG;
    config.frame_size   = CAMERA_FRAME_SIZE;
    config.jpeg_quality = CAMERA_JPEG_QUALITY;
    config.fb_count     = CAMERA_FB_COUNT;
    config.grab_mode    = CAMERA_GRAB_LATEST;

    esp_err_t err = esp_camera_init(&config);
    if (err != ESP_OK) ESP_LOGE(TAG, "Camera init failed: 0x%x", err);
    return err;
}

/* ---------------- WiFi AP init ---------------- */
static void wifi_init_ap(void) {
    esp_netif_init();
    esp_event_loop_create_default();
    esp_netif_create_default_wifi_ap();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    esp_wifi_init(&cfg);

    wifi_config_t wifi_config = {0};
    strncpy((char *)wifi_config.ap.ssid, AP_SSID, sizeof(wifi_config.ap.ssid));
    strncpy((char *)wifi_config.ap.password, AP_PASS, sizeof(wifi_config.ap.password));
    wifi_config.ap.ssid_len      = strlen(AP_SSID);
    wifi_config.ap.max_connection = 4;
    wifi_config.ap.authmode      = WIFI_AUTH_WPA_WPA2_PSK;

    esp_wifi_set_mode(WIFI_MODE_AP);
    esp_wifi_set_config(WIFI_IF_AP, &wifi_config);
    esp_wifi_start();
    ESP_LOGI(TAG, "AP up. SSID:%s", AP_SSID);
}

/* ---------------- MJPEG stream handler ---------------- */
static esp_err_t stream_handler(httpd_req_t *req) {
    char part_buf[128];
    httpd_resp_set_type(req, "multipart/x-mixed-replace; boundary=" MJPEG_BOUNDARY);
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

    while (true) {
        camera_fb_t *fb = esp_camera_fb_get();
        if (!fb) { vTaskDelay(pdMS_TO_TICKS(10)); continue; }

        int hlen = snprintf(part_buf, sizeof(part_buf),
            "\r\n--" MJPEG_BOUNDARY "\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n",
            (unsigned int)fb->len);
        if (httpd_resp_send_chunk(req, part_buf, hlen) != ESP_OK) {
            esp_camera_fb_return(fb); break;
        }
        if (httpd_resp_send_chunk(req, (const char *)fb->buf, fb->len) != ESP_OK) {
            esp_camera_fb_return(fb); break;
        }
        esp_camera_fb_return(fb);
        vTaskDelay(pdMS_TO_TICKS(50));
    }
    return ESP_OK;
}

/* ---------------- Single-frame /frame.jpg ---------------- */
static esp_err_t frame_handler(httpd_req_t *req) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) { httpd_resp_send_500(req); return ESP_FAIL; }
    httpd_resp_set_type(req, "image/jpeg");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    esp_err_t res = httpd_resp_send(req, (const char *)fb->buf, fb->len);
    esp_camera_fb_return(fb);
    return res;
}

/* ---------------- /sos endpoint (multi-event) ---------------- */
static esp_err_t sos_handler(httpd_req_t *req) {
    char resp[160];
    btn_event_t ev;
    int64_t t;

    portENTER_CRITICAL(&s_event_mux);
    ev = s_pending_event;
    t  = s_pending_time_ms;
    s_pending_event   = EV_NONE;
    s_pending_time_ms = 0;
    portEXIT_CRITICAL(&s_event_mux);

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

    const char *type_str = "idle";
    switch (ev) {
        case EV_SOS:   type_str = "sos";   break;
        case EV_CALL1: type_str = "call1"; break;
        case EV_CALL2: type_str = "call2"; break;
        case EV_ACK:   type_str = "ack";   break;
        default: break;
    }

    int len;
    if (ev == EV_NONE) {
        len = snprintf(resp, sizeof(resp), "{\"type\":\"idle\"}");
    } else {
        len = snprintf(resp, sizeof(resp),
            "{\"type\":\"%s\",\"source\":\"button\",\"time\":%lld}",
            type_str, (long long)t);
    }
    return httpd_resp_send(req, resp, len);
}

/* ---------------- /sensors endpoint ---------------- */
static esp_err_t sensors_handler(httpd_req_t *req) {
    char snapshot[SENSOR_LINE_MAX];
    int64_t age_ms = 0;
    bool have_data;

    portENTER_CRITICAL(&s_sensors_mux);
    have_data = (g_sensors_json[0] != '\0');
    if (have_data) {
        strncpy(snapshot, g_sensors_json, sizeof(snapshot));
        snapshot[sizeof(snapshot) - 1] = '\0';
        age_ms = (esp_timer_get_time() / 1000LL) - g_sensors_ts_ms;
    }
    portEXIT_CRITICAL(&s_sensors_mux);

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    if (!have_data) {
        const char *msg = "{\"status\":\"idle\"}";
        return httpd_resp_send(req, msg, strlen(msg));
    }
    char wrapped[SENSOR_LINE_MAX + 64];
    int len = snprintf(wrapped, sizeof(wrapped),
        "{\"data\":%s,\"age_ms\":%lld}", snapshot, (long long)age_ms);
    return httpd_resp_send(req, wrapped, len);
}

/* ---------------- /vibrate endpoint (POST) ---------------- */
//
// Accepts ?on=1 / ?on=0 in the query string. We could also accept a JSON
// body but query-string keeps the phone code trivial.
static esp_err_t vibrate_handler(httpd_req_t *req) {
    char query[32];
    char val[8] = {0};
    bool on = false;

    if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK) {
        if (httpd_query_key_value(query, "on", val, sizeof(val)) == ESP_OK) {
            on = (val[0] == '1' || val[0] == 't' || val[0] == 'T');
        }
    }

    char cmd = on ? 'V' : 'S';
    uart_write_bytes(NANO_UART_NUM, &cmd, 1);
    // newline so the Nano's loop sees it promptly even if it ever buffered
    uart_write_bytes(NANO_UART_NUM, "\n", 1);

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    char resp[48];
    int len = snprintf(resp, sizeof(resp), "{\"vibrate\":%s}", on ? "true" : "false");
    return httpd_resp_send(req, resp, len);
}

// CORS preflight for /vibrate (browsers will send OPTIONS first for POST
// from a different origin). Any URI matches; we only register OPTIONS.
static esp_err_t options_handler(httpd_req_t *req) {
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "Content-Type");
    httpd_resp_set_status(req, "204 No Content");
    return httpd_resp_send(req, NULL, 0);
}

/* ---------------- HTTP server(s) ---------------- */
//
// We run TWO independent httpd instances, on TWO different TCP ports, each
// with its OWN socket pool. This is the canonical fix for "MJPEG dies after
// a few seconds + httpd_sock_err: error in send/recv : 104" on ESP32-CAM.
//
// Why two servers:
//   The MJPEG stream (`GET /`) is a single, never-ending response — that
//   socket is held open for as long as the phone is watching the feed.
//   Meanwhile the phone polls /sos, /sensors, and POSTs /vibrate every
//   couple hundred ms. With ONE server they share ONE socket pool. Even
//   with lru_purge_enable=true and max_open_sockets bumped to 13, Chromium
//   on Android (Capacitor WebView) racks up half-closed sockets fast — and
//   when the pool fills, the LRU policy kills the oldest socket, which IS
//   the MJPEG stream. The server then logs:
//       W httpd_txrx: httpd_sock_err: error in send : 104   (ECONNRESET)
//       W httpd_txrx: httpd_sock_err: error in recv : 104
//   the JS <img> goes into onerror, the user sees the disconnect screen,
//   AND /sos polling fails too — so the SOS button "does nothing" even
//   though the firmware detected the press correctly.
//
// Splitting into two servers gives the stream its OWN dedicated pool that
// short-lived control polls cannot evict. This is the same pattern used by
// the official esp32-camera CameraWebServer example (port 80 = control,
// port 81 = stream).
//
//   Port 80  -> control  : /frame.jpg, /sos, /sensors, /vibrate
//   Port 81  -> streaming: /              (MJPEG)
//
// Phone client should fetch the stream from `http://192.168.4.1:81/`.

static httpd_handle_t s_ctrl_server   = NULL;
static httpd_handle_t s_stream_server = NULL;

static httpd_handle_t start_control_server(void) {
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port      = 80;
    config.ctrl_port        = 32768;        // must differ from stream server
    config.stack_size       = 8192;
    config.max_uri_handlers = 12;
    // Control endpoints are short-lived. Aggressively purge dead sockets
    // so a flaky Capacitor WebView can't squat on slots for a minute.
    config.lru_purge_enable  = true;
    config.max_open_sockets  = 7;
    config.recv_wait_timeout = 5;
    config.send_wait_timeout = 5;
    config.keep_alive_enable = false;

    httpd_handle_t server = NULL;
    if (httpd_start(&server, &config) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start control httpd");
        return NULL;
    }

    httpd_uri_t frame_uri    = { .uri="/frame.jpg", .method=HTTP_GET,    .handler=frame_handler };
    httpd_uri_t sos_uri      = { .uri="/sos",       .method=HTTP_GET,    .handler=sos_handler };
    httpd_uri_t sensors_uri  = { .uri="/sensors",   .method=HTTP_GET,    .handler=sensors_handler };
    httpd_uri_t vibrate_uri  = { .uri="/vibrate",   .method=HTTP_POST,   .handler=vibrate_handler };
    httpd_uri_t vibrate_opts = { .uri="/vibrate",   .method=HTTP_OPTIONS,.handler=options_handler };
    httpd_register_uri_handler(server, &frame_uri);
    httpd_register_uri_handler(server, &sos_uri);
    httpd_register_uri_handler(server, &sensors_uri);
    httpd_register_uri_handler(server, &vibrate_uri);
    httpd_register_uri_handler(server, &vibrate_opts);
    ESP_LOGI(TAG, "Control HTTP server up on :80");
    return server;
}

static httpd_handle_t start_stream_server(void) {
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port      = 81;
    config.ctrl_port        = 32769;        // must differ from control server
    config.stack_size       = 8192;
    config.max_uri_handlers = 2;
    // Stream pool only ever needs one or two sockets — but give it room
    // so a tab refresh doesn't immediately strangle the new connection.
    config.lru_purge_enable  = true;
    config.max_open_sockets  = 4;
    // Long timeouts: the stream send loop legitimately blocks for tens of
    // ms while the camera produces the next JPEG; we don't want LWIP
    // declaring it dead.
    config.recv_wait_timeout = 10;
    config.send_wait_timeout = 10;
    config.keep_alive_enable = false;

    httpd_handle_t server = NULL;
    if (httpd_start(&server, &config) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start stream httpd");
        return NULL;
    }
    httpd_uri_t stream_uri = { .uri="/", .method=HTTP_GET, .handler=stream_handler };
    httpd_register_uri_handler(server, &stream_uri);
    ESP_LOGI(TAG, "Stream HTTP server up on :81");
    return server;
}

// Compatibility wrapper — keeps app_main's original call site working.
static httpd_handle_t start_webserver(void) {
    s_ctrl_server   = start_control_server();
    s_stream_server = start_stream_server();
    return (s_ctrl_server && s_stream_server) ? s_ctrl_server : NULL;
}

/* ---------------- SOS button: hold + multi-click detector ---------------- */
//
// State machine, polled at 50 ms:
//   - On falling edge: remember press start.
//   - While held past 2 s: emit EV_SOS once and lock until release.
//   - On rising edge: if press was short (< CLICK_MAX_PRESS_MS) increment a
//     click counter, store the time of the release.
//   - When CLICK_GROUP_GAP_MS elapses with no new press, emit:
//        1 click   -> EV_ACK
//        2 clicks  -> EV_CALL1
//        3+ clicks -> EV_CALL2
//
// Note: a long-hold (already emitted as SOS) does NOT count as a click on
// release — we set a flag to suppress that.
static void sos_button_init(void) {
    gpio_config_t io_conf = {
        .pin_bit_mask = (1ULL << SOS_BUTTON_GPIO),
        .mode         = GPIO_MODE_INPUT,
        .pull_up_en   = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    gpio_config(&io_conf);
}

static void push_event(btn_event_t ev) {
    int64_t now_ms = esp_timer_get_time() / 1000LL;
    portENTER_CRITICAL(&s_event_mux);
    s_pending_event   = ev;
    s_pending_time_ms = now_ms;
    portEXIT_CRITICAL(&s_event_mux);
}

static void sos_button_task(void *arg) {
    bool was_high = true;
    int64_t pressed_at_ms = 0;
    int64_t last_release_ms = 0;
    bool sos_fired_for_this_press = false;
    int  click_count = 0;

    for (;;) {
        int level = gpio_get_level(SOS_BUTTON_GPIO);
        int64_t now_ms = esp_timer_get_time() / 1000LL;

        if (level == 0 && was_high) {
            // Just went down.
            pressed_at_ms = now_ms;
            sos_fired_for_this_press = false;
            was_high = false;
        } else if (level == 0 && !was_high) {
            // Still being held — check long-hold panic.
            if (!sos_fired_for_this_press &&
                (now_ms - pressed_at_ms) >= SOS_HOLD_REQUIRED_MS) {
                ESP_LOGW(TAG, "SOS HOLD confirmed (%lld ms)",
                         (long long)(now_ms - pressed_at_ms));
                push_event(EV_SOS);
                sos_fired_for_this_press = true;
                click_count = 0;  // cancel any in-flight click sequence
            }
        } else if (level == 1 && !was_high) {
            // Released.
            int64_t held = now_ms - pressed_at_ms;
            was_high = true;

            if (!sos_fired_for_this_press && held < CLICK_MAX_PRESS_MS) {
                click_count++;
                last_release_ms = now_ms;
            }
            // long-hold release is consumed by the SOS event already
        }

        // Click-grouping timeout: if we have pending clicks and the gap has
        // passed without a new press, dispatch.
        if (click_count > 0 && was_high &&
            (now_ms - last_release_ms) >= CLICK_GROUP_GAP_MS) {
            if (click_count == 1) {
                ESP_LOGI(TAG, "single click -> ACK");
                push_event(EV_ACK);
            } else if (click_count == 2) {
                ESP_LOGI(TAG, "double click -> CALL1");
                push_event(EV_CALL1);
            } else {
                ESP_LOGI(TAG, "triple+ click -> CALL2");
                push_event(EV_CALL2);
            }
            click_count = 0;
        }

        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

/* ---------------- Nano UART listener (and writer) ---------------- */
static void nano_uart_init(void) {
    uart_config_t uart_config = {
        .baud_rate = NANO_UART_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity    = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
    };
    uart_param_config(NANO_UART_NUM, &uart_config);
    uart_set_pin(NANO_UART_NUM, NANO_UART_TX, NANO_UART_RX,
                 UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    uart_driver_install(NANO_UART_NUM, NANO_UART_BUF * 2, NANO_UART_BUF, 0, NULL, 0);
}

static void nano_uart_task(void *arg) {
    uint8_t buf[128];
    char line[SENSOR_LINE_MAX];
    int  line_len = 0;

    for (;;) {
        int n = uart_read_bytes(NANO_UART_NUM, buf, sizeof(buf), pdMS_TO_TICKS(100));
        if (n <= 0) continue;

        for (int i = 0; i < n; i++) {
            char c = (char)buf[i];
            if (c == '\n' || c == '\r') {
                if (line_len > 0) {
                    line[line_len] = '\0';
                    if (line[0] == '{') {
                        portENTER_CRITICAL(&s_sensors_mux);
                        strncpy(g_sensors_json, line, sizeof(g_sensors_json));
                        g_sensors_json[sizeof(g_sensors_json) - 1] = '\0';
                        g_sensors_ts_ms = esp_timer_get_time() / 1000LL;
                        portEXIT_CRITICAL(&s_sensors_mux);
                    }
                    line_len = 0;
                }
            } else if (line_len < (int)sizeof(line) - 1) {
                line[line_len++] = c;
            } else {
                line_len = 0;
            }
        }
    }
}

/* ---------------- app_main ---------------- */
void app_main(void) {
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_flash_init();
    }

    i2c_init();

    if (camera_init_board() != ESP_OK) {
        ESP_LOGE(TAG, "Camera init failed — continuing without camera");
    }

    wifi_init_ap();

    if (!start_webserver()) {
        ESP_LOGE(TAG, "Web server failed to start");
        return;
    }

    sos_button_init();
    xTaskCreate(sos_button_task, "sos_task", 4096, NULL, 10, NULL);

    nano_uart_init();
    xTaskCreate(nano_uart_task, "nano_uart", 4096, NULL, 9, NULL);

    ESP_LOGI(TAG,
        "IntelliCane ready.\n"
        "  Stream:   http://192.168.4.1:81/\n"
        "  Snapshot: http://192.168.4.1/frame.jpg\n"
        "  Sensors:  http://192.168.4.1/sensors\n"
        "  SOS poll: http://192.168.4.1/sos\n"
        "  Vibrate:  POST http://192.168.4.1/vibrate?on=1");
}

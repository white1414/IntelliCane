// main.c — IntelliCane ESP32-CAM (ESP-IDF)
//
// Adds three things on top of your existing firmware:
//   1. UART2 reader on GPIO 14 — receives the JSON sensor lines streamed
//      by the Arduino Nano. Latest line is cached and exposed at /sensors.
//   2. /sensors HTTP endpoint — returns the most recent Nano JSON line, or
//      `{"status":"idle"}` if nothing has arrived yet.
//   3. SOS button now requires a 2-SECOND HOLD before it fires. A quick tap
//      is ignored. The phone polls /sos every second; first poll after a
//      hold returns the press, then it auto-clears.
//
// Pin map summary (AI-Thinker ESP32-CAM):
//   GPIO 14  — UART2 RX  (wire to Nano TX through a 1k/2k divider 5V→3.3V)
//   GPIO 15  — SOS push button to GND (active low, internal pull-up enabled)
//   GPIO 1   — UART0 TX  (still used for ESP-IDF log output / programming)
//   GPIO 3   — UART0 RX  (used for programming; you can leave it floating)
//
// All other endpoints kept as-is:
//   GET /            — MJPEG stream (multipart/x-mixed-replace)
//   GET /frame.jpg   — single JPEG snapshot
//   GET /sos         — JSON, returns SOS event if pending then clears
//   GET /sensors     — JSON, latest Nano sensor reading

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

/* ---------------- I2C config (kept) ---------------- */
#define I2C_MASTER_NUM            I2C_NUM_0
#define I2C_MASTER_SDA_IO         SIOD_GPIO_NUM
#define I2C_MASTER_SCL_IO         SIOC_GPIO_NUM
#define I2C_MASTER_FREQ_HZ        100000

/* ---------------- WiFi AP credentials ---------------- */
#define AP_SSID "IntelliCane"
#define AP_PASS "sotgofa1"

/* ---------------- SOS button ---------------- */
#define SOS_BUTTON_GPIO        15
#define SOS_HOLD_REQUIRED_MS   2000   // must be held this long to fire

/* ---------------- Nano UART link ---------------- */
#define NANO_UART_NUM   UART_NUM_2
#define NANO_UART_RX    14
#define NANO_UART_TX    UART_PIN_NO_CHANGE   // we never talk back to the Nano
#define NANO_UART_BAUD  9600
#define NANO_UART_BUF   1024

/* ---------------- MJPEG / camera ---------------- */
#define MJPEG_BOUNDARY      "frame"
#define CAMERA_FRAME_SIZE   FRAMESIZE_VGA
#define CAMERA_JPEG_QUALITY 10
#define CAMERA_FB_COUNT     2

/* ---------------- Globals ---------------- */
static volatile int64_t last_sos_time_ms = 0;
static portMUX_TYPE     s_sos_mux        = portMUX_INITIALIZER_UNLOCKED;

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
static httpd_handle_t start_webserver(void);
static void           sos_button_init(void);
static void           sos_button_task(void *arg);
static void           nano_uart_init(void);
static void           nano_uart_task(void *arg);

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

/* ---------------- /sos endpoint ---------------- */
static esp_err_t sos_handler(httpd_req_t *req) {
    char resp[128];
    int64_t t = 0;
    portENTER_CRITICAL(&s_sos_mux);
    t = last_sos_time_ms;
    last_sos_time_ms = 0;
    portEXIT_CRITICAL(&s_sos_mux);

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    int len;
    if (t != 0) {
        len = snprintf(resp, sizeof(resp),
            "{\"type\":\"sos\",\"source\":\"button\",\"time\":%lld}", (long long)t);
    } else {
        len = snprintf(resp, sizeof(resp), "{\"type\":\"sos\",\"status\":\"idle\"}");
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
    // Append our own age_ms field so the phone can tell if data is stale.
    char wrapped[SENSOR_LINE_MAX + 64];
    int len = snprintf(wrapped, sizeof(wrapped),
        "{\"data\":%s,\"age_ms\":%lld}", snapshot, (long long)age_ms);
    return httpd_resp_send(req, wrapped, len);
}

/* ---------------- HTTP server ---------------- */
static httpd_handle_t start_webserver(void) {
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.stack_size  = 8192;
    config.max_uri_handlers = 8;
    httpd_handle_t server = NULL;
    if (httpd_start(&server, &config) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start httpd");
        return NULL;
    }

    httpd_uri_t stream_uri  = { .uri="/",          .method=HTTP_GET, .handler=stream_handler };
    httpd_uri_t frame_uri   = { .uri="/frame.jpg", .method=HTTP_GET, .handler=frame_handler };
    httpd_uri_t sos_uri     = { .uri="/sos",       .method=HTTP_GET, .handler=sos_handler };
    httpd_uri_t sensors_uri = { .uri="/sensors",   .method=HTTP_GET, .handler=sensors_handler };
    httpd_register_uri_handler(server, &stream_uri);
    httpd_register_uri_handler(server, &frame_uri);
    httpd_register_uri_handler(server, &sos_uri);
    httpd_register_uri_handler(server, &sensors_uri);
    ESP_LOGI(TAG, "HTTP server up");
    return server;
}

/* ---------------- SOS button (2-second hold detector) ---------------- */
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

static void sos_button_task(void *arg) {
    bool was_high = true;
    int64_t pressed_at_ms = 0;
    bool reported_for_this_press = false;

    for (;;) {
        int level = gpio_get_level(SOS_BUTTON_GPIO);
        int64_t now_ms = esp_timer_get_time() / 1000LL;

        if (level == 0 && was_high) {
            // Just went down — start the hold timer.
            pressed_at_ms = now_ms;
            reported_for_this_press = false;
            was_high = false;
        } else if (level == 0 && !was_high) {
            // Still being held.
            if (!reported_for_this_press &&
                (now_ms - pressed_at_ms) >= SOS_HOLD_REQUIRED_MS) {
                ESP_LOGW(TAG, "SOS HOLD confirmed (%lld ms)",
                         (long long)(now_ms - pressed_at_ms));
                portENTER_CRITICAL(&s_sos_mux);
                last_sos_time_ms = now_ms;
                portEXIT_CRITICAL(&s_sos_mux);
                reported_for_this_press = true;
            }
        } else if (level == 1 && !was_high) {
            // Released. Reset.
            was_high = true;
        }

        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

/* ---------------- Nano UART listener ---------------- */
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
    uart_driver_install(NANO_UART_NUM, NANO_UART_BUF * 2, 0, 0, NULL, 0);
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
                // line too long — discard
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
        "  Stream:   http://192.168.4.1/\n"
        "  Snapshot: http://192.168.4.1/frame.jpg\n"
        "  Sensors:  http://192.168.4.1/sensors\n"
        "  SOS poll: http://192.168.4.1/sos");
}

#ifndef CONFIG_H
#define CONFIG_H

#include "BoardConfig.h"
#include <ArduinoJson.h>
#include <driver/i2s.h>
#include <Preferences.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <WebSocketsClient.h>

// ---------- CHOOSE YOUR MODE ----------
// Pick one of the following (DEV_MODE, PROD_MODE, ELATO_MODE) , comment the rest
// For ELATO_MODE, you will need to register your DIY Hardware on the Elato website

// #define DEV_MODE
#define PROD_MODE
// #define ELATO_MODE

// ---------- CHOOSE YOUR VOICE SERVER ----------
// Keep this separate from DEV/PROD/ELATO so the deployment mode and the voice backend stay independent.
// Pick one backend for websocket voice traffic.
// Note: ELATO_MODE always uses Elato's hosted server, so this selector only
// applies to DEV_MODE and PROD_MODE.

// #define VOICE_SERVER_DENO
// #define VOICE_SERVER_CLOUDFLARE
#define VOICE_SERVER_FASTAPI


// ---------- CHOOSE YOUR INPUT MODE ----------
// If you want to use the touch sensor to wake up the device, uncomment the following line
// If you want to use the button to wake up the device, comment the following line
// This kit's touch pad is a TTP223 module on GPIO47, not an ESP32 native touch
// channel, so native touchRead() cannot see it. Use button mode on GPIO0.
// #define TOUCH_MODE

// Bump when a change makes a previously stored auth token invalid. Boards that
// booted under an older scheme wipe their token once on the next boot; without
// that, isDeviceRegistered() short-circuits on the stale token and the device
// never re-registers against its real account.
#define PROVISION_VERSION 3

extern Preferences preferences;
extern bool factory_reset_status;

enum OtaStatus {
    OTA_IDLE,
    OTA_IN_PROGRESS,
    OTA_COMPLETE
};

extern OtaStatus otaState;

enum DeviceState
{
    SETUP,
    SOFT_AP,
    IDLE,
    LISTENING,
    SPEAKING,
    PROCESSING,
    WAITING,
    OTA,
    FACTORY_RESET,
    SLEEP
};

extern volatile DeviceState deviceState;

// WiFi credentials
extern const char *EAP_IDENTITY;
extern const char *EAP_USERNAME;
extern const char *EAP_PASSWORD;
extern const char *ssid;

extern const char *ssid_peronal;
extern const char *password_personal;

extern String authTokenGlobal;

// WebSocket server details
extern const char *ws_server;
extern const uint16_t ws_port;
extern const char *ws_path;

// Backend server details
extern const char *backend_server;
extern const uint16_t backend_port;

// I2S and Audio parameters
extern const uint32_t SAMPLE_RATE;
extern const uint32_t MIC_SAMPLE_RATE;

extern const int BLUE_LED_PIN;
extern const int RED_LED_PIN;
extern const int GREEN_LED_PIN;

extern const gpio_num_t BUTTON_PIN;
extern const gpio_num_t VOLUME_UP_PIN;
extern const gpio_num_t VOLUME_DOWN_PIN;
extern const gpio_num_t TOUCH_PAD_PIN;

// I2C for the status display. Free on this kit and the pair the xiaozhi
// bread-compact-wifi design uses for its OLED.
extern const int I2C_SDA_PIN;
extern const int I2C_SCL_PIN;

// I2S Microphone pins
extern const int I2S_SD;
extern const int I2S_WS;
extern const int I2S_SCK;
extern const i2s_port_t I2S_PORT_IN;

// Master clock. Codecs derive their internal clocks from it and will not
// produce a sample without one; -1 on boards whose mic and amplifier need no
// MCLK at all.
extern const int I2S_MCLK_OUT;

// WS2812 ring data pin, or -1 where the status LED is a discrete RGB part
// driven through RED/GREEN/BLUE_LED_PIN.
extern const int LED_RING_PIN;

// Battery sense ADC input and the charger's charging output, or -1 where the
// board has neither (BOARD_HAS_BATTERY is 0).
extern const int BATTERY_ADC_PIN;
extern const int CHARGE_DETECT_PIN;

// I2S Speaker pins
extern const int I2S_WS_OUT;
extern const int I2S_BCK_OUT;
extern const int I2S_DATA_OUT;
extern const i2s_port_t I2S_PORT_OUT;
extern const int I2S_SD_OUT;

extern volatile bool sleepRequested;

// SSL certificate
extern const char *CA_cert;
extern const char *Vercel_CA_cert;
void factoryResetDevice();
void resetAuth();
void processSleepRequest();

#endif

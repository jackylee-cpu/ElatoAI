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
// PROD_MODE talks to the deployed servers (Config.cpp); DEV_MODE to a machine
// on the LAN. The voice server is always the FastAPI one in server/fastapi.

// #define DEV_MODE
#define PROD_MODE


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
// 4: tokens are no longer stored at all (they last 24 hours and live in RAM);
// this wipes the parent JWT that versions before it kept in NVS for good.
#define PROVISION_VERSION 4

extern Preferences preferences;
extern bool factory_reset_status;

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

// The device token the voice websocket opens with: 24 hours, bought from
// /api/generate_auth_token with this board's device secret (NVS namespace
// "device"). Held in RAM only and renewed between sessions; see
// startSessionIfReady() in WifiManager.cpp.
extern String authTokenGlobal;
extern uint32_t authTokenExpiresAtMs;  // millis() at which the token runs out
extern volatile bool authTokenRejected; // the voice server closed us before "auth"
// The backend answered 202: no account owns this board, so it waits to be
// claimed with the websocket paused (R-36). Shown on the LED while idle.
extern volatile bool deviceUnclaimed;

// WebSocket server details
extern const char *ws_server;
extern const uint16_t ws_port;
extern const char *ws_path;

// Backend server details
extern const char *backend_server;
extern const uint16_t backend_port;

// Start a request to the web app at `path`. The one place that decides http
// (DEV_MODE, or a LAN backend via LOCAL_BACKEND_HOST) or https; `client` must
// outlive the request.
void beginBackendRequest(HTTPClient &http, WiFiClientSecure &client, const String &path);

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

// For boards with no battery sense (BOARD_LOW_BATTERY_VIA_VDD): an undriven
// ADC pin that SupplyMonitor biases to a fraction of the chip's own supply,
// and an unused screen's chip select to hold high meanwhile. -1 elsewhere.
extern const int SUPPLY_SENSE_PIN;
extern const int LCD_CS_PIN;

// I2S Speaker pins
extern const int I2S_WS_OUT;
extern const int I2S_BCK_OUT;
extern const int I2S_DATA_OUT;
extern const i2s_port_t I2S_PORT_OUT;
extern const int I2S_SD_OUT;

extern volatile bool sleepRequested;
// Why, for the "bye" the board sends before it sleeps (sayBye() in Audio.cpp):
// "sleep_idle", "sleep_button" or "sleep_session_end". Set it with the flag.
extern const char *volatile sleepReason;

// SSL certificate
extern const char *CA_cert;
extern const char *Vercel_CA_cert;
void factoryResetDevice();
void resetAuth();
void processSleepRequest();

#endif

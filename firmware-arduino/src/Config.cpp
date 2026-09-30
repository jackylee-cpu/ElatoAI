#include <nvs_flash.h>
#include "Config.h"

// ! define preferences
Preferences preferences;
OtaStatus otaState = OTA_IDLE;
bool factory_reset_status = false;
volatile bool sleepRequested = false;

/**
 * Configuration for Elato Firmware
 * 
 * DEVELOPMENT vs PRODUCTION vs ELATO SETUP:
 * --------------------------------
 * 1. Define `DEV_MODE` in your config.h file to use local development servers
 * 2. `DEV_MODE` requires updating the IP addresses to your local network IP
 * 3. Without `DEV_MODE` defined, the firmware will use your production servers
 *
 * VOICE BACKEND SELECTION:
 * --------------------------------
 * Keep the deployment mode (DEV/PROD/ELATO) separate from the voice backend
 * (`VOICE_SERVER_DENO` vs `VOICE_SERVER_CLOUDFLARE`).
 * This avoids an extra device-side config lookup while still letting us switch
 * websocket backends at build time.
 *
 * The selector only applies to DEV_MODE and PROD_MODE: ELATO_MODE always talks
 * to Elato's hosted server (the FastAPI server in `server/fastapi`, on Railway).
 *
 * DEV SETUP (find your local IP address using ifconfig):
 *   - WebSocket: Your local IP (e.g., 192.168.1.100:8000)
 *   - Backend: Your local IP (e.g., 192.168.1.100:3000)
 *   - No SSL certificates required
 *
 * PROD SETUP:
 *   - WebSocket: <your-websocket-server>.deno.dev (port 443)
 *   - Backend: <your-vercel-backend-server> (port 3000)
 *   - Use your own SSL certificates (set in Config.cpp)
 *
 * ELATO SETUP:
 *   - WebSocket: elato-pyserver-production.up.railway.app (port 443, path /ws/esp32)
 *   - Backend: https://www.elatoai.com (port 3000)
 *   - Uses pre-configured SSL certificates (set in Config.cpp)
 */

#ifdef DEV_MODE
const char *ws_server = "10.6.1.26";

#if defined(VOICE_SERVER_DENO)
const uint16_t ws_port = 8000;
const char *ws_path = "/";
#elif defined(VOICE_SERVER_CLOUDFLARE)
const uint16_t ws_port = 8787;
const char *ws_path = "/";
#elif defined(VOICE_SERVER_FASTAPI)
const uint16_t ws_port = 7860;
const char *ws_path = "/ws/esp32";
#else
#error "DEV_MODE requires one of VOICE_SERVER_DENO / _CLOUDFLARE / _FASTAPI in Config.h"
#endif

// Backend server details
const char *backend_server = "10.6.1.26";
const uint16_t backend_port = 3000;

#elif defined(PROD_MODE)
// PROD - self-hosted. Pick VOICE_SERVER_DENO or VOICE_SERVER_CLOUDFLARE above.
#if defined(VOICE_SERVER_DENO)
const char *ws_server = "<your-edge-server>.deno.dev";
const uint16_t ws_port = 443;
const char *ws_path = "/";
#elif defined(VOICE_SERVER_CLOUDFLARE)
const char *ws_server = "<your-cloudflare-server>.workers.dev";
const uint16_t ws_port = 443;
const char *ws_path = "/ws/esp32";
#elif defined(VOICE_SERVER_FASTAPI)
// FastAPI sits behind Cloudflare on the same host as the frontend, mounted
// under a /fastapi path prefix, so the esp32 route is /fastapi/ws/esp32.
const char *ws_server = "elatoai.hkqft.com";
const uint16_t ws_port = 443;
const char *ws_path = "/fastapi/ws/esp32";
#else
#error "PROD_MODE requires VOICE_SERVER_DENO, _CLOUDFLARE or _FASTAPI in Config.h"
#endif
// Backend server details. Same host as the voice server; PROD talks https on
// 443, so backend_port only matters to the DEV_MODE http path.
const char *backend_server = "elatoai.hkqft.com";
const uint16_t backend_port = 3000;

#elif defined(ELATO_MODE)
// ELATO
// Elato's hosted voice server is the FastAPI server (`server/fastapi`) on Railway.
// This is fixed regardless of the VOICE_SERVER_* selector.
const char *ws_server = "elato-pyserver-production.up.railway.app";
const uint16_t ws_port = 443;
const char *ws_path = "/ws/esp32";
// Backend server details
const char *backend_server = "www.elatoai.com"; // like www.facebook.com or facebook.vercel.app
const uint16_t backend_port = 3000;
#endif

String authTokenGlobal;
volatile DeviceState deviceState = IDLE;

// I2S and Audio parameters
#if defined(BOARD_XMINI_C3)

// One ES8311 on one full-duplex bus, so the Waveshare argument applies: one
// LRCK, one rate. Unlike the Waveshare board there is no ES7210 to hold it to
// 16kHz, so it runs at 24kHz, as xiaozhi runs it: the server's stream then
// plays at the rate it was synthesised at, rather than losing everything above
// 8kHz. Picked by ear against 16kHz on the same clip (2026-09-30).
//
// It costs no CPU. With the server's 40kbps CELT stream, decoding to 24kHz
// measured 8284us per 40ms packet on this core against 8256us to 16kHz --
// 20.7% either way. The microphone has to capture at 24kHz too, and
// Downsample.h brings it to the 16kHz the server expects
// (BOARD_MIC_DOWNSAMPLE_3_2), so the server needs no change.
const uint32_t SAMPLE_RATE = 24000;
const uint32_t MIC_SAMPLE_RATE = 24000;

// ----------------- Pin Definitions -----------------
// The C3 has one I2S peripheral.
const i2s_port_t I2S_PORT_IN = I2S_NUM_0;
const i2s_port_t I2S_PORT_OUT = I2S_NUM_0;

// No status LED on this board (BOARD_HAS_STATUS_LED is 0, so LEDHandler
// drives nothing). Kept out of the GPIO range like the Waveshare selectors so
// a stray digitalWrite() cannot land on a real pin -- in particular not on
// GPIO2, which the open-source xiaozhi config calls the LED but which is the
// battery divider here.
const int BLUE_LED_PIN = 202;
const int RED_LED_PIN = 200;
const int GREEN_LED_PIN = 201;
const int LED_RING_PIN = -1;

// Battery sense divider on ADC1 channel 2, and the charger's status output,
// high while charging. Both read out of the vendor firmware; see Battery.cpp.
const int BATTERY_ADC_PIN = 2;
const int CHARGE_DETECT_PIN = 12;

const int I2S_MCLK_OUT = 10;

const int I2S_SD = 7;    // ES8311 ADC out -> ESP32
const int I2S_WS = 6;    // shared LRCK
const int I2S_SCK = 8;   // shared BCLK

const int I2S_WS_OUT = 6;
const int I2S_BCK_OUT = 8;
const int I2S_DATA_OUT = 5;  // ESP32 -> ES8311 SDIN

// Speaker amplifier enable, active high, on a real GPIO this time. GPIO11 is
// the C3's VDD_SPI pad and only works as a GPIO once the VDD_SPI_AS_GPIO efuse
// is burnt; the xiaozhi firmware this board shipped with burns it on its first
// boot, so it is already set. boardSetSpeakerAmp() drives it.
const int I2S_SD_OUT = 11;

// BOOT. Push-to-talk, and the light-sleep wake source (see BoardConfig.h).
const gpio_num_t BUTTON_PIN = GPIO_NUM_9;

const gpio_num_t VOLUME_UP_PIN = GPIO_NUM_NC;
const gpio_num_t VOLUME_DOWN_PIN = GPIO_NUM_NC;
const gpio_num_t TOUCH_PAD_PIN = GPIO_NUM_NC;

// ES8311 at 0x18 and the SSD1306 at 0x3C.
const int I2C_SDA_PIN = 3;
const int I2C_SCL_PIN = 4;

#elif defined(BOARD_WAVESHARE_S3_AUDIO)

// The ES7210 and the ES8311 hang off one I2S bus and share its BCLK and LRCK,
// so the microphone and the speaker cannot run at different rates the way they
// do on the breadboard kit -- there is one LRCK and it belongs to both.
//
// 16kHz is what that one rate has to be. Both codecs derive their clocks from
// MCLK, the I2S driver emits MCLK at 256 x the sample rate, and 16kHz is the
// only voice rate for which both coefficient tables have a 256 x fs entry:
// the ES7210 can only do 24kHz at 512 x fs. See Codec.cpp.
//
// Running the whole pipeline at 16kHz rather than 24kHz costs nothing anywhere
// else. Opus decodes to whatever rate it is asked for, so the 24kHz stream the
// server sends decodes straight to 16kHz inside libopus with no resampling of
// ours; the uplink is 16kHz either way, which is what ESP32_INPUT_SAMPLE_RATE
// already defaults to, so the server needs no change; and two thirds of the
// bytes move through the ring buffer and the I2S DMA. What it costs is
// playback bandwidth above 8kHz.
const uint32_t SAMPLE_RATE = 16000;
const uint32_t MIC_SAMPLE_RATE = 16000;

// ----------------- Pin Definitions -----------------
// One port, full duplex: RX from the ES7210, TX to the ES8311.
const i2s_port_t I2S_PORT_IN = I2S_NUM_0;
const i2s_port_t I2S_PORT_OUT = I2S_NUM_0;

// Not GPIOs. The status LED on this board is a seven-pixel WS2812 ring on a
// single data line, so these are channel selectors that LEDHandler's pin shim
// turns into ring colours. They are deliberately outside the GPIO range: a
// call that escaped the shim would fail visibly rather than quietly drive a
// real pin that belongs to the camera bus.
const int BLUE_LED_PIN = 202;
const int RED_LED_PIN = 200;
const int GREEN_LED_PIN = 201;
const int LED_RING_PIN = 38;

const int BATTERY_ADC_PIN = -1;
const int CHARGE_DETECT_PIN = -1;

// The shared I2S bus. BCLK and LRCK are common to both codecs; only the data
// lines are separate, and even those are one pin each rather than a pair.
const int I2S_MCLK_OUT = 12;

const int I2S_SD = 15;   // ES7210 SDOUT -> ESP32 (mics 1 and 2)
const int I2S_WS = 14;   // shared LRCK
const int I2S_SCK = 13;  // shared BCLK

const int I2S_WS_OUT = 14;   // same LRCK as above
const int I2S_BCK_OUT = 13;  // same BCLK as above
const int I2S_DATA_OUT = 16; // ESP32 -> ES8311 SDIN

// The NS4150B enable is not on a GPIO at all: it is P10 on the TCA9555
// expander. -1 keeps anything that still wants a pin from touching one, and
// boardSetSpeakerAmp() in IoExpander.cpp is what actually switches the
// amplifier.
const int I2S_SD_OUT = -1;

// Boot button. GPIO0 is RTC IO, which esp_sleep_enable_ext0_wakeup() requires,
// and it is the only key on this board that is: the other three are behind the
// expander and cannot wake the chip.
const gpio_num_t BUTTON_PIN = GPIO_NUM_0;

// Volume and the touch pad have no GPIO here. KEY1 and KEY2 on the expander
// stand in for the volume rocker and KEY3 for the touch pad; main.cpp polls
// them over I2C instead of attaching a Button to a pin.
const gpio_num_t VOLUME_UP_PIN = GPIO_NUM_NC;
const gpio_num_t VOLUME_DOWN_PIN = GPIO_NUM_NC;
const gpio_num_t TOUCH_PAD_PIN = GPIO_NUM_NC;

// One I2C bus for the whole board: ES8311 0x18, ES7210 0x40, TCA9555 0x20,
// PCF85063 0x51, and an SSD1306 at 0x3C if one is wired to the header. No
// address clashes, so the display shares the bus rather than needing its own.
const int I2C_SDA_PIN = 11;
const int I2C_SCL_PIN = 10;

#else  // BOARD_ELATO_BREADBOARD

// Output pipeline rate. Opus will decode to whatever rate we ask for, but the
// servers encode at 24kHz, so asking for 48kHz is pure upsampling: no fidelity
// to gain, and twice the bytes through the ring buffer and the I2S DMA. That
// is what starved both of them and made every frame underrun.
const uint32_t SAMPLE_RATE = 24000;
const uint32_t MIC_SAMPLE_RATE = 16000;

// ----------------- Pin Definitions -----------------
const i2s_port_t I2S_PORT_IN = I2S_NUM_1;
const i2s_port_t I2S_PORT_OUT = I2S_NUM_0;

const int BLUE_LED_PIN = 13;
const int RED_LED_PIN = 9;
const int GREEN_LED_PIN = 8;
const int LED_RING_PIN = -1;

const int BATTERY_ADC_PIN = -1;
const int CHARGE_DETECT_PIN = -1;

// Pins follow the xiaozhi `bread-compact-wifi` wiring, which is what this kit
// shipped with: a raw I2S mic and a MAX98357A on separate pin sets (simplex
// I2S), so the two I2S ports above stay independent and can run at different
// rates (mic 16kHz, speaker 48kHz).
//
// Neither part needs a master clock, so nothing drives one.
const int I2S_MCLK_OUT = -1;

const int I2S_SD = 6;   // mic DIN
const int I2S_WS = 4;   // mic WS
const int I2S_SCK = 5;  // mic SCK

const int I2S_WS_OUT = 16;   // amp LRCK
const int I2S_BCK_OUT = 15;  // amp BCLK
const int I2S_DATA_OUT = 7;  // amp DIN
// The kit does not break out the MAX98357A SD pin, so this drives a free GPIO
// and the amp is always enabled. Mic muting still gates the uplink.
const int I2S_SD_OUT = 21;

// Boot button. GPIO0 is RTC IO, which esp_sleep_enable_ext0_wakeup() requires.
const gpio_num_t BUTTON_PIN = GPIO_NUM_0;

// Volume rocker. Neither pin is RTC IO, so unlike BUTTON_PIN these cannot wake
// the device from deep sleep -- they only work while it is awake.
const gpio_num_t VOLUME_UP_PIN = GPIO_NUM_40;
const gpio_num_t VOLUME_DOWN_PIN = GPIO_NUM_39;

// TTP223 capacitive pad. It drives the line high on touch, so this one is
// active-high, unlike the buttons above. Not RTC IO either, so it can put the
// device to sleep but cannot wake it -- BUTTON_PIN does that.
const gpio_num_t TOUCH_PAD_PIN = GPIO_NUM_47;

// Status display. Nothing else on this board claims these two.
const int I2C_SDA_PIN = 41;
const int I2C_SCL_PIN = 42;

#endif


// ----------------- SSL Certificates -----------------


#ifdef PROD_MODE

// Both the backend and the voice websocket are the same Cloudflare-fronted
// host, so they share one bundle:
//   1. GTS WE1        - the current issuing intermediate (ECDSA P-256). Having
//                       it here lets mbedTLS stop after verifying just the leaf.
//   2. GTS Root R4    - covers a WE1 rotation.        expires Jun 22 2036
//   3. ISRG Root X1   - Cloudflare Universal SSL can switch issuer between
//                       Google Trust Services and Let's Encrypt, and a reflash
//                       is expensive, so trust both. expires Jun  4 2035
// Do NOT pin only the intermediate here the way ELATO_MODE does: Cloudflare
// rotates edge certificates on its own schedule.
static const char *CF_CA_bundle = R"EOF(
-----BEGIN CERTIFICATE-----
MIICnzCCAiWgAwIBAgIQf/MZd5csIkp2FV0TttaF4zAKBggqhkjOPQQDAzBHMQsw
CQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEU
MBIGA1UEAxMLR1RTIFJvb3QgUjQwHhcNMjMxMjEzMDkwMDAwWhcNMjkwMjIwMTQw
MDAwWjA7MQswCQYDVQQGEwJVUzEeMBwGA1UEChMVR29vZ2xlIFRydXN0IFNlcnZp
Y2VzMQwwCgYDVQQDEwNXRTEwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARvzTr+
Z1dHTCEDhUDCR127WEcPQMFcF4XGGTfn1XzthkubgdnXGhOlCgP4mMTG6J7/EFmP
LCaY9eYmJbsPAvpWo4H+MIH7MA4GA1UdDwEB/wQEAwIBhjAdBgNVHSUEFjAUBggr
BgEFBQcDAQYIKwYBBQUHAwIwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQU
kHeSNWfE/6jMqeZ72YB5e8yT+TgwHwYDVR0jBBgwFoAUgEzW63T/STaj1dj8tT7F
avCUHYwwNAYIKwYBBQUHAQEEKDAmMCQGCCsGAQUFBzAChhhodHRwOi8vaS5wa2ku
Z29vZy9yNC5jcnQwKwYDVR0fBCQwIjAgoB6gHIYaaHR0cDovL2MucGtpLmdvb2cv
ci9yNC5jcmwwEwYDVR0gBAwwCjAIBgZngQwBAgEwCgYIKoZIzj0EAwMDaAAwZQIx
AOcCq1HW90OVznX+0RGU1cxAQXomvtgM8zItPZCuFQ8jSBJSjz5keROv9aYsAm5V
sQIwJonMaAFi54mrfhfoFNZEfuNMSQ6/bIBiNLiyoX46FohQvKeIoJ99cx7sUkFN
7uJW
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIICCTCCAY6gAwIBAgINAgPlwGjvYxqccpBQUjAKBggqhkjOPQQDAzBHMQswCQYD
VQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIG
A1UEAxMLR1RTIFJvb3QgUjQwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAw
WjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2Vz
IExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjQwdjAQBgcqhkjOPQIBBgUrgQQAIgNi
AATzdHOnaItgrkO4NcWBMHtLSZ37wWHO5t5GvWvVYRg1rkDdc/eJkTBa6zzuhXyi
QHY7qca4R9gq55KRanPpsXI5nymfopjTX15YhmUPoYRlBtHci8nHc8iMai/lxKvR
HYqjQjBAMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQW
BBSATNbrdP9JNqPV2Py1PsVq8JQdjDAKBggqhkjOPQQDAwNpADBmAjEA6ED/g94D
9J+uHXqnLrmvT/aDHQ4thQEd0dlq7A/Cr8deVl5c1RxYIigL9zC2L7F8AjEA8GE8
p/SgguMh1YQdc4acLa/KNJvxn7kjNuK8YAOdgLOaVsjh4rsUecrNIdSUtUlD
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
)EOF";

const char *Vercel_CA_cert = CF_CA_bundle;
const char *CA_cert = CF_CA_bundle;


#elif defined(ELATO_MODE)

// CA cert for `www.elatoai.com` (Vercel). The leaf chains up to ISRG Root X1.
const char *Vercel_CA_cert = R"EOF(
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
)EOF";


// Voice websocket CA bundle for `elato-pyserver-production.up.railway.app`
// (the FastAPI server in `server/fastapi`, deployed on Railway).
// The wildcard leaf is issued by Let's Encrypt "YE1" (ECDSA P-384). The S3 has
// no ECC accelerator, so every P-384 signature verify costs ~1s of CPU; pinning
// the issuing intermediate lets mbedTLS stop after verifying just the leaf.
// The certs further up the chain stay in the bundle so the connection survives
// an LE intermediate rotation (it just verifies more of the chain again):
//   1. YE1 (Let's Encrypt intermediate)   - expires Sep  2 2028
//   2. Root YE (ISRG root)                - expires Sep  2 2032
//   3. ISRG Root X2 (ECDSA)               - expires Sep 17 2040
//   4. ISRG Root X1 (RSA)                 - expires Jun  4 2035
const char *CA_cert = R"EOF(
-----BEGIN CERTIFICATE-----
MIICizCCAhGgAwIBAgIQXd1w3TH4AchcGGp6BLgK/jAKBggqhkjOPQQDAzAuMQsw
CQYDVQQGEwJVUzENMAsGA1UEChMESVNSRzEQMA4GA1UEAxMHUm9vdCBZRTAeFw0y
NTA5MDMwMDAwMDBaFw0yODA5MDIyMzU5NTlaMDMxCzAJBgNVBAYTAlVTMRYwFAYD
VQQKEw1MZXQncyBFbmNyeXB0MQwwCgYDVQQDEwNZRTEwdjAQBgcqhkjOPQIBBgUr
gQQAIgNiAAQHZVB1/mimla2hfSurylScjPMZaOJXLz/NnAc2sylm8WDyhU9Ccp+z
ASQi5vSwGGJjSGklkD9fdPR8GpyDIOIjCEfrnbt/v+ZSEPLLEGbaM6EccDbN7p9x
teIm2Avf+ryjge4wgeswDgYDVR0PAQH/BAQDAgGGMBMGA1UdJQQMMAoGCCsGAQUF
BwMBMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0OBBYEFLsgykcL/tflnPmPCSqj
jDdFsbzYMB8GA1UdIwQYMBaAFKPIJlqOoUzQNWP8myPIOq5W809WMDIGCCsGAQUF
BwEBBCYwJDAiBggrBgEFBQcwAoYWaHR0cDovL3llLmkubGVuY3Iub3JnLzATBgNV
HSAEDDAKMAgGBmeBDAECATAnBgNVHR8EIDAeMBygGqAYhhZodHRwOi8veWUuYy5s
ZW5jci5vcmcvMAoGCCqGSM49BAMDA2gAMGUCMQDgjUEahFT/h3DRakqiPZpLvPgf
Zwkt6K2EOMmh1nvEzl83eMLYcod4GCl3b0J1Nn0CMBNYmEQJb4CEG5WoOe7aRn/L
VKu6saHmHEynI7ysIPd8zQsK1HdmhlHKlw9Z5GpGvA==
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIICpjCCAiugAwIBAgIRAIchZfw0tuX7qK3Vs3BftTowCgYIKoZIzj0EAwMwTzEL
MAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2VhcmNo
IEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDIwHhcNMjYwNTEzMDAwMDAwWhcN
MzIwOTAyMjM1OTU5WjAuMQswCQYDVQQGEwJVUzENMAsGA1UEChMESVNSRzEQMA4G
A1UEAxMHUm9vdCBZRTB2MBAGByqGSM49AgEGBSuBBAAiA2IABDwS/6vhrcVqcbBo
+wgdI3fwn9x7DNJJOY/lTOti0vkwuRN87RhEhTH17E7XyFjWsPYhIPt/wzOqxTd2
b+4ZJNy9ID04YywF9U5zasDVyGSNErVNtz8uSGh5izW87j77GaOB6zCB6DAOBgNV
HQ8BAf8EBAMCAQYwEwYDVR0lBAwwCgYIKwYBBQUHAwEwDwYDVR0TAQH/BAUwAwEB
/zAdBgNVHQ4EFgQUo8gmWo6hTNA1Y/ybI8g6rlbzT1YwHwYDVR0jBBgwFoAUfEKW
rt5LSDv6kviejM9ti6lyN5UwMgYIKwYBBQUHAQEEJjAkMCIGCCsGAQUFBzAChhZo
dHRwOi8veDIuaS5sZW5jci5vcmcvMBMGA1UdIAQMMAowCAYGZ4EMAQIBMCcGA1Ud
HwQgMB4wHKAaoBiGFmh0dHA6Ly94Mi5jLmxlbmNyLm9yZy8wCgYIKoZIzj0EAwMD
aQAwZgIxAMU19WCtmxVND8UHBZRoma49Z7jPs64Dma0eTu1OChVbB/2J7GV3nvYK
Ax54uk1G9QIxAO0miLVJu8PLNiXXXkiE/gsK3CTRTF/aeo4bMX42Zw40csRU6AC2
6hSW1/IWaas6dg==
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIICGzCCAaGgAwIBAgIQQdKd0XLq7qeAwSxs6S+HUjAKBggqhkjOPQQDAzBPMQsw
CQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJuZXQgU2VjdXJpdHkgUmVzZWFyY2gg
R3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBYMjAeFw0yMDA5MDQwMDAwMDBaFw00
MDA5MTcxNjAwMDBaME8xCzAJBgNVBAYTAlVTMSkwJwYDVQQKEyBJbnRlcm5ldCBT
ZWN1cml0eSBSZXNlYXJjaCBHcm91cDEVMBMGA1UEAxMMSVNSRyBSb290IFgyMHYw
EAYHKoZIzj0CAQYFK4EEACIDYgAEzZvVn4CDCuwJSvMWSj5cz3es3mcFDR0HttwW
+1qLFNvicWDEukWVEYmO6gbf9yoWHKS5xcUy4APgHoIYOIvXRdgKam7mAHf7AlF9
ItgKbppbd9/w+kHsOdx1ymgHDB/qo0IwQDAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0T
AQH/BAUwAwEB/zAdBgNVHQ4EFgQUfEKWrt5LSDv6kviejM9ti6lyN5UwCgYIKoZI
zj0EAwMDaAAwZQIwe3lORlCEwkSHRhtFcP9Ymd70/aTSVaYgLXTWNLxBo1BfASdW
tL4ndQavEi51mI38AjEAi/V3bNTIZargCyzuFJ0nN6T5U6VR5CmD1/iQMVtCnwr1
/q4AaOeMSQ+2b1tbFfLn
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
)EOF";

#endif

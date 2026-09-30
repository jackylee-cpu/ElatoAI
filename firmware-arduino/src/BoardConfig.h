#ifndef BOARDCONFIG_H
#define BOARDCONFIG_H

#include <sdkconfig.h>

// Which board this firmware is built for. Exactly one BOARD_* is defined, and
// the flag comes from platformio.ini. The two S3 boards share a chip, 16MB of
// flash and 8MB of octal PSRAM, so their partition table, memory_type and USB
// settings are shared in platformio.ini. The xmini-c3 is a different chip with
// no PSRAM and its own environment there.
//
// BOARD_ELATO_BREADBOARD
//   The original kit, wired to the xiaozhi `bread-compact-wifi` design: a raw
//   I2S mic and a MAX98357A on two independent I2S ports, a discrete RGB LED,
//   and every button straight onto a GPIO.
//
// BOARD_WAVESHARE_S3_AUDIO
//   Waveshare ESP32-S3-AUDIO-Board. An ES7210 ADC and an ES8311 DAC share one
//   full-duplex I2S bus and are both configured over I2C; the speaker amp
//   enable and three of the four keys sit behind a TCA9555 expander; the
//   status LED is a 7-pixel WS2812 ring.
//
//   Pin data came from the Waveshare wiki and two independent ESPHome port
//   repositories rather than from the schematic. If a signal turns out to be
//   on a different pin, Config.cpp is the only file that needs to change.
//
// BOARD_XMINI_C3
//   The xiaozhi "xmini-c3": ESP32-C3, 16MB flash, no PSRAM, single core. One
//   ES8311 does both directions -- DAC for the speaker and its own ADC for the
//   microphone -- on one full-duplex I2S bus with MCLK. The amplifier enable is
//   a plain GPIO, the only key is BOOT (GPIO9), the status LED is a single
//   the SSD1306 sits on the codec's I2C bus. There is no status LED: GPIO2,
//   which the open-source xiaozhi config calls the LED, is the battery sense
//   divider on this board, and GPIO12 is the charger's "charging" output.
//   Audio pins are from xiaozhi-esp32 v2.2.6 main/boards/xmini-c3/config.h;
//   the battery wiring is not in any public source and was read out of the
//   vendor firmware this board shipped with (see Battery.cpp).

#if !defined(BOARD_ELATO_BREADBOARD) && !defined(BOARD_WAVESHARE_S3_AUDIO) && \
    !defined(BOARD_XMINI_C3)
#define BOARD_ELATO_BREADBOARD
#endif

#if (defined(BOARD_ELATO_BREADBOARD) + defined(BOARD_WAVESHARE_S3_AUDIO) + \
     defined(BOARD_XMINI_C3)) != 1
#error "Define exactly one BOARD_* flag"
#endif

#if defined(BOARD_XMINI_C3)

// Structurally the Waveshare board with the ES7210 and the expander taken
// away: one codec chip on one I2S port, so the same shared-bus path. Without
// the ES7210 that path can run at 24kHz (see SAMPLE_RATE in Config.cpp), and
// the microphone, which has to share the rate, is brought down to 16kHz on
// the way to the server.
#define BOARD_HAS_CODEC          1
#define BOARD_HAS_ES7210         0
#define BOARD_SHARED_I2S_BUS     1
#define BOARD_HAS_IO_EXPANDER    0
#define BOARD_PA_VIA_EXPANDER    0
#define BOARD_KEYS_VIA_EXPANDER  0
// No volume rocker and no touch pad: BOOT is the only key, and it is
// push-to-talk. Volume comes from the server's settings.
#define BOARD_HAS_GPIO_KEYS      0
#define BOARD_HAS_WS2812_RING    0
#define BOARD_WS2812_COUNT       0
#define BOARD_HAS_STATUS_LED     0
#define BOARD_HAS_BATTERY        1
// The C3 has no APLL. MCLK comes from the 160MHz PLL through the I2S
// fractional divider instead, which is what xiaozhi runs this codec on.
#define BOARD_I2S_USE_APLL       0
// The mic runs at the speaker's 24kHz; Downsample.h turns it into the 16kHz
// the server's STT expects before it goes on the websocket.
#define BOARD_MIC_DOWNSAMPLE_3_2 1
// The ES8311's own DAC attenuation, under the software volume. xiaozhi drives
// this codec through esp_codec_dev, whose curve puts volume 70 at -11.4dB on
// the DAC; at 0dB ours puts the same 70 at -3.1dB, 8dB hotter. -8dB matched
// xiaozhi and took the edge off some distortion, but was too quiet to the
// person using it (2026-09-30), so it stays at 0dB. Lower it here if the
// speaker distorts.
#define BOARD_DAC_GAIN_DB        0.0f
// GPIO9 is not a deep-sleep wake source on the C3 (only GPIO0-5 are) and there
// is no ext0 at all, so sleep is a light sleep woken by GPIO9 followed by a
// restart -- the same fresh boot a deep-sleep wake gives the S3 boards.
#define BOARD_SLEEP_VIA_LIGHT_SLEEP 1
// Upright as u8g2 draws it by default. xiaozhi mirrors both axes on this
// board, but its panel driver's default orientation is not u8g2's: R2 here
// came out upside down on hardware (2026-09-23), R0 is right.
#define BOARD_DISPLAY_ROTATION   U8G2_R0
#define BOARD_NAME               "xiaozhi xmini-c3"

#elif defined(BOARD_WAVESHARE_S3_AUDIO)

// The two codecs share BCLK and LRCK, so one I2S port runs both directions and
// the mic and the speaker are forced onto a single sample rate. See the
// SAMPLE_RATE note in Config.cpp for why that rate is 16kHz.
#define BOARD_HAS_CODEC          1
#define BOARD_HAS_ES7210         1
#define BOARD_SHARED_I2S_BUS     1
#define BOARD_HAS_IO_EXPANDER    1
#define BOARD_PA_VIA_EXPANDER    1
#define BOARD_KEYS_VIA_EXPANDER  1
#define BOARD_HAS_GPIO_KEYS      0
#define BOARD_HAS_WS2812_RING    1
#define BOARD_WS2812_COUNT       7
#define BOARD_HAS_STATUS_LED     1
// GPIO8 is a battery ADC here too, but its divider and curve are unknown.
#define BOARD_HAS_BATTERY        0
#define BOARD_I2S_USE_APLL       1
#define BOARD_MIC_DOWNSAMPLE_3_2 0
#define BOARD_DAC_GAIN_DB        0.0f
#define BOARD_SLEEP_VIA_LIGHT_SLEEP 0
#define BOARD_DISPLAY_ROTATION   U8G2_R0
#define BOARD_NAME               "Waveshare ESP32-S3-AUDIO-Board"

#else

#define BOARD_HAS_CODEC          0
#define BOARD_HAS_ES7210         0
#define BOARD_SHARED_I2S_BUS     0
#define BOARD_HAS_IO_EXPANDER    0
#define BOARD_PA_VIA_EXPANDER    0
#define BOARD_KEYS_VIA_EXPANDER  0
#define BOARD_HAS_GPIO_KEYS      1
#define BOARD_HAS_WS2812_RING    0
#define BOARD_WS2812_COUNT       0
#define BOARD_HAS_STATUS_LED     1
#define BOARD_HAS_BATTERY        0
// Two I2S ports at different rates share the one APLL, so neither uses it.
// See audioStreamTask.
#define BOARD_I2S_USE_APLL       0
#define BOARD_MIC_DOWNSAMPLE_3_2 0
#define BOARD_SLEEP_VIA_LIGHT_SLEEP 0
#define BOARD_DISPLAY_ROTATION   U8G2_R0
#define BOARD_NAME               "Elato breadboard kit"

#endif

// Where the audio, LED and display tasks run. Core 1 on the dual-core S3
// leaves core 0 to the radio; the C3 has only core 0, and pinning to a core
// that does not exist fails an assert inside xTaskCreatePinnedToCore.
#if CONFIG_FREERTOS_UNICORE
#define APP_CORE 0
#else
#define APP_CORE 1
#endif

#endif

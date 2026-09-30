#include "LedRing.h"

#if BOARD_HAS_WS2812_RING

#include "driver/rmt.h"

namespace {

constexpr rmt_channel_t kChannel = RMT_CHANNEL_0;

// 80MHz APB / 2 = 40MHz, so one tick is 25ns. The WS2812B wants roughly
// 0.4us/0.85us for a zero and 0.8us/0.45us for a one, each with +/-150ns of
// slack -- comfortably wider than the quantisation at this divider.
constexpr uint8_t kClockDivider = 2;
constexpr uint16_t kT0High = 16;  // 400ns
constexpr uint16_t kT0Low  = 34;  // 850ns
constexpr uint16_t kT1High = 32;  // 800ns
constexpr uint16_t kT1Low  = 18;  // 450ns

constexpr int kBitsPerPixel = 24;
rmt_item32_t items[BOARD_WS2812_COUNT * kBitsPerPixel];

bool started = false;

}  // namespace

void ledRingBegin() {
    if (started) return;

    rmt_config_t config = RMT_DEFAULT_CONFIG_TX((gpio_num_t)LED_RING_PIN, kChannel);
    config.clk_div = kClockDivider;

    if (rmt_config(&config) != ESP_OK || rmt_driver_install(kChannel, 0, 0) != ESP_OK) {
        Serial.printf("WS2812 ring on GPIO%d: RMT setup FAILED\n", LED_RING_PIN);
        return;
    }

    started = true;
    Serial.printf("WS2812 ring on GPIO%d: %d pixels\n", LED_RING_PIN, BOARD_WS2812_COUNT);
    ledRingSet(0, 0, 0);
}

bool ledRingReady() { return started; }

void ledRingSet(uint8_t r, uint8_t g, uint8_t b) {
    if (!started) return;

    // WS2812B takes green first.
    const uint8_t channels[3] = {g, r, b};

    int index = 0;
    for (int pixel = 0; pixel < BOARD_WS2812_COUNT; pixel++) {
        for (uint8_t channel : channels) {
            for (int bit = 7; bit >= 0; bit--) {
                const bool one = (channel >> bit) & 1;
                items[index].level0 = 1;
                items[index].duration0 = one ? kT1High : kT0High;
                items[index].level1 = 0;
                items[index].duration1 = one ? kT1Low : kT0Low;
                index++;
            }
        }
    }

    // Blocking: the whole ring is 168 bits, about 180us on the wire, and every
    // caller is either setup or the LED task, neither of which is latency
    // critical. Waiting also means `items` cannot be rewritten mid-transfer.
    rmt_write_items(kChannel, items, index, true);
    // The latch gap. Two updates back to back without it would run together
    // into one long frame and the second would be shifted along the ring.
    delayMicroseconds(60);
}

#else

void ledRingBegin() {}
void ledRingSet(uint8_t, uint8_t, uint8_t) {}
bool ledRingReady() { return false; }

#endif

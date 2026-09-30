#include "Battery.h"

#if BOARD_HAS_BATTERY

// Everything here was read out of the vendor xiaozhi firmware this xmini-c3
// shipped with (v2.2.6, a PowerManager that is in no public xiaozhi source),
// by disassembling its constructor and ADC callback on 2026-09-24:
//
//   - gpio_config() on GPIO12 as a plain input, and "charging" is
//     gpio_get_level(12) == 1.
//   - adc_oneshot on ADC1 channel 2 (GPIO2), 12dB attenuation, 12-bit, raw
//     counts with no calibration -- which is what analogRead() returns here
//     with the attenuation set to match.
//   - the mean of the last 3 readings; a mean of 499 or less means nothing is
//     connected and the level is hidden.
//   - the table below, linearly interpolated, clamped to 0 and 100 outside it.
//
// The one difference is cadence: the vendor reads every second until it has
// 3 readings and then once a minute. This reads every 5s and averages 6, so
// the number on screen settles in 30s rather than 3 minutes and still does
// not flicker with the load of a turn.
namespace {

struct LevelPoint {
    uint16_t raw;
    uint8_t percent;
};

constexpr LevelPoint kLevels[] = {
    {2450, 0}, {2556, 20}, {2662, 40}, {2768, 60}, {2874, 80}, {3080, 100},
};
constexpr int kLevelCount = sizeof(kLevels) / sizeof(kLevels[0]);

constexpr uint16_t kAbsentBelowRaw = 500;
constexpr unsigned long kSampleIntervalMs = 5000;
constexpr int kWindow = 6;

// GPIO12 is the flash's HD line until the app takes it, and it comes out of
// reset with that function's pull-up still on. Straight after pinMode(INPUT)
// it read "charging" on a board that was not, and settled to the true level
// within 4s (2026-09-24). Ignore it until then.
constexpr unsigned long kChargePinSettleMs = 5000;
unsigned long beganAt = 0;

uint16_t samples[kWindow];
int sampleCount = 0;
int nextSample = 0;
unsigned long lastSampleAt = 0;

volatile bool present = false;
volatile int percent = 0;
volatile bool charging = false;

int percentFromRaw(uint32_t raw) {
    if (raw <= kLevels[0].raw) return 0;
    if (raw >= kLevels[kLevelCount - 1].raw) return 100;
    for (int i = 0; i < kLevelCount - 1; i++) {
        const LevelPoint &lo = kLevels[i];
        const LevelPoint &hi = kLevels[i + 1];
        if (raw < hi.raw) {
            return lo.percent + (int)((raw - lo.raw) * (hi.percent - lo.percent) / (hi.raw - lo.raw));
        }
    }
    return 100;
}

void takeSample() {
    samples[nextSample] = (uint16_t)analogRead(BATTERY_ADC_PIN);
    nextSample = (nextSample + 1) % kWindow;
    if (sampleCount < kWindow) sampleCount++;

    uint32_t sum = 0;
    for (int i = 0; i < sampleCount; i++) sum += samples[i];
    const uint32_t mean = sum / sampleCount;

    present = mean >= kAbsentBelowRaw;
    percent = percentFromRaw(mean);
    const bool nowCharging = millis() - beganAt >= kChargePinSettleMs &&
                             digitalRead(CHARGE_DETECT_PIN) == HIGH;
    if (nowCharging != charging) {
        Serial.printf("Battery: %s | raw %u, mean %u, %d%%\n",
                      nowCharging ? "charging" : "not charging",
                      (unsigned)samples[(nextSample + kWindow - 1) % kWindow],
                      (unsigned)mean, percent);
    }
    charging = nowCharging;
}

}  // namespace

void batteryBegin() {
    analogReadResolution(12);
    analogSetPinAttenuation(BATTERY_ADC_PIN, ADC_11db);  // == IDF 5's ADC_ATTEN_DB_12
    pinMode(CHARGE_DETECT_PIN, INPUT);
    beganAt = millis();
    takeSample();
    lastSampleAt = millis();
    Serial.printf("Battery: ADC GPIO%d, charge GPIO%d | %s, %d%%, %s\n",
                  BATTERY_ADC_PIN, CHARGE_DETECT_PIN, present ? "present" : "not connected",
                  percent, charging ? "charging" : "not charging");
}

void batteryPoll() {
    // Fast until the window is full, so the first number shown is not one
    // noisy reading; then at the steady cadence.
    const unsigned long interval = sampleCount < kWindow ? 500 : kSampleIntervalMs;
    if (millis() - lastSampleAt < interval) return;
    lastSampleAt = millis();
    takeSample();
}

bool batteryPresent() { return present; }
int batteryPercent() { return percent; }
bool batteryCharging() { return charging; }

#else

void batteryBegin() {}
void batteryPoll() {}
bool batteryPresent() { return false; }
int batteryPercent() { return 0; }
bool batteryCharging() { return false; }

#endif

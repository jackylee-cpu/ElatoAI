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
// What is ours rather than the vendor's is how a reading is taken, measured on
// this board on USB, battery at a steady ~2605 counts (2026-09-30):
//
//   - One analogRead() is far too noisy for this table. Single reads spread
//     2526..2743 around that steady level, with occasional spikes to 2254 and
//     3198 while the speaker and mic switch, and the table spends only 5.3
//     counts per percent. With one read per sample and 6 samples averaged,
//     the number on screen wandered 27..37% in a minute at a constant voltage.
//     So each sample is kReadsPerSample conversions, sorted, with the top and
//     bottom kTrimEachEnd thrown away: the spikes go, and the mean of what is
//     left is steady to a few counts.
//   - A sample is good on its own now, so the first one at boot fills the
//     whole window, and the number shown at power-on is right from the start.
//   - Samples are not taken while the toy is talking, or for a moment after:
//     on battery the speaker's current pulls the cell's terminal voltage
//     down. That sag has not been measured -- on USB the charger carries the
//     load -- so this is a precaution, not a fix for anything seen.
//   - What is shown moves only when the level has moved by kDisplayStep, so
//     the last digit does not flicker between two neighbours.
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
constexpr int kReadsPerSample = 64;
constexpr int kTrimEachEnd = 16;
constexpr unsigned long kQuietAfterSpeakingMs = 2000;
constexpr int kDisplayStep = 2;

uint16_t samples[kWindow];
int nextSample = 0;
unsigned long lastSampleAt = 0;
unsigned long lastSpeakingAt = 0;
uint16_t lastMean = 0;

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

// Trimmed mean of kReadsPerSample conversions: ~3ms, every 5s.
uint16_t readTrimmed() {
    uint16_t reads[kReadsPerSample];
    for (int i = 0; i < kReadsPerSample; i++) {
        const uint16_t v = (uint16_t)analogRead(BATTERY_ADC_PIN);
        int j = i;
        while (j > 0 && reads[j - 1] > v) {
            reads[j] = reads[j - 1];
            j--;
        }
        reads[j] = v;
    }
    uint32_t sum = 0;
    for (int i = kTrimEachEnd; i < kReadsPerSample - kTrimEachEnd; i++) sum += reads[i];
    return (uint16_t)(sum / (kReadsPerSample - 2 * kTrimEachEnd));
}

void update(bool fillWindow) {
    const uint16_t reading = readTrimmed();
    if (fillWindow) {
        for (int i = 0; i < kWindow; i++) samples[i] = reading;
    } else {
        samples[nextSample] = reading;
        nextSample = (nextSample + 1) % kWindow;
    }

    uint32_t sum = 0;
    for (int i = 0; i < kWindow; i++) sum += samples[i];
    lastMean = (uint16_t)(sum / kWindow);

    present = lastMean >= kAbsentBelowRaw;
    const int level = percentFromRaw(lastMean);
    if (fillWindow || abs(level - percent) >= kDisplayStep || level == 0 || level == 100) {
        if (!fillWindow && level != percent) {
            Serial.printf("Battery: %d%% -> %d%% | mean %u\n", (int)percent, level, (unsigned)lastMean);
        }
        percent = level;
    }

    const bool nowCharging = digitalRead(CHARGE_DETECT_PIN) == HIGH;
    if (nowCharging != charging) {
        Serial.printf("Battery: %s | raw %u, mean %u, %d%%\n",
                      nowCharging ? "charging" : "not charging",
                      (unsigned)reading, (unsigned)lastMean, (int)percent);
    }
    charging = nowCharging;
}

}  // namespace

void batteryBegin() {
    analogReadResolution(12);
    analogSetPinAttenuation(BATTERY_ADC_PIN, ADC_11db);  // == IDF 5's ADC_ATTEN_DB_12
    // Pulled down, not left floating. GPIO12 is the flash's HD line until the
    // app takes it, and floating it read 1 straight after boot and 0 a few
    // seconds later on a board that was never charging; the old code ignored
    // it for 5s to cover that. With the pull-down it reads 0 from the first
    // sample. It is also how we know nothing was driving it in that state (on
    // USB, cell ~3.86V): it read 1 with the pull-up and 0 with the pull-down
    // (2026-09-30). Whether the charger ever drives it high while charging,
    // as the vendor code assumes, has not been seen yet.
    pinMode(CHARGE_DETECT_PIN, INPUT_PULLDOWN);
    update(true);
    lastSampleAt = millis();
    Serial.printf("Battery: ADC GPIO%d, charge GPIO%d | %s, raw %u, %d%%, %s\n",
                  BATTERY_ADC_PIN, CHARGE_DETECT_PIN, present ? "present" : "not connected",
                  (unsigned)lastMean, (int)percent, charging ? "charging" : "not charging");
}

void batteryPoll() {
    if (deviceState == SPEAKING) {
        lastSpeakingAt = millis();
        return;
    }
    if (lastSpeakingAt != 0 && millis() - lastSpeakingAt < kQuietAfterSpeakingMs) return;
    if (millis() - lastSampleAt < kSampleIntervalMs) return;
    lastSampleAt = millis();
    update(false);
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

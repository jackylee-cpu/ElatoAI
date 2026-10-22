#include "SupplyMonitor.h"

#if BOARD_LOW_BATTERY_VIA_VDD

#include <Preferences.h>
#include <driver/adc.h>
#include <driver/gpio.h>
#include <esp_system.h>

// How this works, and what has and has not been measured.
//
// The Spotpear board's cell feeds a regulator that holds the chip at 3.3V.
// While the cell is above roughly 3.4V the regulator has headroom and VDD does
// not move; below that VDD follows the cell down. That is the last few percent
// of a Li-ion cell, so "VDD has started to sag" means "nearly empty", which is
// all a reminder needs.
//
// VDD itself is out of the ADC's reach: at 12dB a pin pulled up to it reads a
// flat 4095. With both internal pulls on, though, an undriven pin sits at a
// fixed fraction of VDD. Measured on USB 2026-10-05: GPIO0 read 2031..2039
// (about 1476mV, 45% of 3.3V) and GPIO1 2089..2090, steady to a few counts,
// once a second for 11s. The ADC's reference is internal, so the reading falls
// with VDD.
//
// The fraction rests on two on-chip resistors and will differ from chip to
// chip, so the threshold is relative to this board's own reference: the first
// reading it ever takes, which is on USB at the factory flash and so a healthy
// 3.3V. The reference only ever moves up. Low is kLowRatio under it, about
// 3.15V; it clears at kClearRatio, about 3.22V.
//
// NOT YET VERIFIED, and what the run log below is for: that the reading tracks
// VDD as a cell runs down; that the regulator is a plain LDO (a buck-boost
// would hold 3.3V to the end and this would never fire); and how long before
// shutdown the threshold is crossed.
namespace {

constexpr unsigned long kSampleIntervalMs = 5000;
constexpr int kWindow = 6;  // 30s of samples behind every decision
constexpr int kReadsPerSample = 64;
constexpr int kTrimEachEnd = 16;
#ifdef SUPPLY_LOW_RATIO_OVERRIDE
// Test builds only: a ratio above 1 makes a healthy supply count as low.
constexpr float kLowRatio = SUPPLY_LOW_RATIO_OVERRIDE;
constexpr float kClearRatio = SUPPLY_LOW_RATIO_OVERRIDE + 0.02f;
#else
constexpr float kLowRatio = 0.955f;
constexpr float kClearRatio = 0.975f;
#endif
// A full window has to beat the reference by this many counts to raise it, so
// sampling noise cannot ratchet it up.
constexpr uint16_t kRefStep = 4;
constexpr unsigned long kReminderEveryMs = 10UL * 60 * 1000;

// The run log: one entry every two minutes, kept in NVS so that a run-down on
// battery can be read back over USB afterwards. 300 entries is 10 hours.
constexpr unsigned long kLogEveryMs = 2UL * 60 * 1000;
constexpr int kLogEntries = 300;
constexpr int kLogFlushEvery = 5;  // entries between NVS writes: every 10 minutes
constexpr float kFlushEveryEntryBelow = 0.99f;  // ...or every entry once the supply sags
constexpr uint16_t kBootMarker = 0xFFFF;

struct LogEntry {
    uint16_t minute;  // since boot; kBootMarker starts a boot, see appendBoot()
    uint16_t mean;    // window mean when the entry was taken
    uint16_t lowest;  // lowest single sample since the previous entry
};

adc1_channel_t channel;
Preferences prefs;
uint16_t reference = 0;
uint16_t samples[kWindow];
int nextSample = 0;
uint16_t windowMean = 0;
uint16_t lowestSinceLog = 0xFFFF;
unsigned long lastSampleAt = 0;
unsigned long lastLogAt = 0;
unsigned long lastReminderAt = 0;
bool started = false;
bool logShown = false;
volatile bool low = false;
volatile bool reminderDue = false;

LogEntry logBuf[kLogEntries];
uint16_t logHead = 0;
uint16_t logCount = 0;
int unflushed = 0;

// Trimmed mean of kReadsPerSample conversions, ~3ms: Wi-Fi bursts dip the
// supply for a few hundred microseconds and would otherwise read as a sag.
uint16_t readTrimmed() {
    uint16_t reads[kReadsPerSample];
    for (int i = 0; i < kReadsPerSample; i++) {
        const uint16_t v = (uint16_t)adc1_get_raw(channel);
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

float percentOfReference(uint16_t v) {
    return reference ? 100.0f * v / reference : 0.0f;
}

void flushLog() {
    prefs.putBytes("log", logBuf, sizeof(logBuf));
    prefs.putUShort("head", logHead);
    prefs.putUShort("count", logCount);
    unflushed = 0;
}

void appendLog(const LogEntry &entry, bool flushNow) {
    logBuf[logHead] = entry;
    logHead = (logHead + 1) % kLogEntries;
    if (logCount < kLogEntries) logCount++;
    if (flushNow || ++unflushed >= kLogFlushEvery) flushLog();
}

// A boot reads back as {kBootMarker, reset reason, reference}.
void appendBoot() {
    appendLog({kBootMarker, (uint16_t)esp_reset_reason(), reference}, true);
}

void showLog() {
    Serial.printf("Supply log: %u entries, oldest first, as minute:mean/lowest "
                  "(B:reason/ref is a boot)\n", logCount);
    const uint16_t first = (logHead + kLogEntries - logCount) % kLogEntries;
    char line[160];
    int used = 0;
    for (uint16_t i = 0; i < logCount; i++) {
        const LogEntry &e = logBuf[(first + i) % kLogEntries];
        if (e.minute == kBootMarker) {
            used += snprintf(line + used, sizeof(line) - used, " B:%u/%u", e.mean, e.lowest);
        } else {
            used += snprintf(line + used, sizeof(line) - used, " %u:%u/%u", e.minute, e.mean, e.lowest);
        }
        if (used > 120 || i + 1 == logCount) {
            Serial.printf("Supply log:%s\n", line);
            used = 0;
        }
    }
}

void takeSample() {
    const uint16_t v = readTrimmed();
    samples[nextSample] = v;
    nextSample = (nextSample + 1) % kWindow;
    if (v < lowestSinceLog) lowestSinceLog = v;

    uint32_t sum = 0;
    for (int i = 0; i < kWindow; i++) sum += samples[i];
    windowMean = (uint16_t)(sum / kWindow);

    if (windowMean >= reference + kRefStep) {
        reference = windowMean;
        prefs.putUShort("ref", reference);
        Serial.printf("Supply: reference raised to %u\n", reference);
    }

    if (!low && windowMean < reference * kLowRatio) {
        low = true;
        reminderDue = true;
        lastReminderAt = millis();
        Serial.printf("Supply: LOW | mean %u = %.1f%% of reference %u\n", windowMean,
                      percentOfReference(windowMean), reference);
        appendLog({(uint16_t)(millis() / 60000), windowMean, lowestSinceLog}, true);
    } else if (low && windowMean > reference * kClearRatio) {
        low = false;
        reminderDue = false;
        Serial.printf("Supply: recovered | mean %u = %.1f%% of reference %u\n", windowMean,
                      percentOfReference(windowMean), reference);
    }

    if (low && millis() - lastReminderAt >= kReminderEveryMs) {
        reminderDue = true;
        lastReminderAt = millis();
    }
}

}  // namespace

void supplyMonitorBegin() {
    if (SUPPLY_SENSE_PIN < 0 || SUPPLY_SENSE_PIN > 4) {
        Serial.printf("Supply: GPIO%d is not an ADC1 pin, monitor off\n", SUPPLY_SENSE_PIN);
        return;
    }
    // The panel is not driven, but its SCLK is about to sit at mid-rail and
    // the console UART's TX shares its data line. Deselected, it ignores both.
    if (LCD_CS_PIN >= 0) {
        pinMode(LCD_CS_PIN, OUTPUT);
        digitalWrite(LCD_CS_PIN, HIGH);
    }

    // On the C3, ADC1 channel n is GPIOn for n = 0..4.
    channel = (adc1_channel_t)SUPPLY_SENSE_PIN;
    adc1_config_width(ADC_WIDTH_BIT_12);
    adc1_config_channel_atten(channel, ADC_ATTEN_DB_11);
    // After the ADC setup, which configures the pad with both pulls off.
    gpio_set_pull_mode((gpio_num_t)SUPPLY_SENSE_PIN, GPIO_PULLUP_PULLDOWN);
    delay(5);

    prefs.begin("supply", false);
    reference = prefs.getUShort("ref", 0);
    if (prefs.getBytesLength("log") == sizeof(logBuf)) {
        prefs.getBytes("log", logBuf, sizeof(logBuf));
        logHead = prefs.getUShort("head", 0) % kLogEntries;
        logCount = min<uint16_t>(prefs.getUShort("count", 0), kLogEntries);
    }

    const uint16_t first = readTrimmed();
    for (int i = 0; i < kWindow; i++) samples[i] = first;
    windowMean = first;
    lowestSinceLog = first;
    if (reference == 0) {
        reference = first;
        prefs.putUShort("ref", reference);
        Serial.printf("Supply: first boot, reference set to %u\n", reference);
    }
    appendBoot();

    // The supply collapsed under the last run. Whatever it reads now, with the
    // load gone, the cell is close to empty: say so once.
    if (esp_reset_reason() == ESP_RST_BROWNOUT) {
        reminderDue = true;
        lastReminderAt = millis();
        Serial.println("Supply: last reset was a brownout, reminding");
    }

    lastSampleAt = millis();
    lastLogAt = millis();
    started = true;
    Serial.printf("Supply: GPIO%d reads %u = %.1f%% of reference %u, low under %.1f%%\n",
                  SUPPLY_SENSE_PIN, first, percentOfReference(first), reference, kLowRatio * 100);
}

void supplyMonitorPoll() {
    if (!started) return;
    // After the USB host has had time to open the port, like the boot replay.
    if (!logShown && millis() > 5000) {
        logShown = true;
        showLog();
    }
    if (millis() - lastSampleAt >= kSampleIntervalMs) {
        lastSampleAt = millis();
        takeSample();
    }
    if (millis() - lastLogAt >= kLogEveryMs) {
        lastLogAt = millis();
        Serial.printf("Supply: mean %u = %.1f%% of reference %u, lowest %u, %s\n", windowMean,
                      percentOfReference(windowMean), reference, lowestSinceLog,
                      low ? "LOW" : "ok");
        // Every entry goes straight to NVS once the supply has started to sag:
        // a run-down's last minutes are the point of the log, and with ten
        // minutes between writes they died with the cell (2026-10-06, a run
        // that lasted under ten minutes left nothing behind).
        const bool sagging = windowMean < reference * kFlushEveryEntryBelow;
        appendLog({(uint16_t)(millis() / 60000), windowMean, lowestSinceLog}, sagging);
        lowestSinceLog = 0xFFFF;
    }
}

bool supplyLow() { return low; }

bool supplyTakeReminder() {
    if (!reminderDue) return false;
    reminderDue = false;
    return true;
}

// The window mean, not a fresh reading: this runs on wifiTask while loop()
// owns the ADC. Before the first sample is due the window holds the boot
// reading, so an install right after boot is judged too.
bool supplyTooLowForUpdate(float &percent, float &lowLine) {
    if (!started) return false;
    percent = percentOfReference(windowMean);
    lowLine = kLowRatio * 100;
    return low || windowMean < reference * kLowRatio;
}

#else

void supplyMonitorBegin() {}
void supplyMonitorPoll() {}
bool supplyLow() { return false; }
bool supplyTakeReminder() { return false; }
bool supplyTooLowForUpdate(float &, float &) { return false; }

#endif

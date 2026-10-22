#include "CrashReport.h"

#include <ArduinoJson.h>
#include <Preferences.h>
#include <esp_attr.h>
#include <esp_random.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "OTA.h"  // FIRMWARE_VERSION

namespace {

constexpr uint32_t kNoteMagic = 0xC4A5'4E07;

// Written by the panic hook, read once at the next boot. RTC_NOINIT: the
// startup code leaves it alone, so it outlives the reset.
struct PanicNote {
    uint32_t magic;
    uint32_t pc;
    uint32_t ra;
    uint32_t uptimeS;
    char task[16];
    char version[16];
    // The core's one-line reason, or for an abort its own message: "abort()
    // was called at PC 0x... on core 0", "assert failed: file:line ...".
    char detail[48];
};
RTC_NOINIT_ATTR PanicNote panicNote;

const char *reasonKey(esp_reset_reason_t reason) {
    switch (reason) {
        case ESP_RST_PANIC: return "panic";
        case ESP_RST_INT_WDT: return "int_wdt";
        case ESP_RST_TASK_WDT: return "task_wdt";
        case ESP_RST_WDT: return "wdt";
        case ESP_RST_BROWNOUT: return "brownout";
        default: return nullptr;
    }
}

void copyField(char *to, size_t size, const char *from) {
    if (!from) from = "";
    size_t i = 0;
    for (; i + 1 < size && from[i]; i++) to[i] = from[i];
    to[i] = '\0';
}

}  // namespace

#if CRASH_REPORT_PANIC_HOOK
// Linked in with -Wl,--wrap (platformio.ini): every panic, the watchdogs'
// included, passes through here before the core prints it and resets. Only
// plain stores: the system is going down, nothing may block.
#include <esp_private/panic_internal.h>
#include <riscv/rvruntime-frames.h>

extern "C" void __real_esp_panic_handler(panic_info_t *info);
extern "C" void __real_esp_system_abort(const char *details);

// abort(), assert() and the task watchdog all end here first. The panic that
// follows traps inside the abort itself (as a "Store access fault"), so its
// frame says nothing; where abort() was called from is in this message.
static bool aborted = false;
static uint32_t abortPc = 0;

extern "C" void __wrap_esp_system_abort(const char *details) {
    copyField(panicNote.detail, sizeof(panicNote.detail), details);
    const char *pc = details ? strstr(details, "PC 0x") : nullptr;
    abortPc = pc ? (uint32_t)strtoul(pc + 3, nullptr, 16) : 0;
    aborted = true;
    __real_esp_system_abort(details);
}

extern "C" void __wrap_esp_panic_handler(panic_info_t *info) {
    const RvExcFrame *frame = (const RvExcFrame *)info->frame;
    if (aborted) {
        panicNote.pc = abortPc ? abortPc : (frame ? frame->mepc : 0);
        panicNote.ra = 0;
    } else {
        panicNote.pc = frame ? frame->mepc : (uint32_t)info->addr;
        panicNote.ra = frame ? frame->ra : 0;
        copyField(panicNote.detail, sizeof(panicNote.detail), info->reason);
    }
    panicNote.uptimeS = (uint32_t)(esp_timer_get_time() / 1000000);
    TaskHandle_t task = xTaskGetCurrentTaskHandle();
    copyField(panicNote.task, sizeof(panicNote.task), task ? pcTaskGetName(task) : "");
    copyField(panicNote.version, sizeof(panicNote.version), FIRMWARE_VERSION);
    panicNote.magic = kNoteMagic;
    __real_esp_panic_handler(info);
}
#endif

void crashReportBegin() {
    const esp_reset_reason_t reset = esp_reset_reason();
    const char *reason = reasonKey(reset);
    const bool noted = panicNote.magic == kNoteMagic;
    panicNote.magic = 0;  // read once
    if (!reason) return;

    Preferences prefs;
    if (!prefs.begin("crash", false)) return;
    const uint32_t count = prefs.getUInt("count", 0) + 1;
    prefs.putUInt("count", count);
    // A new id per crash: the server stores each id once, so a report sent
    // again because its ack was lost is not counted twice.
    prefs.putUInt("id", esp_random());
    prefs.putString("reason", reason);
    if (noted) {
        prefs.putUInt("pc", panicNote.pc);
        prefs.putUInt("ra", panicNote.ra);
        prefs.putUInt("up", panicNote.uptimeS);
        prefs.putString("task", panicNote.task);
        prefs.putString("ver", panicNote.version);
        prefs.putString("detail", panicNote.detail);
    } else {
        // A brownout or an RTC watchdog: no note, and the image is most
        // likely this one (a rollback would have said so in OTA.cpp).
        for (const char *key : {"pc", "ra", "up", "task", "detail"}) prefs.remove(key);
        prefs.putString("ver", FIRMWARE_VERSION);
    }
    prefs.end();
    Serial.printf("[CRASH] Last reset: %s%s (%u since the last report)\n", reason,
                  noted ? ", noted" : "", (unsigned)count);
}

String crashReportJson() {
    Preferences prefs;
    if (!prefs.begin("crash", true)) return String();
    const uint32_t count = prefs.getUInt("count", 0);
    if (count == 0) {
        prefs.end();
        return String();
    }
    JsonDocument doc;
    doc["type"] = "crash";
    doc["id"] = prefs.getUInt("id", 0);
    doc["count"] = count;
    doc["reason"] = prefs.getString("reason", "panic");
    doc["fw"] = prefs.getString("ver", FIRMWARE_VERSION);
    if (prefs.isKey("pc")) {
        char hex[11];
        snprintf(hex, sizeof(hex), "0x%08lx", (unsigned long)prefs.getUInt("pc", 0));
        doc["pc"] = hex;
        // None after an abort: pc is then where abort() was called from.
        const uint32_t ra = prefs.getUInt("ra", 0);
        if (ra) {
            snprintf(hex, sizeof(hex), "0x%08lx", (unsigned long)ra);
            doc["ra"] = hex;
        }
        doc["uptime_s"] = prefs.getUInt("up", 0);
        doc["task"] = prefs.getString("task", "");
        doc["detail"] = prefs.getString("detail", "");
    }
    prefs.end();
    String out;
    serializeJson(doc, out);
    return out;
}

void crashReportAcked(uint32_t id) {
    Preferences prefs;
    if (!prefs.begin("crash", false)) return;
    // Only the report that was stored; a crash since then has a new id.
    if (prefs.getUInt("count", 0) > 0 && prefs.getUInt("id", 0) == id) {
        prefs.clear();
        Serial.println("[CRASH] Report stored by the server");
    }
    prefs.end();
}

#if CRASH_TEST
#ifndef CRASH_TEST_AFTER_MS
#define CRASH_TEST_AFTER_MS 20000
#endif
// Survives the crash's reset, so each kind of test fires once per power-up
// (or per flash of the other kind).
RTC_NOINIT_ATTR static uint32_t crashTestDone;
constexpr uint32_t kTestDone = kNoteMagic ^ CRASH_TEST;

void crashTestPoll(bool authed) {
    static unsigned long authedAt = 0;
    if (crashTestDone == kTestDone || !authed) return;
    if (!authedAt) authedAt = millis() ? millis() : 1;
    if (millis() - authedAt < CRASH_TEST_AFTER_MS) return;
    crashTestDone = kTestDone;
#if CRASH_TEST == 1
    Serial.println("[CRASH] Test: writing through a null pointer");
    Serial.flush();
    *(volatile uint32_t *)nullptr = 0xdead;
#else
    Serial.println("[CRASH] Test: spinning without yielding until the task watchdog fires");
    Serial.flush();
    vTaskPrioritySet(nullptr, configMAX_PRIORITIES - 1);
    for (volatile uint32_t i = 0;; i++) {
    }
#endif
}
#endif

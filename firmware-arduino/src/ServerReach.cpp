#include "ServerReach.h"

#include <Arduino.h>
#include <WiFi.h>
#include <esp_attr.h>
#include <esp_heap_caps.h>

#ifndef SERVER_REACH_WIFI_RESET_MS
#define SERVER_REACH_WIFI_RESET_MS (60UL * 1000UL)
#endif
#ifndef SERVER_REACH_RESTART_MS
#define SERVER_REACH_RESTART_MS (3UL * 60UL * 1000UL)
#endif

// Survive the restart (not a power cut): whether this outage already cost one,
// and whether the next boot should skip its chime.
static const uint32_t kReachMagic = 0x52454348;  // "RECH"
static RTC_NOINIT_ATTR uint32_t reachMagic;
static RTC_NOINIT_ATTR uint8_t restartedThisOutage;
static RTC_NOINIT_ATTR uint8_t silentNextBoot;

static volatile bool reachedFlag = false;
static volatile bool waitingOnPerson = false;
static volatile bool wifiResetWanted = false;
static uint32_t unreachableMs = 0;
static uint32_t lastPollMs = 0;
static uint32_t nextWifiResetMs = SERVER_REACH_WIFI_RESET_MS;
static uint32_t lastReportMs = 0;

static void initRtc() {
    if (reachMagic != kReachMagic) {
        reachMagic = kReachMagic;
        restartedThisOutage = 0;
        silentNextBoot = 0;
    }
}

void serverReached() { reachedFlag = true; }

void serverReachTokenAnswer(bool answered) {
    waitingOnPerson = answered;
    if (answered) reachedFlag = true;
}

bool serverReachSilentBoot() {
    initRtc();
    const bool silent = silentNextBoot != 0;
    silentNextBoot = 0;
    return silent;
}

bool serverReachTakeWifiReset() {
    if (!wifiResetWanted) return false;
    wifiResetWanted = false;
    return true;
}

void serverReachPoll(bool socketOpen) {
    const uint32_t now = millis();
    const uint32_t dt = lastPollMs ? now - lastPollMs : 0;
    lastPollMs = now;

    // Checked as a state, not only as an event: counting from the last
    // "opened" alone took a healthy session for an outage after 60s and reset
    // Wi-Fi under it (62:70, 2026-10-15).
    if (reachedFlag || socketOpen || waitingOnPerson) {
        reachedFlag = false;
        if (unreachableMs >= SERVER_REACH_WIFI_RESET_MS) {
            Serial.printf("[REACH] Server back after %lus without it\n", (unsigned long)(unreachableMs / 1000));
        }
        initRtc();
        restartedThisOutage = 0;
        unreachableMs = 0;
        nextWifiResetMs = SERVER_REACH_WIFI_RESET_MS;
        return;
    }
    if (WiFi.status() != WL_CONNECTED) return;

    unreachableMs += dt;

    // Every 15s while it lasts: the heap line is how a leak in the retry path
    // shows up (2026-10-13 measured ~170 B per failed attempt).
    if (unreachableMs >= 15000 && now - lastReportMs >= 15000) {
        lastReportMs = now;
        Serial.printf("[REACH] No server for %lus | heap %u, largest %u\n",
                      (unsigned long)(unreachableMs / 1000),
                      (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                      (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    }

    initRtc();
    if (SERVER_REACH_RESTART_MS && unreachableMs >= SERVER_REACH_RESTART_MS && !restartedThisOutage) {
        Serial.printf("[REACH] No server for %lus on Wi-Fi: restarting\n", (unsigned long)(unreachableMs / 1000));
        restartedThisOutage = 1;
        silentNextBoot = 1;
        delay(100);
        ESP.restart();
    }
    if (SERVER_REACH_WIFI_RESET_MS && unreachableMs >= nextWifiResetMs) {
        Serial.printf("[REACH] No server for %lus on Wi-Fi: resetting Wi-Fi\n", (unsigned long)(unreachableMs / 1000));
        nextWifiResetMs += SERVER_REACH_WIFI_RESET_MS;
        wifiResetWanted = true;
    }
}

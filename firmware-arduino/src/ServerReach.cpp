#include "ServerReach.h"

#include <Arduino.h>
#include <WiFi.h>
#include <esp_attr.h>
#include <esp_heap_caps.h>

#ifndef SERVER_REACH_SEARCHING_MS
#define SERVER_REACH_SEARCHING_MS (8UL * 1000UL)
#endif
#ifndef SERVER_REACH_CHECK_MS
#define SERVER_REACH_CHECK_MS (60UL * 1000UL)
#endif
#ifndef SERVER_REACH_RESTART_MS
#define SERVER_REACH_RESTART_MS (3UL * 60UL * 1000UL)
#endif
// "無法連接" + "正在配網..." again at most this often: setup times out after
// two minutes and comes back while nobody has fixed anything.
static const uint32_t kSetupPromptEveryMs = 10UL * 60UL * 1000UL;

// Survive the restart (not a power cut): whether this outage already cost one,
// and whether the next boot should skip its chime.
static const uint32_t kReachMagic = 0x52454348;  // "RECH"
static RTC_NOINIT_ATTR uint32_t reachMagic;
static RTC_NOINIT_ATTR uint8_t restartedThisOutage;
static RTC_NOINIT_ATTR uint8_t silentNextBoot;

static volatile bool reachedFlag = false;
static volatile bool waitingOnPerson = false;
static volatile bool wifiCheckWanted = false;
static volatile bool serverDown = false;
static volatile NetStatus status = NET_OK;
static uint32_t offlineMs = 0;      // no session, on Wi-Fi or not
static uint32_t unreachableMs = 0;  // no session while on Wi-Fi
static uint32_t lastPollMs = 0;
static uint32_t nextCheckMs = SERVER_REACH_CHECK_MS;
static uint32_t lastReportMs = 0;
static bool searchPromptPlayed = false;
static uint32_t lastSetupPromptMs = 0;

// Two slots is all a moment ever needs ("無法連接" then "正在配網..."). Written
// by the network and Wi-Fi tasks, read by the audio task.
static portMUX_TYPE promptMux = portMUX_INITIALIZER_UNLOCKED;
static const char *prompts[2] = {nullptr, nullptr};

static void queuePrompts(const char *first, const char *second) {
    taskENTER_CRITICAL(&promptMux);
    prompts[0] = first;
    prompts[1] = second;
    taskEXIT_CRITICAL(&promptMux);
}

const char *serverReachTakePrompt() {
    taskENTER_CRITICAL(&promptMux);
    const char *next = prompts[0];
    prompts[0] = prompts[1];
    prompts[1] = nullptr;
    taskEXIT_CRITICAL(&promptMux);
    return next;
}

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

NetStatus serverReachStatus() { return status; }

bool serverReachSilentBoot() {
    initRtc();
    const bool silent = silentNextBoot != 0;
    silentNextBoot = 0;
    return silent;
}

bool serverReachTakeWifiCheck() {
    if (!wifiCheckWanted) return false;
    wifiCheckWanted = false;
    return true;
}

void serverReachInternetUp() {
    if (!serverDown) {
        Serial.println("[REACH] The internet answers and our server does not: waiting it out");
    }
    serverDown = true;
    status = NET_SERVER_DOWN;
}

void serverReachSetupOpened(bool hadNetworks) {
    const uint32_t now = millis();
    if (lastSetupPromptMs && now - lastSetupPromptMs < kSetupPromptEveryMs) return;
    lastSetupPromptMs = now;
    if (hadNetworks) {
        queuePrompts("wifi_no_ap", "wifi_setup");
    } else {
        queuePrompts("wifi_setup", nullptr);
    }
}

void serverReachPoll(bool socketOpen, bool settingUp) {
    const uint32_t now = millis();
    const uint32_t dt = lastPollMs ? now - lastPollMs : 0;
    lastPollMs = now;

    // Checked as a state, not only as an event: counting from the last
    // "opened" alone took a healthy session for an outage after 60s and reset
    // Wi-Fi under it (62:70, 2026-10-15).
    if (reachedFlag || socketOpen || waitingOnPerson) {
        reachedFlag = false;
        if (offlineMs >= SERVER_REACH_SEARCHING_MS) {
            Serial.printf("[REACH] Server back after %lus without it\n", (unsigned long)(offlineMs / 1000));
        }
        initRtc();
        restartedThisOutage = 0;
        offlineMs = 0;
        unreachableMs = 0;
        nextCheckMs = SERVER_REACH_CHECK_MS;
        serverDown = false;
        searchPromptPlayed = false;
        status = NET_OK;
        return;
    }
    if (settingUp) return;

    offlineMs += dt;
    if (offlineMs >= SERVER_REACH_SEARCHING_MS && status == NET_OK) {
        status = NET_SEARCHING;
        if (!searchPromptPlayed) {
            searchPromptPlayed = true;
            queuePrompts("wifi_try", nullptr);
        }
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
    if (SERVER_REACH_RESTART_MS && serverDown && unreachableMs >= SERVER_REACH_RESTART_MS &&
        !restartedThisOutage) {
        Serial.printf("[REACH] No server for %lus with the internet up: restarting\n",
                      (unsigned long)(unreachableMs / 1000));
        restartedThisOutage = 1;
        silentNextBoot = 1;
        delay(100);
        ESP.restart();
    }
    if (SERVER_REACH_CHECK_MS && unreachableMs >= nextCheckMs) {
        Serial.printf("[REACH] No server for %lus on Wi-Fi: checking the internet\n",
                      (unsigned long)(unreachableMs / 1000));
        nextCheckMs += SERVER_REACH_CHECK_MS;
        wifiCheckWanted = true;
    }
}

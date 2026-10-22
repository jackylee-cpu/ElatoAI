/**
 * Wifi Manager
 * (c) 2022-2024 Martin Verges
 *
 * Licensed under CC BY-NC-SA 4.0
 * (Attribution-NonCommercial-ShareAlike 4.0 International)
**/
#include "WifiManager.h"
#include "OTA.h"
#include "ServerReach.h"
#include "Audio.h"
#include "AsyncJson.h"
#include "ArduinoJson.h"
#include <WiFi.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <Config.h>

// Set by POST /api/wifi/add so loop() can do the actual connect. tryConnect()
// blocks for seconds and the handler runs on the AsyncTCP task, where blocking
// is a known crash source.
static volatile bool connectRequested = false;

// Backoff for the "online but nobody has claimed me yet" poll.
static uint64_t nextProvisionAttemptMillis = 0;
static uint32_t provisionBackoffMillis = 5000;
static const uint32_t PROVISION_BACKOFF_MAX = 30000;

// The board's own secret, issued by the web app the first time it called in
// and never shown again. It is the only thing that proves this board is this
// board: lose it and the board is locked out until its device_secrets row is
// deleted, so it lives apart from everything a factory reset of the account
// side would touch.
static String loadDeviceSecret() {
  preferences.begin("device", false);
  // isKey first: getString on a missing key logs an error on every first boot.
  String secret = preferences.isKey("secret") ? preferences.getString("secret", "") : String();
  preferences.end();
  return secret;
}

static void storeDeviceSecret(const char *secret) {
  preferences.begin("device", false);
  preferences.putString("secret", secret);
  preferences.end();
}

// Renew this long before the token runs out, so no session starts on one that
// is about to die.
static const uint32_t TOKEN_RENEW_MARGIN_MS = 60UL * 60UL * 1000UL;

static bool deviceTokenFresh() {
  return !authTokenGlobal.isEmpty() && !authTokenRejected &&
         (int32_t)(authTokenExpiresAtMs - millis()) > (int32_t)TOKEN_RENEW_MARGIN_MS;
}

// Trade the device secret for a device token. A board calling in for the very
// first time has no secret yet and is issued one with the answer.
static bool fetchDeviceToken() {
    HTTPClient http;
    WiFiClientSecure client;
    beginBackendRequest(http, client, "/api/generate_auth_token");
    http.addHeader("Content-Type", "application/json");
    http.setTimeout(10000);

    JsonDocument request;
    request["macAddress"] = WiFi.macAddress();
    const String secret = loadDeviceSecret();
    if (!secret.isEmpty()) {
        request["deviceSecret"] = secret;
    }
    otaAddReport(request);
    String body;
    serializeJson(request, body);

    const int httpCode = http.POST(body);
    // An answer that ends the attempt is our server talking: 202 (nobody owns
    // this board, so no socket follows) and refusals alike. A 200 does not
    // count -- the voice socket comes next and is what has to work. Counting
    // it cleared the outage at every boot, and a board whose voice server was
    // down restarted every three minutes (62:70, 2026-10-15). Negative codes
    // are the connection itself failing.
    serverReachTokenAnswer(httpCode > 0 && httpCode != HTTP_CODE_OK);
    if (httpCode != HTTP_CODE_OK && httpCode != 202) {
        // 401 is the one that needs a person: this board's secret is missing
        // or wrong, and it cannot get back in by retrying.
        Serial.printf("[AUTH] generate_auth_token returned %d%s\n", httpCode,
                      httpCode == 401 ? " -- device secret refused" : "");
        http.end();
        return false;
    }

    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, http.getString());
    http.end();
    if (error) {
        Serial.printf("[AUTH] JSON parsing failed: %s\n", error.c_str());
        return false;
    }

    const char *issued = doc["device_secret"];
    if (issued && *issued) {
        storeDeviceSecret(issued);
        Serial.println("[AUTH] Device secret issued and stored");
    }

    // 202 means the backend knows this board but no account has claimed it yet.
    // That is a normal state during onboarding, not an error -- keep quiet and
    // let the caller retry. Whatever token is left from before an unbind is
    // worthless now; dropping it also makes loop() poll faster.
    if (httpCode == 202) {
        Serial.printf("[AUTH] Registered, waiting to be claimed (code %s)\n",
                      (const char *)(doc["user_code"] | "?"));
        deviceUnclaimed = true;
        authTokenGlobal = "";
        return false;
    }

    const char *token = doc["token"];
    if (!token || !*token) {
        Serial.println("[AUTH] No token in the response");
        return false;
    }
    const uint32_t expiresIn = doc["expires_in"] | 3600;
    authTokenGlobal = token;
    authTokenExpiresAtMs = millis() + expiresIn * 1000UL;
    authTokenRejected = false;
    deviceUnclaimed = false;
    otaTakeAnswer(doc["ota"]);
    Serial.printf("[AUTH] Device token valid for %us\n", (unsigned)expiresIn);
    return true;
}

bool isDeviceRegistered() {
  return deviceTokenFresh() || fetchDeviceToken();
}

void connectCb();

// Get a session going, and keep its token alive. Without the retry a board that
// is online but unclaimed never opens the websocket and never tries again, so
// it looks dead until it is power-cycled.
void startSessionIfReady() {
  if (deviceTokenFresh()) return;
  // A token on its way out is renewed only between sessions: the C3 has no
  // room for this request's TLS next to the websocket's.
  if (websocketStarted && webSocket.isConnected()) return;
  if (millis() < nextProvisionAttemptMillis) return;

  bool ok;
  if (websocketStarted) {
    // The socket retries on its own every second. Hold it off until the new
    // token is in its headers, which also keeps its TLS out of the way. A
    // socket paused on a refused token resumes only with the new one.
    xSemaphoreTake(wsMutex, portMAX_DELAY);
    ok = isDeviceRegistered();
    if (ok) {
      webSocket.setExtraHeaders(websocketExtraHeaders().c_str());
      websocketPaused = false;
    }
    xSemaphoreGive(wsMutex);
  } else {
    ok = isDeviceRegistered();
    if (ok) {
      connectCb();
    }
  }

  if (ok) {
    provisionBackoffMillis = 5000;
    return;
  }
  nextProvisionAttemptMillis = millis() + provisionBackoffMillis;
  provisionBackoffMillis = min(provisionBackoffMillis * 2, PROVISION_BACKOFF_MAX);
}

void connectCb() {
  Serial.println("On connecting to Wifi");
  if (isDeviceRegistered())  {
    // Returns only when there is nothing to install or the install failed;
    // a successful one restarts the board into the new image.
    otaCheckAndUpdate();
    websocketSetup(ws_server, ws_port, ws_path);
  } 
}

/**
 * @brief Write a message to the Serial interface
 * @param msg The message to be written
 *
 * This function is a simple wrapper around Serial.print() to write a message
 * to the serial console. It can be overwritten by a custom implementation for 
 * enhanced logging.
 */
void WIFIMANAGER::logMessage(String msg) {
  Serial.print(msg);
}

/**
 * @brief Background Task running as a loop forever
 * @param param needs to be a valid WIFIMANAGER instance
 */
void wifiTask(void* param) {
  yield();
  delay(500); // wait a short time until everything is setup before executing the loop forever
  yield();
  const TickType_t xDelay = 10000 / portTICK_PERIOD_MS;
  WIFIMANAGER * wifimanager = (WIFIMANAGER *) param;

  UBaseType_t worstStack = UINT32_MAX;
  for(;;) {
    yield();
    wifimanager->loop();
    yield();
    // The device registration HTTPS request and its TLS handshake run on this
    // task (loop() -> startSessionIfReady() -> isDeviceRegistered()), so this
    // is the number to trim WIFI_TASK_STACK_BYTES against.
    UBaseType_t stackLeft = uxTaskGetStackHighWaterMark(NULL);
    if (stackLeft < worstStack) {
      worstStack = stackLeft;
      Serial.printf("[WIFI] Task stack headroom: %u bytes\n", (unsigned)stackLeft);
    }
    // Sleeps the same 10s as before, but a remote Wi-Fi request (R-37) wakes
    // it early so the web page is not left waiting. loop() keeps its own
    // interval, so an early wake does not mean an early health check.
    ulTaskNotifyTake(pdTRUE, xDelay);
    wifimanager->serviceRemote();
  }
}

/**
 * Captive portal DNS. While the SoftAP is up, every name resolves to the AP's
 * own address, so the connectivity probe a phone sends on joining (Apple's
 * captive.apple.com/hotspot-detect.html, Android's /generate_204, Windows'
 * connecttest.txt) lands on our web server instead of the internet. The
 * catch-all in main.cpp answers it with a redirect to the setup page, and the
 * phone takes "not the expected answer" as a captive portal and pops the page
 * up on its own -- no typing 192.168.4.1.
 *
 * A task of its own because DNSServer is polled, and wifiTask is not a place
 * to poll from: it sleeps 10s between passes and can block for seconds inside
 * tryConnect(). It also owns start() and stop(), following the AP up and
 * down, so no other task ever touches the DNSServer object.
 */
// Bytes, not words: ESP-IDF's FreeRTOS takes the stack depth in bytes. 4096
// was enough on the S3, but on the C3 the registration request's TLS
// handshake overflowed it on every connect -- "stack overflow in task
// WifiManager", a boot loop the moment WiFi came up (2026-09-23).
#if CONFIG_IDF_TARGET_ESP32C3
#define WIFI_TASK_STACK_BYTES 8192
#else
#define WIFI_TASK_STACK_BYTES 4096
#endif

static void captiveDnsTask(void *param) {
  DNSServer dns;
  bool running = false;
  for (;;) {
    const bool apUp = (WiFi.getMode() & WIFI_MODE_AP) != 0;
    if (apUp && !running) {
      running = dns.start(53, "*", WiFi.softAPIP());
      Serial.printf("[WIFI] Captive DNS %s on %s\n", running ? "started" : "FAILED",
                    WiFi.softAPIP().toString().c_str());
    } else if (!apUp && running) {
      dns.stop();
      running = false;
      Serial.println("[WIFI] Captive DNS stopped");
    }
    if (running) {
      dns.processNextRequest();
      vTaskDelay(pdMS_TO_TICKS(20));
    } else {
      vTaskDelay(pdMS_TO_TICKS(500));
    }
  }
}

/**
 * @brief Start the background task, which will take care of the Wifi connection
 *
 * This method will load the configuration from NVS, try to connect to the configured WIFI(s)
 * and then start a background task, which will keep monitoring and trying to reconnect
 * to the configured WIFI(s) in case the connection drops.
 */
void WIFIMANAGER::startBackgroundTask(String softApName, String softApPass) {
  if (softApName.length()) this->softApName = softApName;
  if (softApPass.length()) this->softApPass = softApPass;

  WiFi.setSleep(false);
  loadFromNVS();
  if (!tryConnect()) staLostMillis = millis();  // the setup grace counts from boot

  BaseType_t taskCreated = xTaskCreatePinnedToCore(
    wifiTask,
    "WifiManager",
    WIFI_TASK_STACK_BYTES,
    this,   // Task input parameter
    1,      // Priority of the task
    &WifiCheckTask,  // Task handle.
    0       // Core where the task should run
  );

  if (taskCreated != pdPASS) {
    logMessage("[ERROR] WifiManager: Error creating background task\n");
  }

  if (xTaskCreatePinnedToCore(captiveDnsTask, "Captive DNS", 3072, NULL, 1, NULL, 0) != pdPASS) {
    logMessage("[ERROR] WifiManager: Error creating captive DNS task\n");
  }
}

/**
 * @brief Construct a new WIFIMANAGER::WIFIMANAGER object
 * @details Puts the Wifi mode to AP+STA and registers Wifi Events
 * @param ns Namespace for the preferences non volatile storage (NVS)
 */
WIFIMANAGER::WIFIMANAGER(const char * ns) {
  NVS = (char *)ns;

  // AP on/off
  WiFi.onEvent([&](WiFiEvent_t event, WiFiEventInfo_t info) {
    logMessage("[WIFI] onEvent() AP mode started!\n");
    softApRunning = true;
    deviceState = SOFT_AP;
    serverReachSetupOpened(configAvailable());
#if ESP_ARDUINO_VERSION_MAJOR >= 2
    }, ARDUINO_EVENT_WIFI_AP_START); // arduino-esp32 2.0.0 and later
#else
    }, SYSTEM_EVENT_AP_START); // arduino-esp32 1.0.6
#endif
  WiFi.onEvent([&](WiFiEvent_t event, WiFiEventInfo_t info) {
    logMessage("[WIFI] onEvent() AP mode stopped!\n");
    softApRunning = false;
    // Only out of SOFT_AP: enterSleep() turns the radio off after setting
    // SLEEP, and IDLE here would light the ring for the whole sleep.
    if (deviceState == SOFT_AP) deviceState = IDLE;
#if ESP_ARDUINO_VERSION_MAJOR >= 2
    }, ARDUINO_EVENT_WIFI_AP_STOP); // arduino-esp32 2.0.0 and later
#else
    }, SYSTEM_EVENT_AP_STOP); // arduino-esp32 1.0.6
#endif
  // AP client join/leave
  WiFi.onEvent([&](WiFiEvent_t event, WiFiEventInfo_t info) {
    logMessage("[WIFI] onEvent() new client connected to softAP!\n");
#if ESP_ARDUINO_VERSION_MAJOR >= 2
    }, ARDUINO_EVENT_WIFI_AP_STACONNECTED); // arduino-esp32 2.0.0 and later
#else
    }, SYSTEM_EVENT_AP_STACONNECTED); // arduino-esp32 1.0.6
#endif
  WiFi.onEvent([&](WiFiEvent_t event, WiFiEventInfo_t info) {
    logMessage("[WIFI] onEvent() Client disconnected from softAP!\n");
#if ESP_ARDUINO_VERSION_MAJOR >= 2
    }, ARDUINO_EVENT_WIFI_AP_STADISCONNECTED); // arduino-esp32 2.0.0 and later
#else
    }, SYSTEM_EVENT_AP_STADISCONNECTED); // arduino-esp32 1.0.6
#endif
}

/**
 * @brief Destroy the WIFIMANAGER::WIFIMANAGER object
 * @details will stop the background task as well but not cleanup the AsyncWebserver
 */
WIFIMANAGER::~WIFIMANAGER() {
  vTaskDelete(WifiCheckTask);
  // FIXME: get rid of the registered Webserver AsyncCallbackWebHandlers
}

/**
 * @brief If no WIFI is available, fallback to create an AP on the ESP32
 * @param state boolean true (create AP) or false (don't create an AP)
 */
void WIFIMANAGER::fallbackToSoftAp(const bool state) {
  createFallbackAP = state;
}

/**
 * @brief Get the current configured fallback state
 * @return true
 * @return false
 */
bool WIFIMANAGER::getFallbackState() const {
  return createFallbackAP;
}

/**
 * @brief Remove all entries from the current known and configured Wifi list
 * @details This only affects memory, not the storage!
 * @details If you wan't to persist this, you need to call writeToNVS()
 */
void WIFIMANAGER::clearApList() {
  for(uint8_t i=0; i<WIFIMANAGER_MAX_APS; i++) {
    apList[i].apName = "";
    apList[i].apPass = "";
    apList[i].joined = false;
    apList[i].failures = 0;
  }
}

/**
 * @brief Load last saved configuration from the NVS into the memory
 * @return true on success
 * @return false on error
 */
bool WIFIMANAGER::loadFromNVS() {
  configuredSSIDs = 0;
  if (preferences.begin(NVS, true)) {
    clearApList();
    char tmpKey[10] = { 0 };
    for(uint8_t i=0; i<WIFIMANAGER_MAX_APS; i++) {
      sprintf(tmpKey, "apName%d", i);
      if (preferences.getType(tmpKey) == PT_STR) {
        String apName = preferences.getString(tmpKey, "");
        if (apName.length() > 0) {
          sprintf(tmpKey, "apPass%d", i);
          String apPass = preferences.getString(tmpKey);
          // Absent on networks saved before R-37: shown as "not joined yet"
          // until the board next connects to them.
          sprintf(tmpKey, "apOk%d", i);
          const bool joined = preferences.isKey(tmpKey) && preferences.getBool(tmpKey, false);
          logMessage(String("[WIFI] Load SSID '") + apName + "' to " + String(i+1) + ". slot.\n");
          apList[i].apName = apName;
          apList[i].apPass = apPass;
          apList[i].joined = joined;
          configuredSSIDs++;
        }
      }
    }
    lastSsid = preferences.isKey("lastAp") ? preferences.getString("lastAp", "") : String();
    preferences.end();
    return true;
  }
  logMessage("[WIFI] Unable to load data from NVS, giving up...\n");
  return false;
}

/**
 * @brief Write the current in memory configuration to the non volatile storage
 * @return true on success
 * @return false on error with the NVS
 */
bool WIFIMANAGER::writeToNVS() {
  if (!preferences.begin(NVS, false)) {
    logMessage("[WIFI] Unable to write data to NVS, giving up...");
    return false;
  }

  preferences.clear();
  char tmpKey[10];
  for(uint8_t i = 0; i < WIFIMANAGER_MAX_APS; i++) {
    if (apList[i].apName.isEmpty()) continue;

    snprintf(tmpKey, sizeof(tmpKey), "apName%d", i);
    preferences.putString(tmpKey, apList[i].apName);

    snprintf(tmpKey, sizeof(tmpKey), "apPass%d", i);
    preferences.putString(tmpKey, apList[i].apPass);

    snprintf(tmpKey, sizeof(tmpKey), "apOk%d", i);
    preferences.putBool(tmpKey, apList[i].joined);
  }
  if (lastSsid.length()) preferences.putString("lastAp", lastSsid);

  preferences.end();
  return true;
}

/**
 * @brief Add a new WIFI SSID to the known credentials list
 * @param apName Name of the SSID to connect to
 * @param apPass Password (or empty) to connect to the SSID
 * @param updateNVS Write the new entry directly to NVS
 * @return true on success
 * @return false on failure
 */
bool WIFIMANAGER::addWifi(String apName, String apPass, bool updateNVS) {
  // An SSID is up to 32 bytes; 31 used to turn away a legal name.
  if(apName.length() < 1 || apName.length() > 32) {
    logMessage("[WIFI] No SSID given or ssid too long");
    return false;
  }

  if(apPass.length() > 63) {
    logMessage("[WIFI] Passphrase too long");
    return false;
  }

  // Adding a name already saved replaces its password instead of filling a
  // second slot with a duplicate that tryConnect() could pick either way.
  for(uint8_t i=0; i<WIFIMANAGER_MAX_APS; i++) {
    if (apList[i].apName == apName) {
      logMessage(String("[WIFI] Updating the saved credentials for SSID '") + apName + "'.\n");
      apList[i].apPass = apPass;
      apList[i].joined = false;
      apList[i].failures = 0;  // a new password gets tried at once
      if (updateNVS) return writeToNVS();
      else return true;
    }
  }

  for(uint8_t i=0; i<WIFIMANAGER_MAX_APS; i++) {
    if (apList[i].apName == "") {
      logMessage(String("[WIFI] Found unused slot Nr. ") + String(i) + " to store the new SSID '" + apName + "' credentials.\n");
      apList[i].apName = apName;
      apList[i].apPass = apPass;
      apList[i].joined = false;
      apList[i].failures = 0;
      configuredSSIDs++;
      if (updateNVS) return writeToNVS();
      else return true;
    }
  }
  logMessage("[WIFI] No slot available to store SSID credentials");
  return false; // max entries reached
}

/**
 * @brief Drop a known SSID entry ID from the known list and write change to NVS
 * @param apId ID of the SSID within the array
 * @return true on success
 * @return false on error
 */
bool WIFIMANAGER::delWifi(uint8_t apId) {
  if (apId < WIFIMANAGER_MAX_APS) {
    // Without this the count only ever grew, so after a delete tryConnect()
    // could take the one-network shortcut to a slot that is now empty.
    if (apList[apId].apName.length() && configuredSSIDs > 0) configuredSSIDs--;
    apList[apId].apName.clear();
    apList[apId].apPass.clear();
    apList[apId].joined = false;
    apList[apId].failures = 0;
    return writeToNVS();
  }
  return false;
}

/**
 * @brief Drop a known SSID name from the known list and write change to NVS
 * @param apName SSID name
 * @return true on success
 * @return false on error
 */
bool WIFIMANAGER::delWifi(String apName) {
  int num = 0;
  for(uint8_t i=0; i<WIFIMANAGER_MAX_APS; i++) {
    if (apList[i].apName == apName) {
      if (delWifi(i)) num++;
    }
  }
  return num > 0;
}

/**
 * @brief Provides information about the current configuration state
 * @details When at least 1 SSID is configured, the return value will be true, otherwise false
 * @return true if one or more SSIDs stored
 * @return false if no configuration is available
 */
bool WIFIMANAGER::configAvailable() const {
    return configuredSSIDs != 0;
}

bool WIFIMANAGER::setupApOnlyLooking() const {
  return softApRunning && apKeepsLooking && WiFi.softAPgetStationNum() == 0;
}

void WIFIMANAGER::backOffOutageLook() {
  nextOutageLookMillis = millis() + outageLookMs;
  logMessage(String("[WIFI] Next look for a saved Wi-Fi in ") + String(outageLookMs / 1000) + "s\n");
  outageLookMs = min((uint32_t)(outageLookMs * 2), (uint32_t)OUTAGE_LOOK_MAX_MS);
}

/**
 * @brief Provides the apList element id of the first configured slot
 * @details It's used to speed up connection by getting the first available configuration
 * @note only call this function when you have configuredSSIDs > 0, otherwise it will return 0 as well and fail!
 * @return uint8_t apList element id
 */
uint8_t WIFIMANAGER::getApEntry() {
  for(uint8_t i=0; i<WIFIMANAGER_MAX_APS; i++) {
    if (apList[i].apName.length()) return i;
  }
  logMessage("[WIFI][ERROR] We did not find a valid entry!\n");
  logMessage("[WIFI][ERROR] Make sure to not call this function if configuredSSIDs != 1.\n");
  return 0;
}

/**
 * @brief Background loop function running inside the task
 * @details regulary check if the connection is up&running, try to reconnect or create a fallback AP
 */
// Whether this network leads to the internet at all, as phones decide it: a
// generate_204 page answers 204 with nothing in it. A hotel login page answers
// something else and a hotspot with no data answers nothing. Two providers so
// one being blocked or down is not taken for the network.
static bool internetReachable() {
  static const char *const kUrls[] = {
#ifdef INTERNET_PROBE_URL
      // Test builds only: a URL that fails, to play "no internet" on a
      // network that has it.
      INTERNET_PROBE_URL,
#else
      "http://connectivitycheck.gstatic.com/generate_204",
      "http://cp.cloudflare.com/generate_204",
#endif
  };
  for (const char *url : kUrls) {
    WiFiClient client;
    HTTPClient http;
    http.setConnectTimeout(4000);
    http.setTimeout(4000);
    if (!http.begin(client, url)) continue;
    const int code = http.GET();
    http.end();
    if (code == 204) return true;
  }
  return false;
}

void WIFIMANAGER::loop() {
  if (serverReachStatus() == NET_OK) noInternetRounds = 0;

  // On Wi-Fi but nothing from our server for a while (ServerReach.cpp). Ahead
  // of the interval check, so it happens on this pass.
  if (serverReachTakeWifiCheck()) {
    if (internetReachable()) {
      // Their Wi-Fi is fine; our server is the one gone. Nothing for a
      // parent to fix, and nothing gained by leaving a working network.
      serverReachInternetUp();
      return;
    }
    if (noInternetRounds++ == 0 && configuredSSIDs > 1) {
      // On this network but not through it: a hotspot with no data, a hotel
      // Wi-Fi behind a login page. Try another saved one this time.
      avoidSsid = WiFi.SSID();
      logMessage(String("[WIFI] No internet through '") + avoidSsid + "', trying another saved Wi-Fi\n");
      WiFi.disconnect(false, false);
      lastWifiCheckMillis = millis();
      if (tryConnect()) return;
    }
    // Nowhere left to go without a person: open Wi-Fi setup, which is what
    // the app connects to, and say so (serverReachSetupOpened() via the AP
    // event).
    logMessage("[WIFI] No internet through any saved Wi-Fi: opening Wi-Fi setup\n");
    WiFi.disconnect(false, false);
    runSoftAP();
    return;
  }

  // While the device is online but still has no token it is polling to be
  // claimed and somebody is watching the web app, so check more often.
  const uint32_t checkInterval =
      (WiFi.status() == WL_CONNECTED && authTokenGlobal.isEmpty())
          ? 3000
          : intervalWifiCheckMillis;
  // Credentials just came in from the setup portal. Connect now instead of
  // waiting out the SoftAP timeout -- tryConnect() and loop() both refuse to do
  // anything while the AP is up, which otherwise leaves the user staring at a
  // dead page for two minutes. Ahead of the interval check: the portal wakes
  // this task, and the next pass was up to 10s away (62:70, 2026-10-22).
  if (connectRequested) {
    connectRequested = false;
    lastWifiCheckMillis = millis();
    logMessage("[WIFI] New credentials saved, connecting now\n");
    delay(500);  // the portal's "added" answer leaves before the AP does
    if (softApRunning) stopSoftAP();
    tryConnect();
    return;
  }

  if (millis() - lastWifiCheckMillis < checkInterval) return;
  lastWifiCheckMillis = millis();

  // A short wait lets a reconnect the driver already started finish. The
  // default is 60s, and it waits for as long as the status reads idle or
  // disconnected, which held this task for a minute after a router went off.
  if(WiFi.waitForConnectResult(3000) == WL_CONNECTED) {
    // Check if we are connected to a well known SSID
    for(uint8_t i=0; i<WIFIMANAGER_MAX_APS; i++) {
      if (WiFi.SSID() == apList[i].apName) {
        staLostMillis = 0;
        logMessage(String("[WIFI][STATUS] Connected to known SSID: '") + WiFi.SSID() + "' with IP " + WiFi.localIP().toString() + "\n");
        noteJoined(i);
        startSessionIfReady();
        return;
      }
    }
    // looks like we are connected to something else, strange!?
    logMessage("[WIFI] We are connected to an unknown SSID ignoring. Connected to: " + WiFi.SSID() + "\n");
  } else {
    // A button press means someone wants the toy now: look straight away and
    // start the backoff again.
    if (lastActivityAt != seenActivityAt) {
      seenActivityAt = lastActivityAt;
      if (outageLookMs != OUTAGE_LOOK_MIN_MS) logMessage("[WIFI] Button pressed, looking for a saved Wi-Fi now\n");
      outageLookMs = OUTAGE_LOOK_MIN_MS;
      nextOutageLookMillis = 0;
    }
    // With nothing saved there is nothing to look for, and the setup AP must
    // come back at once after its timeout.
    const bool lookDue = !configAvailable() || (int64_t)(millis() - nextOutageLookMillis) >= 0;

    if (softApRunning) {
      const uint8_t stations = WiFi.softAPgetStationNum();
      if (!stations) apBusySinceMillis = millis();
      else {
        noteActivity();  // idle sleep counts from the phone leaving
        seenActivityAt = lastActivityAt;  // ...and it is not a button press
      }
      if (apKeepsLooking && stations == 0) {
        // Nobody is setting the toy up, so a scan and a join through the
        // station side cost nobody anything. tryConnect() closes the AP once
        // it is on a saved network.
        if (!lookDue) return;
        if (tryConnect()) return;
        backOffOutageLook();
      } else if (apKeepsLooking && millis() - apBusySinceMillis >= AP_BUSY_LOOK_MS) {
        logMessage("[WIFI] A phone has been on the setup AP for " +
                   String((uint32_t)((millis() - apBusySinceMillis) / 1000)) +
                   "s, looking for a saved Wi-Fi anyway\n");
        apBusySinceMillis = millis();
        if (tryConnect(true)) return;
      } else {
        logMessage("[WIFI] Not trying to connect to a known SSID. SoftAP has " + String(WiFi.softAPgetStationNum()) + " clients connected!\n");
      }
    } else {
      if (!staLostMillis) staLostMillis = millis();
      if (!lookDue) return;
      // let's try to connect to some WiFi in Range
      if (!tryConnect()) {
        backOffOutageLook();
        const uint64_t lostFor = millis() - staLostMillis;
        if (!createFallbackAP) {
          logMessage("[WIFI] Auto creation of SoftAP is disabled, no starting AP!\n");
        } else if (configAvailable() && lostFor < AP_GRACE_MS) {
          // As xiaozhi does: a router restarting or a moment out of range is
          // not a reason to say "正在配網". Keep trying the saved networks
          // first; setup opens only once none has answered for a minute.
          logMessage(String("[WIFI] No saved Wi-Fi yet, Wi-Fi setup opens in ") +
                     String((uint32_t)((AP_GRACE_MS - lostFor) / 1000)) + "s\n");
        } else if (runSoftAP()) {
          apKeepsLooking = configAvailable();
        }
      }
    }
  }

  // An AP that keeps looking stays up until a saved network takes the board
  // or a parent sets one up: closing it only left a gap of ~15s in which a
  // phone could not find it, and it was reopened at once (62:70, 2026-10-22).
  if (softApRunning && !apKeepsLooking && millis() - startApTimeMillis > timeoutApMillis) {
    if (WiFi.softAPgetStationNum() > 0) {
      logMessage("[WIFI] SoftAP has " + String(WiFi.softAPgetStationNum()) + " clients connected!\n");
      startApTimeMillis = millis(); // reset timeout as someone is connected
      return;
    }
    logMessage("[WIFI] Running in AP mode but timeout reached. Closing AP!\n");
    stopSoftAP();
    delay(100);
  }
}

// How long a failure reported right after WiFi.begin() is not trusted.
static const uint32_t JOIN_STALE_MS = 6000;

/**
 * Join one network and wait for the outcome. The driver keeps the previous
 * attempt's result until an event replaces it, and leaving a network we never
 * reached raises no event: straight after begin(), WiFi.status() can still say
 * "not found" about the last network. 62:70 (2026-10-15) took that as the
 * answer for the network it was going back to and fell into the setup AP. So
 * a failure only counts once this attempt has had JOIN_STALE_MS to produce
 * its own; before that, only "connected" ends the wait.
 */
static wl_status_t joinFor(const String &ssid, const String &pass, uint32_t timeoutMs,
                           int32_t channel = 0) {
  WiFi.disconnect(false, false);
  delay(100);
  // A channel from the scan just done saves the driver a second walk over
  // every channel before it joins (xiaozhi's StartConnect does the same).
  // No BSSID, so a home with two access points on one name can still roam.
  WiFi.begin(ssid.c_str(), pass.c_str(), channel);
  const uint32_t start = millis();
  wl_status_t status = WiFi.status();
  while (millis() - start < timeoutMs) {
    status = WiFi.status();
    if (status == WL_CONNECTED) break;
    if ((status == WL_NO_SSID_AVAIL || status == WL_CONNECT_FAILED) && millis() - start >= JOIN_STALE_MS) break;
    delay(100);
  }
  return status;
}

bool WIFIMANAGER::joinAllowed(uint8_t apId) const {
  return apList[apId].failures == 0 || (int32_t)(millis() - apList[apId].retryAtMillis) >= 0;
}

void WIFIMANAGER::noteJoinFailed(uint8_t apId) {
  if (apList[apId].failures < 255) apList[apId].failures++;
  const uint8_t shift = apList[apId].failures > 6 ? 5 : apList[apId].failures - 1;
  const uint32_t wait = min((uint32_t)JOIN_BACKOFF_MIN_MS << shift, (uint32_t)JOIN_BACKOFF_MAX_MS);
  apList[apId].retryAtMillis = millis() + wait;
  logMessage(String("[WIFI] '") + apList[apId].apName + "' failed " + String(apList[apId].failures) +
             " time(s) in a row, next try in " + String(wait / 1000) + "s\n");
}

void WIFIMANAGER::noteJoined(uint8_t apId) {
  apList[apId].failures = 0;
  outageLookMs = OUTAGE_LOOK_MIN_MS;
  nextOutageLookMillis = 0;
  if (!apList[apId].joined) {
    apList[apId].joined = true;
    writeToNVS();
  }
  if (lastSsid != apList[apId].apName) {
    lastSsid = apList[apId].apName;
    // A single key, not writeToNVS(): this changes far more often than the list.
    if (preferences.begin(NVS, false)) {
      preferences.putString("lastAp", lastSsid);
      preferences.end();
    }
  }
}

/**
 * @brief Try to connect to one of the configured SSIDs (if available).
 * @details If more than 2 SSIDs configured, scan for available WIFIs and connect to the strongest
 * @return true on success
 * @return false on error or no configuration
 */
bool WIFIMANAGER::tryConnect(bool evenWithPhone) {
  if (!configAvailable()) {
    logMessage("[WIFI] No SSIDs configured in NVS, unable to connect\n");
    if (createFallbackAP) runSoftAP();
    return false;
  }

  // With the AP up, only while it keeps looking and nobody is on it, or when
  // loop() decides a phone has been on it long enough (AP_BUSY_LOOK_MS): a
  // scan or a join moves the radio off the AP's channel and drops a phone
  // that is half way through setup.
  if (softApRunning && (!apKeepsLooking || (WiFi.softAPgetStationNum() > 0 && !evenWithPhone))) {
    logMessage("[WIFI] Not trying to connect. SoftAP has " + String(WiFi.softAPgetStationNum()) + " clients connected!\n");
    return false;
  }

  // Stops the driver's own reconnect loop, which otherwise keeps retrying the
  // network that went away and makes this scan fail.
  WiFi.disconnect(false, false);

  int choosenAp = INT_MIN;
  int32_t choosenChannel = 0;
  if (configuredSSIDs == 1 && !softApRunning) {
    // only one configured SSID, skip scanning and try to connect to this specific one.
    choosenAp = getApEntry();
    if (!joinAllowed(choosenAp)) return false;  // noteJoinFailed() said when
  } else {
    // With the AP up the scan comes first even for one saved network, so the
    // radio leaves the AP's channel for a join only when there is something
    // to join, and the dwell per channel stays short.
    if (!softApRunning) WiFi.mode(WIFI_STA);
    int8_t scanResult = softApRunning ? WiFi.scanNetworks(false, true, false, 120)
                                      : WiFi.scanNetworks(false, true);
    if(scanResult <= 0) {
      logMessage("[WIFI] Unable to find WIFI networks in range to this device!\n");
      return false;
    }
    logMessage(String("[WIFI] Found ") + String(scanResult) + " networks in range\n");
    int choosenRssi = INT_MIN;  // we want to select the strongest signal with the highest priority if we have multiple SSIDs available
    // The strongest one besides avoidSsid, kept apart so the avoided network
    // is still the answer when it is the only saved one in range.
    int otherAp = INT_MIN;
    int otherRssi = INT_MIN;
    int32_t otherChannel = 0;
    // The network last joined, when it is in range (LAST_AP_MIN_RSSI).
    int lastAp = INT_MIN;
    int lastRssi = INT_MIN;
    int32_t lastChannel = 0;
    uint8_t heldBack = 0;  // in range but waiting out a backoff, one bit per slot
    for(int8_t x = 0; x < scanResult; ++x) {
      String ssid;
      uint8_t encryptionType;
      int32_t rssi;
      uint8_t* bssid;
      int32_t channel;
      WiFi.getNetworkInfo(x, ssid, encryptionType, rssi, bssid, channel);
      for(uint8_t i=0; i<WIFIMANAGER_MAX_APS; i++) {
        if (apList[i].apName.length() == 0 || apList[i].apName != ssid) continue;
#ifdef WIFI_TEST_SKIP_SSID
        // Test builds only: play "this saved network is out of range" so a
        // phone hotspot switched off and on can stand in for a router restart.
        if (apList[i].apName == WIFI_TEST_SKIP_SSID) continue;
#endif

        if (encryptionType != WIFI_AUTH_OPEN && apList[i].apPass.length() == 0) continue;  // no password for it
        if (!joinAllowed(i)) {
          heldBack |= 1 << i;
          continue;
        }

        if (rssi > choosenRssi) {
          choosenAp = i;
          choosenRssi = rssi;
          choosenChannel = channel;
        } // else lower wifi signal
        if (rssi > otherRssi && apList[i].apName != avoidSsid) {
          otherAp = i;
          otherRssi = rssi;
          otherChannel = channel;
        }
        if (rssi > lastRssi && apList[i].apName == lastSsid && apList[i].apName != avoidSsid) {
          lastAp = i;
          lastRssi = rssi;
          lastChannel = channel;
        }
      }
    }
    WiFi.scanDelete();
    if (otherAp != INT_MIN && otherAp != choosenAp) {
      logMessage(String("[WIFI] Passing over '") + avoidSsid + "', which did not reach the server\n");
      choosenAp = otherAp;
      choosenChannel = otherChannel;
    }
    if (lastAp != INT_MIN && lastAp != choosenAp && lastRssi >= LAST_AP_MIN_RSSI) {
      logMessage(String("[WIFI] Staying with '") + lastSsid + "' (" + String(lastRssi) +
                 " dBm), the last network joined, over a stronger one\n");
      choosenAp = lastAp;
      choosenChannel = lastChannel;
    }
    for (uint8_t i = 0; i < WIFIMANAGER_MAX_APS; i++) {
      if (!(heldBack & (1 << i))) continue;
      logMessage(String("[WIFI] '") + apList[i].apName + "' is in range but failed last time, next try in " +
                 String((uint32_t)(apList[i].retryAtMillis - millis()) / 1000) + "s\n");
    }
  }

  if (choosenAp == INT_MIN) {
    logMessage("[WIFI] Unable to find an SSID to connect to!\n");
    return false;
  } else {
    logMessage(String("[WIFI] Trying to connect to SSID ") + apList[choosenAp].apName 
      + " with password " + (apList[choosenAp].apPass.length() > 0 ? "'***'" : "''") + "\n"
    );

    // Same 15s budget as before, without trusting a stale failure.
    wl_status_t status = joinFor(apList[choosenAp].apName, apList[choosenAp].apPass, 15000, choosenChannel);
    switch(status) {
      case WL_IDLE_STATUS:
        logMessage("[WIFI] Connecting failed (0): Idle\n");
        break;
      case WL_NO_SSID_AVAIL:
        logMessage("[WIFI] Connecting failed (1): The AP can't be found\n");
        break;
      case WL_SCAN_COMPLETED:
        logMessage("[WIFI] Connecting failed (2): Scan completed\n");
        break;
      case WL_CONNECTED: // 3
        logMessage("[WIFI] Connection successful\n");
        noteJoined(choosenAp);
        logMessage("[WIFI] SSID   : " + WiFi.SSID() + "\n");
        logMessage("[WIFI] IP     : " + WiFi.localIP().toString() + "\n");
        // Closed first: the AP was up while this join was tried from it, and
        // the session should not start in SOFT_AP.
        if (softApRunning) logMessage("[WIFI] Back on a saved network, closing the setup AP\n");
        stopSoftAP();
        connectCb();
        return true;
        break;
      case WL_CONNECT_FAILED:
        logMessage("[WIFI] Connecting failed (4): Unknown reason\n");
        break;
      case WL_CONNECTION_LOST:
        logMessage("[WIFI] Connecting failed (5): Connection lost\n");
        break;
      case WL_DISCONNECTED:
        logMessage("[WIFI] Connecting failed (6): Disconnected\n");
        break;
      case WL_NO_SHIELD:
        logMessage("[WIFI] Connecting failed (7): No Wifi shield found\n");
        break;
      default:
        logMessage("[WIFI] Connecting failed (" + String(status) + "): Unknown status code\n");
        break;
    }
    // "Not found" is the network gone, not the network refusing us.
    if (status != WL_NO_SSID_AVAIL) noteJoinFailed(choosenAp);
    // The driver retries a failed join on its own, hopping channels. With the
    // AP up that would drop the next phone to join it, so it stops here and
    // the next try comes from loop().
    if (softApRunning) WiFi.disconnect(false, false);
  }
  return false;
}

void WIFIMANAGER::configueSoftAp(String apName, String apPass) {
  this->softApName = apName;
  this->softApPass = apPass;
}



/**
 * @brief Start a SoftAP for direct client access
 * @param apName name of the AP to create (default is ESP_XXXXXXXX)
 * @return true on success
 * @return false o error or if a SoftAP already runs
 */
bool WIFIMANAGER::runSoftAP(String apName, String apPass) {
  if (apName.length()) this->softApName = apName;
  if (apPass.length()) this->softApPass = apPass;

  if (softApRunning) return true;
  startApTimeMillis = millis();
  apKeepsLooking = false;  // the caller that wants it says so

  if (this->softApName == "") this->softApName = "ESP_" + String((uint32_t)ESP.getEfuseMac());
  logMessage("[WIFI] Starting configuration portal on AP SSID " + this->softApName + "\n");

  // The station side stays on, so loop() can still find a saved network
  // while the AP is up (apKeepsLooking). Its own reconnect loop is stopped
  // first: left running, it hops channels and drops phones joining the AP.
  WiFi.disconnect(false, false);
  WiFi.mode(WIFI_AP_STA);
  bool state = WiFi.softAP(this->softApName.c_str(), (this->softApPass.length() ? this->softApPass.c_str() : NULL));
  if (state) {
    IPAddress IP = WiFi.softAPIP();
    logMessage("[WIFI] AP created. My IP is: " + String(IP) + "\n");
    return true;
  } else {
    logMessage("[WIFI] Unable to create SoftAP!\n");
    return false;
  }
}

/**
 * @brief Stop/Disconnect a current running SoftAP
 */
void WIFIMANAGER::stopSoftAP() {
  WiFi.softAPdisconnect();
  WiFi.mode(WIFI_STA);
}

/**
 * @brief Stop/Disconnect a current wifi connection
 */
void WIFIMANAGER::stopClient() {
  WiFi.disconnect();
}

/**
 * @brief Stop/Disconnect all running wifi activies and optionally kill the background task as well
 * @param killTask true to kill the background task to prevent reconnects
 */
void WIFIMANAGER::stopWifi(bool killTask) {
  if (killTask) vTaskDelete(WifiCheckTask);
  stopSoftAP();
  stopClient();
}

/**
 * @brief Attach the WebServer to the WifiManager to register the RESTful API
 * @param srv WebServer object
 */
#if ASYNC_WEBSERVER == true
void WIFIMANAGER::attachWebServer(AsyncWebServer * srv) {
#else
void WIFIMANAGER::attachWebServer(WebServer * srv) {
#endif
  webServer = srv; // store it in the class for later use

#if ASYNC_WEBSERVER == true
  // not required
#else
  // just for debugging
  webServer->onNotFound([&]() {
    String uri = WebServer::urlDecode(webServer->uri());  // required to read paths with blanks

     // Dump debug data
    String message;
    message.reserve(100);
    message = F("Error: File not found\n\nURI: ");
    message += uri;
    message += F("\nMethod: ");
    message += (webServer->method() == HTTP_GET) ? "GET" : "POST";
    message += F("\nArguments: ");
    message += webServer->args();
    message += '\n';
    for (uint8_t i = 0; i < webServer->args(); i++) {
      message += F(" NAME:");
      message += webServer->argName(i);
      message += F("\n VALUE:");
      message += webServer->arg(i);
      message += '\n';
    }
    message += "path=";
    message += webServer->arg("path");
    message += '\n';
    logMessage(message);
  });
#endif

#if ASYNC_WEBSERVER == true
  webServer->on((apiPrefix + "/softap/start").c_str(), HTTP_POST, [&](AsyncWebServerRequest * request) {
    request->send(200, "application/json", "{\"message\":\"Soft AP stopped\"}");
#else
  webServer->on((apiPrefix + "/softap/start").c_str(), HTTP_POST, [&]() {
    webServer->send(200, "application/json", "{\"message\":\"Soft AP stopped\"}");
#endif
    yield();
    delay(250);
    runSoftAP();
  });
  
#if ASYNC_WEBSERVER == true
  webServer->on((apiPrefix + "/softap/stop").c_str(), HTTP_POST, [&](AsyncWebServerRequest * request) {
    request->send(200, "application/json", "{\"message\":\"Soft AP stopped\"}");
#else
  webServer->on((apiPrefix + "/softap/stop").c_str(), HTTP_POST, [&]() {
    webServer->send(200, "application/json", "{\"message\":\"Soft AP stopped\"}");
#endif
    yield();
    delay(250); // It's likely that this message won't go trough, but we give it a short time
    stopSoftAP();
  });

#if ASYNC_WEBSERVER == true
  webServer->on((apiPrefix + "/client/stop").c_str(), HTTP_POST, [&](AsyncWebServerRequest * request) {
    request->send(200, "application/json", "{\"message\":\"Terminating current Wifi connection\"}");
#else
  webServer->on((apiPrefix + "/client/stop").c_str(), HTTP_POST, [&]() {
    webServer->send(200, "application/json", "{\"message\":\"Terminating current Wifi connection\"}");
#endif
    yield();
    delay(500); // It's likely that this message won't go trough, but we give it a short time
    stopClient();
  });

#if ASYNC_WEBSERVER == true
  webServer->on((apiPrefix + "/add").c_str(), HTTP_POST, [&](AsyncWebServerRequest * request){}, NULL,
    [&](AsyncWebServerRequest * request, uint8_t *data, size_t len, size_t index, size_t total) {
    JsonDocument jsonBuffer;
    deserializeJson(jsonBuffer, (const char*)data);
    auto resp = request;
#else
  webServer->on((apiPrefix + "/add").c_str(), HTTP_POST, [&]() {
    if (webServer->args() != 1) {
      webServer->send(400, "application/json", "{\"message\":\"Bad Request. Only accepting one json body in request!\"}");
    }
    JsonDocument jsonBuffer;
    deserializeJson(jsonBuffer, webServer->arg(0));
    auto resp = webServer;
#endif
    if (!jsonBuffer["apName"].is<String>() || !jsonBuffer["apPass"].is<String>()) {
      resp->send(422, "application/json", "{\"message\":\"Invalid data\"}");
      return;
    }
    if (!addWifi(jsonBuffer["apName"].as<String>(), jsonBuffer["apPass"].as<String>())) {
      resp->send(500, "application/json", "{\"message\":\"Unable to process data\"}");
    } else {
      connectRequested = true;
      resp->send(200, "application/json", "{\"message\":\"New network added\"}");
      if (WifiCheckTask) xTaskNotifyGive(WifiCheckTask);
    }
  });

#if ASYNC_WEBSERVER == true
  webServer->on((apiPrefix + "/id").c_str(), HTTP_DELETE, [&](AsyncWebServerRequest * request){}, NULL,
    [&](AsyncWebServerRequest * request, uint8_t *data, size_t len, size_t index, size_t total) {
    JsonDocument jsonBuffer;
    deserializeJson(jsonBuffer, (const char*)data);
    auto resp = request;
#else
  webServer->on((apiPrefix + "/id").c_str(), HTTP_DELETE, [&]() {
    if (webServer->args() != 1) {
      webServer->send(400, "application/json", "{\"message\":\"Bad Request. Only accepting one json body in request!\"}");
    }
    JsonDocument jsonBuffer;
    deserializeJson(jsonBuffer, webServer->arg(0));
    auto resp = webServer;
#endif
    int idValue = jsonBuffer["id"].as<String>().toInt();
    if (idValue < 0 || idValue >= WIFIMANAGER_MAX_APS) {
      resp->send(422, "application/json", "{\"message\":\"Invalid data\"}");
      return;
    }
    if (!delWifi(jsonBuffer["id"].as<uint8_t>())) {
      resp->send(500, "application/json", "{\"message\":\"Unable to delete entry\"}");
    } else resp->send(200, "application/json", "{\"message\":\"AP deleted\"}");
  });

#if ASYNC_WEBSERVER == true
  webServer->on((apiPrefix + "/apName").c_str(), HTTP_DELETE, [&](AsyncWebServerRequest * request){}, NULL,
    [&](AsyncWebServerRequest * request, uint8_t *data, size_t len, size_t index, size_t total) {
    JsonDocument jsonBuffer;
    deserializeJson(jsonBuffer, (const char*)data);
    auto resp = request;
#else
  webServer->on((apiPrefix + "/apName").c_str(), HTTP_DELETE, [&]() {
    if (webServer->args() != 1) {
      webServer->send(400, "application/json", "{\"message\":\"Bad Request. Only accepting one json body in request!\"}");
    }
    JsonDocument jsonBuffer;
    deserializeJson(jsonBuffer, webServer->arg(0));
    auto resp = webServer;
#endif
    if (!jsonBuffer["apName"].is<String>()) {
      resp->send(422, "application/json", "{\"message\":\"Invalid data\"}");
      return;
    }
    if (!delWifi(jsonBuffer["apName"].as<String>())) {
      resp->send(500, "application/json", "{\"message\":\"Unable to delete entry\"}");
    } else resp->send(200, "application/json", "{\"message\":\"AP deleted\"}");
  });

#if ASYNC_WEBSERVER == true
  webServer->on((apiPrefix + "/configlist").c_str(), HTTP_GET, [&](AsyncWebServerRequest *request) {
    AsyncResponseStream *response = request->beginResponseStream("application/json");
#else
  webServer->on((apiPrefix + "/configlist").c_str(), HTTP_GET, [&]() {
    String buffer;
#endif
    JsonDocument jsonDoc;
    auto jsonArray = jsonDoc.to<JsonArray>();
    for(uint8_t i=0; i<WIFIMANAGER_MAX_APS; i++) {
      if (apList[i].apName.length() > 0) {
        JsonObject wifiNet = jsonArray.createNestedObject();
        wifiNet["id"] = i;
        wifiNet["apName"] = apList[i].apName;
        wifiNet["apPass"] = apList[i].apPass.length() > 0 ? true : false;
      }
    }
#if ASYNC_WEBSERVER == true
    serializeJson(jsonArray, *response);
    response->setCode(200);
    response->setContentLength(measureJson(jsonDoc));
    request->send(response);
#else
    // Improve me: not that efficient without the stream response
    serializeJson(jsonArray, buffer);
    webServer->send(200, "application/json", (buffer.equals("null") ? "{}" : buffer));
#endif
  });

#if ASYNC_WEBSERVER == true
  webServer->on((apiPrefix + "/scan").c_str(), HTTP_GET, [&](AsyncWebServerRequest *request) {
    AsyncResponseStream *response = request->beginResponseStream("application/json");
#else
  webServer->on((apiPrefix + "/scan").c_str(), HTTP_GET, [&]() {
    String buffer;
#endif
    JsonDocument jsonDoc;

    int scanResult;
    String ssid;
    uint8_t encryptionType;
    int32_t rssi;
    uint8_t* bssid;
    int32_t channel;

    scanResult = WiFi.scanComplete();
    if (scanResult == WIFI_SCAN_FAILED) {
      scanResult = WiFi.scanNetworks(true, true);   // FIXME: scanNetworks is disconnecting clients!
      jsonDoc["status"] = "scanning";
    } else if (scanResult > 0) {
      for (int8_t i = 0; i < scanResult; i++) {
        WiFi.getNetworkInfo(i, ssid, encryptionType, rssi, bssid, channel);

        JsonObject wifiNet = jsonDoc.createNestedObject();
        wifiNet["ssid"] = ssid;
        wifiNet["encryptionType"] = encryptionType;
        wifiNet["rssi"] = rssi;
        wifiNet["channel"] = channel;
        yield();
      }
      WiFi.scanDelete();
    }
#if ASYNC_WEBSERVER == true
    serializeJson(jsonDoc, *response);
    response->setCode(200);
    response->setContentLength(measureJson(jsonDoc));
    request->send(response);
#else
    // Improve me: not that efficient without the stream response
    serializeJson(jsonDoc, buffer);
    webServer->send(200, "application/json", buffer);
#endif
  });

#if ASYNC_WEBSERVER == true
  webServer->on((apiPrefix + "/status").c_str(), HTTP_GET, [&](AsyncWebServerRequest *request) {
    AsyncResponseStream *response = request->beginResponseStream("application/json");
#else
  webServer->on((apiPrefix + "/status").c_str(), HTTP_GET, [&]() {
    String buffer;
#endif
    JsonDocument jsonDoc;

    jsonDoc["ssid"] = WiFi.SSID();
    jsonDoc["signalStrengh"] = WiFi.RSSI();

    jsonDoc["ip"] = WiFi.localIP().toString();
    jsonDoc["gw"] = WiFi.gatewayIP().toString();
    jsonDoc["nm"] = WiFi.subnetMask().toString();

    jsonDoc["hostname"] = WiFi.getHostname();

    jsonDoc["chipModel"] = ESP.getChipModel();
    jsonDoc["chipRevision"] = ESP.getChipRevision();
    jsonDoc["chipCores"] = ESP.getChipCores();

    jsonDoc["getHeapSize"] = ESP.getHeapSize();
    jsonDoc["freeHeap"] = ESP.getFreeHeap();

#if ASYNC_WEBSERVER == true
    serializeJson(jsonDoc, *response);
    response->setCode(200);
    response->setContentLength(measureJson(jsonDoc));
    request->send(response);
#else
    // Improve me: not that efficient without the stream response
    serializeJson(jsonDoc, buffer);
    webServer->send(200, "application/json", buffer);
#endif
  });
}

/**
 * @brief Attach the WebServer to the WifiManager to register the RESTful API
 * @param srv WebServer object
 */
void WIFIMANAGER::attachUI() {

#if ASYNC_WEBSERVER == true
  webServer->on((uiPrefix).c_str(), HTTP_GET, [](AsyncWebServerRequest* request) {
#else
  webServer->on((uiPrefix).c_str(), HTTP_GET, [&]() {
#endif

    String html = R"html(
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Buddy</title>
    <style>
        :root {
            --primary-color: #2563eb;
            --bg-color: #f8fafc;
            --card-bg: #ffffff;
            --text-color: #1e293b;
            --border-color: #e2e8f0;
        }

        body {
            font-family: system-ui, -apple-system, sans-serif;
            background: var(--bg-color);
            color: var(--text-color);
            margin: 0;
            padding: 16px;
            line-height: 1.5;
        }

        .container {
            max-width: 600px;
            margin: 0 auto;
        }

        .card {
            background: var(--card-bg);
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 16px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            border: 1px solid var(--border-color);
        }

        h1, h2 {
            margin: 0 0 16px 0;
            color: var(--text-color);
        }

        .network-list {
            list-style: none;
            padding: 0;
            margin: 0;
        }

        .network-item {
            display: flex;
            align-items: center;
            padding: 12px;
            border-bottom: 1px solid var(--border-color);
            cursor: pointer;
            transition: background-color 0.2s;
        }

        .network-item:last-child {
            border-bottom: none;
        }

        .network-item:hover {
            background-color: var(--bg-color);
        }

        .network-info {
            flex-grow: 1;
        }

        .network-info div {
          float: left;
          width: 70%;
        }

        .network-info button {
          float: right;
          width: 30%;
        }

        .ssid {
            font-weight: 500;
            margin-bottom: 4px;
        }

        .signal {
            font-size: 0.875rem;
            color: #64748b;
        }

        button {
            background: var(--primary-color);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.875rem;
            transition: opacity 0.2s;
        }

        button:hover {
            opacity: 0.9;
        }

        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .status {
            padding: 8px;
            border-radius: 4px;
            margin-bottom: 16px;
            display: none;
        }

        .status.error {
            background: #fee2e2;
            color: #991b1b;
            display: block;
        }

        .status.success {
            background: #dcfce7;
            color: #166534;
            display: block;
        }

        .status.info {
            background: #e0f2fe;
            color: #075985;
            display: block;
        }

        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.5);
            align-items: center;
            justify-content: center;
        }

        .modal-content {
            background: var(--card-bg);
            padding: 24px;
            border-radius: 8px;
            width: 90%;
            max-width: 400px;
        }

        input {
            width: 100%;
            padding: 8px;
            margin: 8px 0 16px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            box-sizing: border-box;
            font-size: 16px;
        }

        .button-group {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
        }

        .button-secondary {
            background: var(--bg-color);
            color: var(--text-color);
            border: 1px solid var(--border-color);
        }

        .saved-networks {
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid var(--border-color);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="card">
            <h1>AI Buddy</h1>
            <div id="status"></div>
            <button onclick="scanNetworks()">Scan for Networks</button>
            <button onclick="showConnectModal()">Manual Connect</button>
        </div>

        <div class="card">
            <h2>✅ Saved Networks</h2>
            <div id="savedNetworks" class="network-list"></div>
        </div>

        <div class="card">
            <h2>🛜 Available Networks</h2>
            <div id="networkList" class="network-list"></div>
        </div>
    </div>

    <div id="connectModal" class="modal">
        <div class="modal-content">
            <h2>Connect to Network</h2>
            <form id="connectForm" onsubmit="connectToNetwork(event)">
                <label for="apName">Network Name:</label>
                <input type="text" id="apName" required>
                
                <label for="apPass">Password:</label>
                <input type="password" id="apPass" required>
                
                <div class="button-group">
                    <button type="button" class="button-secondary" onclick="closeModal()">Cancel</button>
                    <button type="submit">Connect</button>
                </div>
            </form>
        </div>
    </div>

    <script>
        const API_BASE = '/api';
        let networks = {};

        // Load saved networks when page loads
        window.addEventListener('load', () => {
            loadSavedNetworks();
            scanNetworks();
        });

        async function loadSavedNetworks() {
            try {
                const response = await fetch(`${API_BASE}/wifi/configlist`);
                if (!response.ok) throw new Error('Failed to fetch saved networks');
                
                const savedNetworks = await response.json();
                displaySavedNetworks(savedNetworks);
            } catch (error) {
                showStatus('Failed to load saved networks: ' + error.message, 'error');
            }
        }

        function displaySavedNetworks(networks) {
            const networkList = document.getElementById('savedNetworks');
            const networkArray = Object.values(networks);
            
            if (networkArray.length === 0) {
                networkList.innerHTML = '<div class="network-item">No saved networks</div>';
                return;
            }

            networkList.innerHTML = networkArray.map(network => `
                <div class="network-item">
                    <div class="network-info">
                        <div class="ssid">${network.apName}</div>
                        <button onclick="deleteNetwork('${network.id}')">🗑️ Remove</button>
                    </div>
                </div>
            `).join('');
        }

        async function scanNetworks() {
            try {
                showStatus('Scanning for networks...', 'info');
                // /wifi/scan answers {"status":"scanning"} until the radio is
                // done, then the array. There is no separate results route.
                let scanned = null;
                for (let attempt = 0; attempt < 10; attempt++) {
                    const response = await fetch(`${API_BASE}/wifi/scan`);
                    if (!response.ok) throw new Error('Network scan failed');
                    const payload = await response.json();
                    if (Array.isArray(payload)) { scanned = payload; break; }
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
                if (!scanned) throw new Error('Scan timed out, try again');

                networks = scanned;
                displayNetworks(networks);
                showStatus('Networks found', 'success');
            } catch (error) {
                showStatus(error.message, 'error');
            }
        }

        function displayNetworks(networks) {
            const networkList = document.getElementById('networkList');
            const networkArray = Object.values(networks || {})
              .filter(network => network && network.ssid && network.ssid.length > 0);
            
            if (networkArray.length === 0) {
                networkList.innerHTML = '<div class="network-item">No networks found</div>';
                return;
            }

            // Sort networks by RSSI
            networkArray.sort((a, b) => b.rssi - a.rssi);

            networkList.innerHTML = networkArray
                .map(network => `
                    <div class="network-item" onclick="showConnectModal('${network.ssid}')">
                        <div class="network-info">
                            <div class="ssid">${network.ssid}</div>
                            <div class="signal">
                                Signal: ${getSignalStrength(network.rssi)}
                                ${network.encryptionType > 0 ? '🔒' : ''}
                            </div>
                        </div>
                    </div>
                `).join('');
        }

        function getSignalStrength(rssi) {
            if (rssi >= -50) return 'Excellent';
            if (rssi >= -60) return 'Very Good';
            if (rssi >= -70) return 'Good';
            if (rssi >= -80) return 'Fair';
            return 'Poor';
        }

        function showConnectModal(apName = '') {
            document.getElementById('apName').value = apName;
            document.getElementById('apName').readOnly = !!apName;
            document.getElementById('apPass').value = '';
            document.getElementById('connectModal').style.display = 'flex';
        }

        function closeModal() {
            document.getElementById('connectModal').style.display = 'none';
        }

        async function deleteNetwork(deleteId) {
            try {
                const response = await fetch(`${API_BASE}/wifi/id`, {
                    method: 'DELETE',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ id: deleteId }),
                });
                
                if (!response.ok) throw new Error(JSON.stringify(response));
                
                showStatus('Network deleted successfully', 'success');
                await loadSavedNetworks(); // Refresh the list
            } catch (error) {
                showStatus('Failed to delete network: ' + error.message, 'error');
            }
        }

        async function connectToNetwork(event) {
            event.preventDefault();
            const apName = document.getElementById('apName').value;
            const apPass = document.getElementById('apPass').value;

            try {
                showStatus('Connecting to network...', 'info');
                const response = await fetch(`${API_BASE}/wifi/add`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ apName, apPass }),
                });

                if (!response.ok) throw new Error('Connection failed');

                closeModal();
                showStatus('Successfully connected!', 'success');
                
                // Refresh saved networks list
                await loadSavedNetworks();
            } catch (error) {
                showStatus(error.message, 'error');
            }
        }

        function showStatus(message, type) {
            const statusElement = document.getElementById('status');
            statusElement.innerHTML = message;
            statusElement.className = `status ${type}`;
        }
    </script>
</body>
</html>
)html";

#if ASYNC_WEBSERVER == true
    request->send(200, "text/html", html);
#else
    webServer->send(200, "text/html", html);
#endif

  });
}
// ── Remote Wi-Fi management (R-37) ─────────────────────────────────────────
// The web app's Network page reaches the board through the voice server and
// this websocket: webSocketEvent() queues the request here, the Wi-Fi task
// does it in serviceRemote() and answers. One request at a time is plenty for
// a parent tapping a page, and keeps the password in exactly one place.

extern WIFIMANAGER WifiManager;

enum WifiRemoteOp : uint8_t { WIFI_OP_NONE, WIFI_OP_STATUS, WIFI_OP_ADD, WIFI_OP_DELETE, WIFI_OP_SCAN, WIFI_OP_SWITCH };

static portMUX_TYPE remoteMux = portMUX_INITIALIZER_UNLOCKED;
static WifiRemoteOp remoteOp = WIFI_OP_NONE;
static char remoteId[24];
static char remoteSsid[33];
static char remotePass[64];

// Zero rather than just clear: the buffer is static and would otherwise hold
// the last password until the next request overwrote it.
static void wipeRemote() {
  memset(remotePass, 0, sizeof(remotePass));
  memset(remoteSsid, 0, sizeof(remoteSsid));
  memset(remoteId, 0, sizeof(remoteId));
}

bool wifiRemoteEnqueue(const char *op, const char *id, const char *ssid, const char *pass) {
  WifiRemoteOp parsed = WIFI_OP_NONE;
  if (strcmp(op, "status") == 0) parsed = WIFI_OP_STATUS;
  else if (strcmp(op, "add") == 0) parsed = WIFI_OP_ADD;
  else if (strcmp(op, "delete") == 0) parsed = WIFI_OP_DELETE;
  else if (strcmp(op, "scan") == 0) parsed = WIFI_OP_SCAN;
  else if (strcmp(op, "switch") == 0) parsed = WIFI_OP_SWITCH;
  if (parsed == WIFI_OP_NONE) return false;

  bool queued = false;
  taskENTER_CRITICAL(&remoteMux);
  if (remoteOp == WIFI_OP_NONE) {
    strlcpy(remoteId, id ? id : "", sizeof(remoteId));
    strlcpy(remoteSsid, ssid ? ssid : "", sizeof(remoteSsid));
    strlcpy(remotePass, pass ? pass : "", sizeof(remotePass));
    remoteOp = parsed;
    queued = true;
  }
  taskEXIT_CRITICAL(&remoteMux);

  if (queued && WifiManager.WifiCheckTask) {
    xTaskNotifyGive(WifiManager.WifiCheckTask);
  }
  return queued;
}

// How a parent's last "switch" ended. The socket drops while the board moves,
// so the answer cannot go back on the request; it rides on the next report
// instead (the one sent after every "auth"), once. Wi-Fi task only.
static struct {
  bool pending = false;
  bool ok = false;
  char ssid[33] = "";
  char error[16] = "";
  char back[33] = "";
} lastSwitch;

// The new network has this long to connect; the old one gets SWITCH_BACK_MS.
static const uint32_t SWITCH_TIMEOUT_MS = 20000;
static const uint32_t SWITCH_BACK_MS = 15000;

// Joined is not enough: a hotspot with no data, or a network that blocks our
// server, would strand the board out of the parent's reach. A plain TCP
// connect to the backend proves DNS and a route without a TLS session, which
// the C3 has no room for next to a reconnecting websocket.
static bool backendReachable() {
#if defined(DEV_MODE) || defined(LOCAL_BACKEND_HOST)
  const uint16_t port = backend_port;
#else
  const uint16_t port = 443;
#endif
  WiFiClient probe;
  const bool ok = probe.connect(backend_server, port, 5000);
  probe.stop();
  return ok;
}


void WIFIMANAGER::switchNetwork(uint8_t apId, const String &previous) {
  const String target = apList[apId].apName;
  logMessage(String("[WIFI] Switching to SSID '") + target + "' from the web app\n");
  // The answer saying "switching" has to leave before the radio does.
  delay(300);

  const wl_status_t status = joinFor(target, apList[apId].apPass, SWITCH_TIMEOUT_MS);
  const char *error = nullptr;
  if (status == WL_NO_SSID_AVAIL) error = "not_found";
  else if (status == WL_CONNECT_FAILED) error = "auth";
  else if (status != WL_CONNECTED) error = "timeout";
  else if (!backendReachable()) error = "no_internet";

  lastSwitch.pending = true;
  lastSwitch.ok = error == nullptr;
  strlcpy(lastSwitch.ssid, target.c_str(), sizeof(lastSwitch.ssid));
  strlcpy(lastSwitch.error, error ? error : "", sizeof(lastSwitch.error));
  lastSwitch.back[0] = 0;

  if (!error) {
    noteJoined(apId);  // also the last network, so the parent's pick outlasts a restart
    logMessage(String("[WIFI] Switched to '") + target + "' with IP " + WiFi.localIP().toString() + "\n");
    return;
  }

  logMessage(String("[WIFI] Switch to '") + target + "' failed (" + error + "), going back\n");
  for (uint8_t i = 0; i < WIFIMANAGER_MAX_APS; i++) {
    if (previous.isEmpty() || apList[i].apName != previous) continue;
    if (joinFor(previous, apList[i].apPass, SWITCH_BACK_MS) == WL_CONNECTED) {
      strlcpy(lastSwitch.back, previous.c_str(), sizeof(lastSwitch.back));
      logMessage(String("[WIFI] Back on '") + previous + "'\n");
      return;
    }
    break;
  }
  // Not even the old one: loop() takes over and picks the strongest saved
  // network, as it would after any dropout.
  logMessage("[WIFI] Could not go back either; reconnecting as usual\n");
  WiFi.disconnect(false, false);
}

void WIFIMANAGER::serviceRemote() {
  WifiRemoteOp op;
  char id[sizeof(remoteId)];
  char ssid[sizeof(remoteSsid)];
  String pass;
  taskENTER_CRITICAL(&remoteMux);
  op = remoteOp;
  if (op != WIFI_OP_NONE) {
    memcpy(id, remoteId, sizeof(id));
    memcpy(ssid, remoteSsid, sizeof(ssid));
  }
  taskEXIT_CRITICAL(&remoteMux);
  if (op == WIFI_OP_NONE) return;
  // Copied out of the critical section: String allocates, which must not
  // happen with interrupts off.
  pass = remotePass;

  const bool connected = WiFi.status() == WL_CONNECTED;
  const String current = connected ? WiFi.SSID() : String();

  JsonDocument doc;
  doc["type"] = id[0] ? "wifi_result" : "wifi_status";
  if (id[0]) doc["id"] = id;
  bool ok = true;
  const char *error = nullptr;
  int switchTo = -1;

  switch (op) {
    case WIFI_OP_ADD: {
      // Saved only: the board stays on the network it is on, and moves to this
      // one when that one disappears (tryConnect() picks the strongest).
      bool known = false;
      for (uint8_t i = 0; i < WIFIMANAGER_MAX_APS; i++) {
        if (apList[i].apName == ssid) known = true;
      }
      if (!known && configuredSSIDs >= WIFIMANAGER_MAX_APS) {
        ok = false; error = "full";
      } else if (connected && current == ssid) {
        // Re-saving the network it is on with a new password would only be
        // tested the next time it reconnects; a typo would strand the board.
        ok = false; error = "current";
      } else if (!addWifi(ssid, pass)) {
        ok = false; error = "invalid";
      } else {
        logMessage(String("[WIFI] Saved SSID '") + ssid + "' from the web app\n");
      }
      break;
    }
    case WIFI_OP_DELETE:
      if (connected && current == ssid) {
        ok = false; error = "current";
      } else if (!delWifi(String(ssid))) {
        ok = false; error = "unknown";
      } else {
        logMessage(String("[WIFI] Forgot SSID '") + ssid + "' from the web app\n");
      }
      break;
    case WIFI_OP_SCAN: {
      // Blocks this task for a few seconds; the voice socket runs on another
      // task and keeps going, though the radio is shared.
      const int16_t found = WiFi.scanNetworks(false, false);
      JsonArray networks = doc["networks"].to<JsonArray>();
      for (int16_t i = 0; i < found && networks.size() < 20; i++) {
        String name = WiFi.SSID(i);
        if (name.isEmpty()) continue;
        bool duplicate = false;
        for (JsonObject seen : networks) {
          if (name == seen["ssid"].as<const char *>()) { duplicate = true; break; }
        }
        if (duplicate) continue;   // results come strongest first
        JsonObject network = networks.add<JsonObject>();
        network["ssid"] = name;
        network["rssi"] = WiFi.RSSI(i);
        network["secure"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
      }
      WiFi.scanDelete();
      if (found < 0) { ok = false; error = "scan"; }
      break;
    }
    case WIFI_OP_SWITCH:
      for (uint8_t i = 0; i < WIFIMANAGER_MAX_APS; i++) {
        if (!apList[i].apName.isEmpty() && apList[i].apName == ssid) switchTo = i;
      }
      if (switchTo < 0) {
        ok = false; error = "unknown";
      } else if (connected && current == ssid) {
        ok = false; error = "current";
        switchTo = -1;
      } else {
        // Done after the answer goes out (below): moving takes the socket down.
        doc["switching"] = true;
      }
      break;
    case WIFI_OP_STATUS:
    default:
      break;
  }

  if (pass.length()) memset((void *)pass.c_str(), 0, pass.length());
  pass = String();
  taskENTER_CRITICAL(&remoteMux);
  wipeRemote();
  remoteOp = WIFI_OP_NONE;
  taskEXIT_CRITICAL(&remoteMux);

  doc["ok"] = ok;
  if (error) doc["error"] = error;
  if (connected) {
    doc["current"]["ssid"] = current;
    doc["current"]["rssi"] = WiFi.RSSI();
  } else {
    doc["current"] = nullptr;
  }
  JsonArray saved = doc["saved"].to<JsonArray>();
  for (uint8_t i = 0; i < WIFIMANAGER_MAX_APS; i++) {
    if (apList[i].apName.isEmpty()) continue;
    JsonObject entry = saved.add<JsonObject>();
    entry["ssid"] = apList[i].apName;
    entry["joined"] = apList[i].joined;
  }
  doc["max"] = WIFIMANAGER_MAX_APS;
  const bool reportingSwitch = lastSwitch.pending;
  if (reportingSwitch) {
    JsonObject result = doc["last_switch"].to<JsonObject>();
    result["ssid"] = lastSwitch.ssid;
    result["ok"] = lastSwitch.ok;
    if (!lastSwitch.ok) {
      result["error"] = lastSwitch.error;
      if (lastSwitch.back[0]) result["back"] = lastSwitch.back;
    }
  }

  String out;
  serializeJson(doc, out);
  bool sent = false;
  xSemaphoreTake(wsMutex, portMAX_DELAY);
  if (webSocket.isConnected()) sent = webSocket.sendTXT(out);
  xSemaphoreGive(wsMutex);
  if (sent && reportingSwitch) lastSwitch.pending = false;

  if (switchTo >= 0) switchNetwork(switchTo, current);
}

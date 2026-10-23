/**
 * Wifi Manager
 * (c) 2022-2025 Martin Verges
 *
 * Licensed under CC BY-NC-SA 4.0
 * (Attribution-NonCommercial-ShareAlike 4.0 International)
**/
#ifndef WIFIMANAGER_h
#define WIFIMANAGER_h

#ifndef WIFIMANAGER_MAX_APS
// R-37: room for home, a phone hotspot and a few relatives'. NVS keys are
// apName0..7, so going past 10 would need a new key scheme.
#define WIFIMANAGER_MAX_APS 8   // Valid range is uint8_t
#endif

// How long saved networks are tried, at boot or after a drop, before the
// setup AP opens. xiaozhi's CONNECT_TIMEOUT_SEC is the same minute.
#ifndef AP_GRACE_MS
#define AP_GRACE_MS 60000
#endif

// A saved network that is in range but will not take the board (a changed
// password, a router still starting) is tried again after this long, doubling
// with each failure up to the cap. Without it the setup AP followed the radio
// to that network's channel every few seconds and a parent's phone could not
// stay on it. RAM only, cleared by a success or a new password.
#ifndef JOIN_BACKOFF_MIN_MS
#define JOIN_BACKOFF_MIN_MS 15000
#endif
#ifndef JOIN_BACKOFF_MAX_MS
#define JOIN_BACKOFF_MAX_MS 300000
#endif

// How often a board off every saved network looks for one again. The wait
// doubles from MIN to MAX after each look that finds nothing to join, as
// xiaozhi's scan timer does, and starts again at MIN on a join or a button
// press. Without it a toy left on through a long outage kept its radio
// scanning every ~13s until the battery was flat.
#ifndef OUTAGE_LOOK_MIN_MS
#define OUTAGE_LOOK_MIN_MS 10000
#endif
#ifndef OUTAGE_LOOK_MAX_MS
#define OUTAGE_LOOK_MAX_MS 300000
#endif

// With a phone on the setup AP the board stops looking for saved networks, so
// the phone is not dropped mid-setup -- but only for this long at a time: a
// phone that rejoined the open AP on its own would otherwise keep the toy off
// a network that came back.
#ifndef AP_BUSY_LOOK_MS
#define AP_BUSY_LOOK_MS 120000
#endif

// The network the board was last on wins over a stronger saved one as long as
// its signal is at least this good (dBm), so a phone hotspot carried past the
// toy does not pull it off the home Wi-Fi at the next connect.
#ifndef LAST_AP_MIN_RSSI
#define LAST_AP_MIN_RSSI -70
#endif

#ifndef ASYNC_WEBSERVER
  #define ASYNC_WEBSERVER true
#endif

#include <Arduino.h>
#include <Preferences.h>
#if ASYNC_WEBSERVER == true
  #include <ESPAsyncWebServer.h>
#else
  #include <WebServer.h>
#endif
#include <Audio.h>

void wifiTask(void* param);

// Callback for when the device connects to Wifi
void connectCb();

// R-37: Wi-Fi management asked for over the voice websocket. Called from
// webSocketEvent (networkTask); the work happens on the Wi-Fi task, which
// answers with {"type":"wifi_result"}. op is "status", "add", "delete" or
// "scan"; an empty id asks for an unprompted {"type":"wifi_status"}. Returns
// false when a request is already waiting, so the caller can say "busy".
bool wifiRemoteEnqueue(const char *op, const char *id, const char *ssid, const char *pass);


class WIFIMANAGER {
  protected:
#if ASYNC_WEBSERVER == true
    AsyncWebServer * webServer;         // The Webserver to register routes on
#else
    WebServer * webServer;              // The Webserver to register routes on
#endif
    bool webServerListening = false;    // Only while the setup AP is up (runSoftAP())
    bool webServerStarted = false;      // Ever this boot: AsyncTCP's task stays from then on
    String apiPrefix = "/api/wifi";     // Prefix for all IP endpionts
    String uiPrefix = "/wifi";          // Prefix for all UI endpionts

    Preferences preferences;            // Used to store AP credentials to NVS
    char* NVS;                         // Name used for NVS preferences

    struct apCredentials_t {
      String apName;                    // Name of the AP SSID
      String apPass;                    // Password if required to the AP
      bool joined = false;              // Connected successfully at least once (R-37)
      uint8_t failures = 0;             // Joins failed in a row while in range (RAM only)
      uint32_t retryAtMillis = 0;       // No new try before this, once failures > 0
    };
    apCredentials_t apList[WIFIMANAGER_MAX_APS];  // Stored AP list

    uint8_t configuredSSIDs = 0;        // Number of stored SSIDs in the NVS
    String lastSsid;                    // The network last joined, kept in NVS as "lastAp"

    bool softApRunning = false;         // Due to lack of functions, we have to remember if the AP is already running...
    // A saved network that let the board on but not through to our server
    // (P2-25). tryConnect() passes it over while another saved one is in
    // range. RAM only: a restart gives every network another chance.
    String avoidSsid;
    // Internet checks that failed in this outage (P2-25): the first moves to
    // another saved network, the next opens Wi-Fi setup.
    uint8_t noInternetRounds = 0;
    // The SoftAP opened because no saved network could be joined (a router
    // restarting, the toy carried out of range), not because one had no
    // internet. While nobody is on the AP, loop() keeps trying the saved
    // networks through the station side instead of waiting out the timeout.
    bool apKeepsLooking = false;
    // When the station side was found off every saved network; 0 while on
    // one. Setup opens only after AP_GRACE_MS of that.
    uint64_t staLostMillis = 0;
    // Since when a phone has been on the setup AP without a look for a saved
    // network (AP_BUSY_LOOK_MS).
    uint64_t apBusySinceMillis = 0;
    // OUTAGE_LOOK_MIN_MS backoff, and the button press it last reset on.
    uint32_t outageLookMs = OUTAGE_LOOK_MIN_MS;
    uint64_t nextOutageLookMillis = 0;
    unsigned long seenActivityAt = 0;

    // A failed look in an outage: the next one waits twice as long.
    void backOffOutageLook();
    bool createFallbackAP = true;       // Create an AP for configuration if no other connection is available

    uint64_t lastWifiCheckMillis = 0;   // Time of last Wifi health check
    uint32_t intervalWifiCheckMillis = 10000; // Interval of the Wifi health checks
    uint64_t startApTimeMillis = 0;     // Time when the AP was started
    uint32_t timeoutApMillis = 120000;  // Timeout of an AP when no client is connected, if timeout reached rescan, tryconnect or createAP

    String softApName;                  // Name of the soft AP if created, default to ESP_XXXXXXXX if empty
    String softApPass;                  // Password for the soft AP, default to no password (empty)

    // Wipe the apList credentials
    void clearApList();

    // Get id of the first non empty entry
    uint8_t getApEntry();

    // Join backoff (JOIN_BACKOFF_MIN_MS) and the last network joined.
    bool joinAllowed(uint8_t apId) const;
    void noteJoinFailed(uint8_t apId);
    void noteJoined(uint8_t apId);
    
    // Print a log message to Serial, can be overwritten
    virtual void logMessage(String msg);

  public:
    // We let the loop run as as Task
    TaskHandle_t WifiCheckTask;

    WIFIMANAGER(const char * ns = "wifimanager");
    virtual ~WIFIMANAGER();

    // If no known Wifi can't be found, create an AP but retry regulary
    void fallbackToSoftAp(bool state = true);

    // Get the current fallback state
    bool getFallbackState() const;

    // Call to run the Task in the background
    void startBackgroundTask(String apName = "", String apPass = "");

    // Attach a webserver and register api routes
#if ASYNC_WEBSERVER == true
    void attachWebServer(AsyncWebServer * srv);
#else
    void attachWebServer(WebServer * srv);
#endif
    // Attach an UI
    void attachUI();

    // Add another AP to the list of known WIFIs
    bool addWifi(String apName, String apPass, bool updateNVS = true);

    // Delete Wifi from apList by ID
    bool delWifi(uint8_t apId);

    // Delete Wifi from apList by Name
    bool delWifi(String apName);

    // Try each known SSID and connect until none is left or one is connected.
    // evenWithPhone: look while a phone is on the setup AP (AP_BUSY_LOOK_MS).
    bool tryConnect(bool evenWithPhone = false);

    // Check if a SSID is stored in the config
    bool configAvailable() const;

    // The setup AP is up only to look for a saved network and nobody is on it,
    // so idle sleep may take the toy (main.cpp checkIdleTimeout()).
    bool setupApOnlyLooking() const;

    // Preconfigure the SoftAP
    void configueSoftAp(String apName = "", String apPass = "");

    // Start a SoftAP, called if no wifi can be connected
    bool runSoftAP(String apName = "", String apPass = "");

    // Disconnect/Stop SoftAP Mode
    void stopSoftAP();

    // Disconnect/Stop STA Mode
    void stopClient();

    // Disconnect/Stop SoftAP and STA Mode. Optionally end the task loop as well.
    void stopWifi(bool killTask = false);

    // Run in the loop to maintain state
    void loop();

    // Do a request queued by wifiRemoteEnqueue() and send the answer. Runs on
    // the Wi-Fi task, so a scan or NVS write never stalls the audio socket.
    void serviceRemote();

    // Move to saved network apId on a parent's request, going back to
    // `previous` if it does not lead to our server. Wi-Fi task only.
    void switchNetwork(uint8_t apId, const String &previous);

    // Write AP Settings into persistent storage. Called on each addAP;
    bool writeToNVS();

    // Load AP Settings from NVS it known apList
    bool loadFromNVS();
};

#endif
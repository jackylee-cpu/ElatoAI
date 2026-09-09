#include "AudioSelfTest.h"
#include "Button.h"
#include "Chime.h"
#include "Display.h"
#include "FactoryReset.h"
#include "LEDHandler.h"
#include "OTA.h"
#include "WifiManager.h"
#include <driver/rtc_io.h>
#include <driver/touch_sensor.h>
#include <esp_heap_caps.h>
#include <esp_sleep.h>
#include <esp_system.h>
#include <esp_wifi.h>

#define TOUCH_THRESHOLD 28000
#define REQUIRED_RELEASE_CHECKS                                                \
  100 // how many consecutive times we need "below threshold" to confirm release
#define TOUCH_DEBOUNCE_DELAY 500 // milliseconds

AsyncWebServer webServer(80);
WIFIMANAGER WifiManager;
esp_err_t getErr = ESP_OK;

// Everything below raises sleepRequested; loop() -> processSleepRequest() is
// the only caller of enterSleep(), so sleep always happens on the main thread
// with no task holding a driver.
//
//   Main Thread  -> loop() -> checkIdleTimeout()      (IDLE_SLEEP_SECONDS)
//   Network Task -> webSocketEvent() SESSION.END      (server asks)
//   Button Task  -> onTouchLongPressCb()              (see below)
//   Touch Task   -> touchTask()                       (TOUCH_MODE builds only)
//
// The boot button is push-to-talk and does not sleep the device: sleep lives on
// the touch pad so a mis-timed PTT press can never trigger it.
//
// That touch-pad path does not actually work on this hardware: holding the pad
// arrives as onTouchTapCb (a single click, which resets the conversation), so
// the library never sees a press lasting the 1500ms that
// CONFIG_BUTTON_LONG_PRESS_TIME_MS wants. The pulse width the TTP223 really
// produces has not been measured yet, so whether the fix is a different gesture
// or a different threshold is still open. Until then the timeout and
// SESSION.END are the only two ways in.
void enterSleep() {
  Serial.println("Going to sleep...");
  displaySleep();

  // First, change device state to prevent any new data processing
  deviceState = SLEEP;
  scheduleIdleAfterTurn = false;
  i2sOutputFlushScheduled = true;
  i2sInputFlushScheduled = true;

  // audioStreamTask answers i2sOutputFlushScheduled by fading the output down
  // and writing that fade to I2S. Tearing the driver out from under a task that
  // is inside i2s_write() is a crash, so wait for the fade to report itself
  // done, then stop the two tasks that can touch I2S at all.
  for (int i = 0; i < 40 && i2sOutputFlushScheduled; i++) {
    vTaskDelay(pdMS_TO_TICKS(5));
  }
  vTaskDelay(pdMS_TO_TICKS(20));
  if (speakerTaskHandle != NULL) vTaskSuspend(speakerTaskHandle);
  if (micTaskHandle != NULL) vTaskSuspend(micTaskHandle);

  xSemaphoreTake(wsMutex, portMAX_DELAY);

  i2s_stop(I2S_PORT_IN);
  i2s_stop(I2S_PORT_OUT);

  // Properly disconnect WebSocket and wait for it to complete
  if (webSocket.isConnected()) {
    webSocket.disconnect();
    // Give some time for the disconnect to process
  }
  xSemaphoreGive(wsMutex);
  delay(100);

  // Stop all tasks that might be using I2S or other peripherals
  i2s_driver_uninstall(I2S_PORT_IN);
  i2s_driver_uninstall(I2S_PORT_OUT);

  // Nothing owns the output port now, which is the one window the sleep sound
  // has. It installs and tears down its own driver and blocks until the last
  // sample is out, so it has to sit above the pin parking below: it drives
  // I2S_SD_OUT high and leaves it there.
  playSleepChime();

  // The amp has no usable SD pin on this kit (Config.cpp), so drive the spare
  // line and the LEDs low rather than leaving them wherever the last state put
  // them: a pin left driven is current drawn for the whole sleep.
  digitalWrite(I2S_SD_OUT, LOW);
  digitalWrite(BLUE_LED_PIN, LOW);
  digitalWrite(RED_LED_PIN, LOW);
  digitalWrite(GREEN_LED_PIN, LOW);

  // Stop the radio properly. esp_deep_sleep_start() does not do this for us,
  // and a running station leaves the RF and its clocks up until the very last
  // moment.
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  esp_wifi_stop();

  // ext0 moves BUTTON_PIN onto the RTC mux, and the pull-up that pinMode() set
  // in the digital domain does not come with it. Without this the pad floats
  // through deep sleep, reads as the LOW we are waking on, and the device wakes
  // roughly a second after it went down -- which is the two-minute "restart"
  // followed by an unasked-for greeting.
  rtc_gpio_pullup_en(BUTTON_PIN);
  rtc_gpio_pulldown_dis(BUTTON_PIN);

  // And a press still being held would satisfy ext0 the instant we sleep.
  for (int i = 0; i < 100 && gpio_get_level(BUTTON_PIN) == 0; i++) {
    delay(50);
  }

  Serial.printf("Sleeping. Wake on GPIO%d going low. Button reads %d (expect 1)\n",
                (int)BUTTON_PIN, gpio_get_level(BUTTON_PIN));

  // Flush any remaining serial output
  Serial.flush();
  delay(50);

#ifdef TOUCH_MODE
  touch_pad_intr_disable(TOUCH_PAD_INTR_MASK_ALL);
  while (touchRead(TOUCH_PAD_NUM2) > TOUCH_THRESHOLD) {
    delay(50);
  }
  delay(500);
  touchSleepWakeUpEnable(TOUCH_PAD_NUM2, TOUCH_THRESHOLD);
#endif

  esp_deep_sleep_start();
  delay(1000);
}

// Idle long enough and the device sleeps. Only from the two states that mean
// "nobody is doing anything": SOFT_AP has someone half way through wifi setup,
// OTA is mid-update, and SPEAKING/LISTENING are self-evidently in use.
// PROCESSING counts because a turn the server never answers would otherwise
// keep the device awake forever.
// Overridable so that testing what happens at sleep does not cost two minutes
// of waiting per attempt:
//
//   PLATFORMIO_BUILD_FLAGS="-D IDLE_SLEEP_SECONDS=15" pio run -t upload
#ifndef IDLE_SLEEP_SECONDS
#define IDLE_SLEEP_SECONDS (2 * 60)
#endif
static const unsigned long IDLE_SLEEP_MS = IDLE_SLEEP_SECONDS * 1000UL;

static void checkIdleTimeout() {
  if (deviceState != IDLE && deviceState != PROCESSING) {
    return;
  }
  if (millis() - lastActivityAt < IDLE_SLEEP_MS) {
    return;
  }
  Serial.printf("Idle for %lus, going to sleep\n", IDLE_SLEEP_MS / 1000);
  sleepRequested = true;
}

void processSleepRequest() {
  if (sleepRequested) {
    sleepRequested = false;
    enterSleep(); // Just call it directly - no state checking needed
  }
}

void printOutESP32Error(esp_err_t err) {
  switch (err) {
  case ESP_OK:
    Serial.println("ESP_OK no errors");
    break;
  case ESP_ERR_INVALID_ARG:
    Serial.println("ESP_ERR_INVALID_ARG if the selected GPIO is not an RTC "
                   "GPIO, or the mode is invalid");
    break;
  case ESP_ERR_INVALID_STATE:
    Serial.println("ESP_ERR_INVALID_STATE if wakeup triggers conflict or "
                   "wireless not stopped");
    break;
  default:
    Serial.printf("Unknown error code: %d\n", err);
    break;
  }
}

// Push-to-talk on the boot button: hold to speak, release to send. These only
// raise flags -- networkTask owns wsMutex and does the sending.
static void onPttDownCb(void *button_handle, void *usr_data) {
  pttHeld = true;
  pttPressRequested = true;
  noteActivity();
}

static void onPttUpCb(void *button_handle, void *usr_data) {
  pttHeld = false;
  pttReleaseRequested = true;
  noteActivity();
}

// Touch pad: tap starts a fresh conversation, holding it puts the device to
// sleep. Sleep lives here rather than on the boot button so it can never be
// triggered by a mis-timed push-to-talk press.
static void onTouchTapCb(void *button_handle, void *usr_data) {
  conversationResetRequested = true;
  noteActivity();
}

static void onTouchLongPressCb(void *button_handle, void *usr_data) {
  Serial.println("Touch held, going to sleep");
  sleepRequested = true;
}

static const int VOLUME_STEP = 10;

static void onVolumeUpCb(void *button_handle, void *usr_data) {
  nudgeVolume(VOLUME_STEP);
  noteActivity();
}

static void onVolumeDownCb(void *button_handle, void *usr_data) {
  nudgeVolume(-VOLUME_STEP);
  noteActivity();
}

// Button(pin, false) selects active-low, which is what a button wired to GND
// needs, but it also enables an internal pulldown that would hold the line
// active forever. GPIO0 gets away with it because the board pulls it up
// externally; these two need the pull-up forced on.
static Button *attachVolumeButton(gpio_num_t pin, callbackFunction cb) {
  Button *button = new Button(pin, false);
  gpio_set_pull_mode(pin, GPIO_PULLUP_ONLY);
  button->attachSingleClickEventCb(cb, NULL);
  // Repeats while held, so holding ramps the volume instead of needing taps.
  button->attachLongPressHoldEventCb(cb, NULL);
  return button;
}

void getAuthTokenFromNVS() {
  preferences.begin("auth", false);
  authTokenGlobal = preferences.getString("auth_token", "");
  preferences.end();
}

void setupWiFi() {
  WifiManager.startBackgroundTask(
      "ELATO-DEVICE"); // Run the background task to take care of our Wifi
  WifiManager.fallbackToSoftAp(
      true); // Run a SoftAP if no known AP can be reached
  WifiManager.attachWebServer(&webServer); // Attach our API to the Webserver
  WifiManager.attachUI();                  // Attach the UI to the Webserver

  // Run the Webserver and add your webpages to it
  webServer.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->redirect("/wifi");
  });
  webServer.onNotFound([](AsyncWebServerRequest *request) {
    request->send(404, "text/plain", "Not found");
  });
  webServer.begin();
}

void touchTask(void *parameter) {
  touch_pad_init();
  touch_pad_config(TOUCH_PAD_NUM2);

  bool touched = false;
  unsigned long pressStartTime = 0;
  unsigned long lastTouchTime = 0;
  const unsigned long LONG_PRESS_DURATION = 500; // 500ms for long press

  while (1) {
    // Read the touch sensor
    uint32_t touchValue = touchRead(TOUCH_PAD_NUM2);
    bool isTouched = (touchValue > TOUCH_THRESHOLD);
    unsigned long currentTime = millis();

    // Initial touch detection
    if (isTouched && !touched &&
        (currentTime - lastTouchTime > TOUCH_DEBOUNCE_DELAY)) {
      touched = true;
      pressStartTime = currentTime; // Start timing the press
      lastTouchTime = currentTime;
    }

    // Check for long press while touched
    if (touched && isTouched) {
      if (currentTime - pressStartTime >= LONG_PRESS_DURATION) {
        sleepRequested =
            true; // Only enter sleep after 500ms of continuous touch
      }
    }

    // Release detection
    if (!isTouched && touched) {
      touched = false;
      pressStartTime = 0; // Reset the press timer
    }

    vTaskDelay(20); // Reduced from 50ms to 20ms for better responsiveness
  }
  vTaskDelete(NULL);
}

void setupDeviceMetadata() {
  // factoryResetDevice();
  // resetAuth();

  deviceState = IDLE;

  loadStoredVolume();

  // Tokens minted under an older provisioning scheme are still accepted by
  // isDeviceRegistered(), which returns early on any stored token. Clear once
  // so this board registers itself again and can be claimed by a real account.
  preferences.begin("device", false);
  uint32_t provisionVersion = preferences.getUInt("prov_ver", 0);
  bool provisionChanged = provisionVersion < PROVISION_VERSION;
  if (provisionChanged) {
    preferences.putUInt("prov_ver", PROVISION_VERSION);
  }
  preferences.end();
  if (provisionChanged) {
    Serial.println("Provisioning scheme changed, clearing stored auth token");
    resetAuth();
  }

  getAuthTokenFromNVS();
  getOTAStatusFromNVS();

  if (otaState == OTA_IN_PROGRESS || otaState == OTA_COMPLETE) {
    deviceState = OTA;
  }
  if (factory_reset_status) {
    deviceState = FACTORY_RESET;
  }
}

// The panic handler prints to UART0, which this board does not break out, so a
// crash reaches the USB console only as a re-enumeration with no message. The
// reset reason recorded for the next boot is the one thing that survives it.
static const char *wakeCauseName(esp_sleep_wakeup_cause_t cause) {
  switch (cause) {
  case ESP_SLEEP_WAKEUP_UNDEFINED: return "not a sleep wake";
  case ESP_SLEEP_WAKEUP_EXT0: return "EXT0 (button)";
  case ESP_SLEEP_WAKEUP_EXT1: return "EXT1";
  case ESP_SLEEP_WAKEUP_TIMER: return "timer";
  case ESP_SLEEP_WAKEUP_TOUCHPAD: return "touchpad";
  case ESP_SLEEP_WAKEUP_ULP: return "ULP";
  case ESP_SLEEP_WAKEUP_GPIO: return "GPIO";
  case ESP_SLEEP_WAKEUP_UART: return "UART";
  default: return "other";
  }
}

static const char *resetReasonName(esp_reset_reason_t reason) {
  switch (reason) {
  case ESP_RST_POWERON: return "power-on";
  case ESP_RST_SW: return "software";
  case ESP_RST_PANIC: return "PANIC (exception)";
  case ESP_RST_INT_WDT: return "interrupt watchdog";
  case ESP_RST_TASK_WDT: return "task watchdog";
  case ESP_RST_WDT: return "other watchdog";
  case ESP_RST_DEEPSLEEP: return "deep sleep wake";
  case ESP_RST_BROWNOUT: return "BROWNOUT (supply dipped)";
  case ESP_RST_EXT: return "external reset";
  default: return "unknown";
  }
}

// TinyUSB CDC only starts carrying bytes once the host has enumerated the
// device, which takes about a second -- longer than it takes setup() to print.
// Every boot line, the reset reason included, was being written into a port
// nobody had opened yet. Keep the banner and print it a second time once the
// host has had a chance to attach.
static char bootBanner[192] = "";
static bool bootBannerReprinted = false;

void setup() {
  Serial.begin(115200);
  delay(500);

  snprintf(bootBanner, sizeof(bootBanner),
           "=== Boot: %s | wake: %s | heap %u | largest block %u | psram %u ===",
           resetReasonName(esp_reset_reason()),
           wakeCauseName(esp_sleep_get_wakeup_cause()), ESP.getFreeHeap(),
           heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
           heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
  Serial.printf("\n%s\n", bootBanner);

#ifdef AUDIO_SELFTEST
  // The `-audiotest` environment stops here: nothing else in setup() runs, so
  // no radio, no websocket and no decoder can contribute to what you hear.
  runAudioSelfTest();  // never returns
#endif

  // SETUP
  setupDeviceMetadata();
  wsMutex = xSemaphoreCreateMutex();

// INTERRUPT
#ifdef TOUCH_MODE
  xTaskCreate(touchTask, "Touch Task", 4096, NULL, configMAX_PRIORITIES - 2,
              NULL);
#else
  getErr = esp_sleep_enable_ext0_wakeup(BUTTON_PIN, LOW);
  printOutESP32Error(getErr);
  Button *btn = new Button(BUTTON_PIN, false);
  btn->attachPressDownEventCb(&onPttDownCb, NULL);
  btn->attachPressUpEventCb(&onPttUpCb, NULL);
#endif

  attachVolumeButton(VOLUME_UP_PIN, &onVolumeUpCb);
  attachVolumeButton(VOLUME_DOWN_PIN, &onVolumeDownCb);

  // The TTP223 drives its output high on touch, so this one is active-high.
  // Force a pulldown afterwards: if the pad is not actually wired, the line
  // then reads idle instead of looking permanently touched, which would
  // otherwise reset the conversation in a loop.
  Button *touchPad = new Button(TOUCH_PAD_PIN, true);
  gpio_set_pull_mode(TOUCH_PAD_PIN, GPIO_PULLDOWN_ONLY);
  touchPad->attachSingleClickEventCb(&onTouchTapCb, NULL);
  touchPad->attachLongPressStartEventCb(&onTouchLongPressCb, NULL);
  Serial.printf("Touch pad GPIO%d idle level: %d (expect 0)\n", (int)TOUCH_PAD_PIN,
                gpio_get_level(TOUCH_PAD_PIN));

  displaySetup();
  noteActivity();

  // Pin audio tasks to Core 1 (application core)
  xTaskCreatePinnedToCore(ledTask,    // Function
                          "LED Task", // Name
                          4096,       // Stack size
                          NULL,       // Parameters
                          5,          // Priority
                          NULL,       // Handle
                          1           // Core 1 (application core)
  );

  xTaskCreatePinnedToCore(audioStreamTask, // Function
                          "Speaker Task",  // Name
                          4096,            // Stack size
                          NULL,            // Parameters
                          3,                   // Priority
                          &speakerTaskHandle,  // Handle
                          1                    // Core 1 (application core)
  );

  xTaskCreatePinnedToCore(micTask,           // Function
                          "Microphone Task", // Name
                          4096,              // Stack size
                          NULL,              // Parameters
                          4,                 // Priority
                          &micTaskHandle,    // Handle
                          1                  // Core 1 (application core)
  );

  // Lowest priority on the application core: the audio tasks above must always
  // win, and a dropped redraw costs nothing.
  xTaskCreatePinnedToCore(displayTask,    // Function
                          "Display Task", // Name
                          4096,           // Stack size
                          NULL,           // Parameters
                          1,              // Priority
                          NULL,           // Handle
                          1               // Core 1 (application core)
  );

  // Pin network task to Core 0 (protocol core)
  xTaskCreatePinnedToCore(networkTask,              // Function
                          "Websocket Task",         // Name
                          8192,                     // Stack size
                          NULL,                     // Parameters
                          configMAX_PRIORITIES - 1, // Highest priority
                          &networkTaskHandle,       // Handle
                          0                         // Core 0 (protocol core)
  );

  // WIFI. audioStreamTask is playing the boot sound by now and is parked in
  // i2s_write between DMA buffers, which is what leaves this task the CPU to
  // get here: the sound and the association happen together rather than one
  // after the other.
  setupWiFi();
}

void loop() {
  if (!bootBannerReprinted && millis() > 4000) {
    bootBannerReprinted = true;
    Serial.printf("(replay) %s\n", bootBanner);
  }
  checkIdleTimeout();
  processSleepRequest();
  if (otaState == OTA_IN_PROGRESS) {
    loopOTA();
  }
}
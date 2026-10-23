#include "CrashReport.h"
#include "AudioSelfTest.h"
#include "Button.h"
#include "Battery.h"
#include "Chime.h"
#include "IoExpander.h"
#include "Display.h"
#include "FactoryReset.h"
#include "LEDHandler.h"
#include "OTA.h"
#include "SupplyMonitor.h"
#include "WifiManager.h"
#if !BOARD_SLEEP_VIA_LIGHT_SLEEP
#include <driver/rtc_io.h>
#endif
#ifdef TOUCH_MODE
#include <driver/touch_sensor.h>
#endif
#include <esp_heap_caps.h>
#include <esp_mac.h>
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

  // Properly disconnect WebSocket and wait for it to complete. The "bye" first,
  // so the app shows the toy as asleep rather than lost.
  if (webSocket.isConnected()) {
    sayBye(sleepReason);
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
  boardSetSpeakerAmp(false);
  digitalWrite(BLUE_LED_PIN, LOW);
  digitalWrite(RED_LED_PIN, LOW);
  digitalWrite(GREEN_LED_PIN, LOW);

  // Stop the radio properly. esp_deep_sleep_start() does not do this for us,
  // and a running station leaves the RF and its clocks up until the very last
  // moment.
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  esp_wifi_stop();

#if BOARD_SLEEP_VIA_LIGHT_SLEEP
  // No ext0 on this chip and BUTTON_PIN cannot wake it from deep sleep (see
  // BoardConfig.h), so park in light sleep until it goes low and then restart.
  // Everything above has already torn the device down the way deep sleep
  // expects; the restart gives the same fresh boot a deep-sleep wake would.
  for (int i = 0; i < 100 && gpio_get_level(BUTTON_PIN) == 0; i++) {
    delay(50);
  }
  Serial.printf("Sleeping (light). Wake on GPIO%d going low. Button reads %d (expect 1)\n",
                (int)BUTTON_PIN, gpio_get_level(BUTTON_PIN));
  Serial.flush();
  delay(50);
  gpio_wakeup_enable(BUTTON_PIN, GPIO_INTR_LOW_LEVEL);
  esp_sleep_enable_gpio_wakeup();
  esp_light_sleep_start();
  // Woken by the press itself. Restarting while it is still held would hand
  // the fresh boot a push-to-talk press nobody meant, so wait for the release.
  gpio_wakeup_disable(BUTTON_PIN);
  for (int i = 0; i < 200 && gpio_get_level(BUTTON_PIN) == 0; i++) {
    delay(10);
  }
  ESP.restart();
#else
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
#endif
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
//
// 0 turns idle sleep off entirely: the device, and its display, stay on until
// the power goes. The xmini-c3 build sets that.
#ifndef IDLE_SLEEP_SECONDS
#define IDLE_SLEEP_SECONDS (5 * 60)
#endif
static const unsigned long IDLE_SLEEP_MS = IDLE_SLEEP_SECONDS * 1000UL;

static void checkIdleTimeout() {
  if (IDLE_SLEEP_SECONDS == 0) {
    return;
  }
  // SOFT_AP counts too when the AP is up only to look for a saved network
  // and no phone is on it: since that AP no longer times out, a long outage
  // otherwise kept the toy awake, radio on, until the battery was flat.
  if (deviceState != IDLE && deviceState != PROCESSING &&
      !(deviceState == SOFT_AP && WifiManager.setupApOnlyLooking())) {
    return;
  }
  if (millis() - lastActivityAt < IDLE_SLEEP_MS) {
    return;
  }
  Serial.printf("Idle for %lus, going to sleep\n", IDLE_SLEEP_MS / 1000);
  sleepReason = "sleep_idle";
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
  sleepReason = "sleep_button";
  sleepRequested = true;
}

static const int VOLUME_STEP = 10;

// The flash is the only feedback at the limit: nothing moves, and on a board
// whose keys are polled over I2C a press that does nothing is hard to tell
// from a press that was not read.
static void onVolumeUpCb(void *button_handle, void *usr_data) {
  if (!nudgeVolume(VOLUME_STEP)) ledFlash(120);
  noteActivity();
}

static void onVolumeDownCb(void *button_handle, void *usr_data) {
  if (!nudgeVolume(-VOLUME_STEP)) ledFlash(120);
  noteActivity();
}

// Button(pin, false) selects active-low, which is what a button wired to GND
// needs, but it also enables an internal pulldown that would hold the line
// active forever. GPIO0 gets away with it because the board pulls it up
// externally; these two need the pull-up forced on.
#if BOARD_HAS_GPIO_KEYS
static Button *attachVolumeButton(gpio_num_t pin, callbackFunction cb) {
  Button *button = new Button(pin, false);
  gpio_set_pull_mode(pin, GPIO_PULLUP_ONLY);
  button->attachSingleClickEventCb(cb, NULL);
  // Repeats while held, so holding ramps the volume instead of needing taps.
  button->attachLongPressHoldEventCb(cb, NULL);
  return button;
}
#endif

#if BOARD_KEYS_VIA_EXPANDER
// KEY1..KEY3 sit on the TCA9555, not on GPIOs, so there is no Button to attach
// and no interrupt to attach it to -- the expander's INT line is not wired to
// the ESP32 on this board. Polling stands in for both. 20ms is far inside the
// shortest press a person can make, and each pass costs one two-byte I2C read
// on a bus that is otherwise idle between turns.
//
// The three keys map onto what the breadboard kit puts on GPIOs: KEY1 and KEY2
// are the volume rocker, and KEY3 stands in for the TTP223 pad, tap to reset
// the conversation and hold to sleep. Push-to-talk stays on GPIO0, which is
// the only key here that can wake the chip.
static void expanderKeyTask(void *parameter) {
  constexpr TickType_t kPollInterval = pdMS_TO_TICKS(20);
  constexpr int kRepeatAfterTicks = 25;  // 500ms before a held volume key repeats
  constexpr int kRepeatEveryTicks = 8;   // then every 160ms, so a hold ramps
  constexpr int kLongPressTicks = 25;    // 500ms makes KEY3 a hold, not a tap
  // Both volume keys together for two seconds reboots. Nothing else on this
  // board can: GPIO0 is push-to-talk, so a long hold there is a long sentence,
  // and KEY3 sleeps at half a second. Two keys that mean "louder" and
  // "quieter" at once mean nothing on their own and are near impossible to
  // hit with one finger, which is what makes the combination safe to overload.
  //
  // This is a convenience for a board in an enclosure, not a recovery path.
  // The hardware RESET button is wired to EN and works even when the firmware
  // has stopped scheduling this task; nothing here can match that.
  constexpr int kRebootComboTicks = 100;  // 2s

  bool wasDown[3] = {false, false, false};
  int heldTicks[3] = {0, 0, 0};
  int comboTicks = 0;
  bool longPressFired = false;

  while (true) {
    bool down[3] = {false, false, false};
    if (ioExpanderReadKeys(down[0], down[1], down[2])) {
      for (int i = 0; i < 3; i++) {
        heldTicks[i] = down[i] ? heldTicks[i] + 1 : 0;
      }

      // Holding both is the reboot gesture, not two volume presses. Whichever
      // key landed first will already have moved the volume one step, which is
      // 10% and is about to be irrelevant anyway.
      const bool comboDown = down[0] && down[1];
      comboTicks = comboDown ? comboTicks + 1 : 0;
      if (comboTicks == kRebootComboTicks) {  // == so it fires once, not every tick
        Serial.println("Both volume keys held -- rebooting");
        // Mute before the clocks stop, same reason as the sleep path.
        boardSetSpeakerAmp(false);
        ledFlash(400);
        vTaskDelay(pdMS_TO_TICKS(400));  // long enough for the flash to be seen
        ESP.restart();
      }

      for (int i = 0; i < 2 && !comboDown; i++) {
        const bool pressed = down[i] && !wasDown[i];
        const bool repeating = down[i] && heldTicks[i] > kRepeatAfterTicks &&
                               ((heldTicks[i] - kRepeatAfterTicks) % kRepeatEveryTicks) == 0;
        if (pressed || repeating) {
          if (i == 0) {
            onVolumeUpCb(NULL, NULL);
          } else {
            onVolumeDownCb(NULL, NULL);
          }
        }
      }

      // The hold fires while the key is still down rather than on release, so
      // it matches attachLongPressStartEventCb on the other board; the tap
      // only fires on release, and only if the hold did not already claim it.
      if (down[2] && !wasDown[2]) longPressFired = false;
      if (down[2] && !longPressFired && heldTicks[2] >= kLongPressTicks) {
        longPressFired = true;
        onTouchLongPressCb(NULL, NULL);
      }
      if (!down[2] && wasDown[2] && !longPressFired) {
        onTouchTapCb(NULL, NULL);
      }

      for (int i = 0; i < 3; i++) wasDown[i] = down[i];
    }
    vTaskDelay(kPollInterval);
  }
}
#endif

void setupWiFi() {
  // The setup AP is "AIBuddy-" plus the last 4 hex digits of the station MAC
  // (the one the server and app know the device by), so two units in one
  // home can be told apart. esp_read_mac() reads the eFuse, so it works
  // before WiFi is started.
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char softApName[16];
  snprintf(softApName, sizeof softApName, "AIBuddy-%02X%02X", mac[4], mac[5]);

  // Routes only: the setup AP starts the server (WIFIMANAGER::runSoftAP()),
  // and it is attached before startBackgroundTask() because the boot connect
  // below can already open that AP.
  WifiManager.fallbackToSoftAp(
      true); // Run a SoftAP if no known AP can be reached
  WifiManager.attachWebServer(&webServer); // Attach our API to the Webserver
  WifiManager.attachUI();                  // Attach the UI to the Webserver

  // Run the Webserver and add your webpages to it
  webServer.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->redirect("/wifi");
  });
  // While the setup AP is up, anything we do not serve is a phone's
  // connectivity probe arriving through the captive DNS (see WifiManager.cpp),
  // and a redirect is what makes the phone open the setup page by itself.
  // Absolute, because the request's Host is captive.apple.com or similar.
  webServer.onNotFound([](AsyncWebServerRequest *request) {
    if (WiFi.getMode() & WIFI_MODE_AP) {
      request->redirect("http://" + WiFi.softAPIP().toString() + "/wifi");
      return;
    }
    request->send(404, "text/plain", "Not found");
  });

  WifiManager.startBackgroundTask(
      softApName); // Run the background task to take care of our Wifi
}

#ifdef TOUCH_MODE
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
        sleepReason = "sleep_button";
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
#endif

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
  crashReportBegin();
  otaBootCheck();

#ifdef AUDIO_SELFTEST
  // The `-audiotest` environment stops here: nothing else in setup() runs, so
  // no radio, no websocket and no decoder can contribute to what you hear.
  runAudioSelfTest();  // never returns
#endif

  // SETUP
  setupDeviceMetadata();
  // A binary semaphore on a single core, not a mutex. networkTask holds this
  // across the whole of webSocket.loop(), and the TLS handshake inside it
  // briefly takes some system lock that a priority-23 task then waits on.
  // FreeRTOS only hands an inherited priority back once the holder has
  // released *every* mutex it holds, so networkTask sat at 23 for the rest of
  // the 1.2s handshake and the speaker got nothing (measured 2026-09-30:
  // priority 23 from 4ms into the connect until the loop returned). A
  // semaphore is not counted, so the boost ends with the lock that caused it.
  // Nothing needs inheritance from this one here: the only other taker is
  // micTask at 4, and there is no task between it and networkTask at 3.
#if CONFIG_FREERTOS_UNICORE
  wsMutex = xSemaphoreCreateBinary();
  xSemaphoreGive(wsMutex);
#else
  wsMutex = xSemaphoreCreateMutex();
#endif

  // Before every task that follows. On a codec board the amplifier enable and
  // three of the four keys are on an I2C expander, and the codecs themselves
  // are configured over the same bus, so nothing can make a sound or read a
  // key until this has run. displaySetup() calls Wire.begin() too; the second
  // call is harmless.
  Serial.printf("Board: %s\n", BOARD_NAME);
  boardI2CBegin();

// INTERRUPT
#ifdef TOUCH_MODE
  xTaskCreate(touchTask, "Touch Task", 4096, NULL, configMAX_PRIORITIES - 2,
              NULL);
#else
#if !BOARD_SLEEP_VIA_LIGHT_SLEEP
  getErr = esp_sleep_enable_ext0_wakeup(BUTTON_PIN, LOW);
  printOutESP32Error(getErr);
#endif
  Button *btn = new Button(BUTTON_PIN, false);
#if BOARD_SLEEP_VIA_LIGHT_SLEEP
  // Button(pin, false) turns on a pulldown, which GPIO0 on the S3 boards
  // survives because of its external pull-up. Whether GPIO9 has one on this
  // board is not documented, so do not depend on it.
  gpio_set_pull_mode(BUTTON_PIN, GPIO_PULLUP_ONLY);
#endif
  btn->attachPressDownEventCb(&onPttDownCb, NULL);
  btn->attachPressUpEventCb(&onPttUpCb, NULL);
#endif

#if BOARD_KEYS_VIA_EXPANDER
  xTaskCreate(expanderKeyTask, "Expander Keys", 3072, NULL,
              configMAX_PRIORITIES - 2, NULL);
#elif BOARD_HAS_GPIO_KEYS
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
#endif

  displaySetup();
  batteryBegin();
  supplyMonitorBegin();
  noteActivity();

  // Before the tasks, not inside one: networkTask is created at the highest
  // priority in the system and starts dispatching websocket frames the instant
  // it exists, so the queue it writes into cannot be allocated by a task that
  // may not have been scheduled yet.
  audioPacketQueueSetup();

  // Pin audio tasks to Core 1 (application core)
  // Priority 1, with the display task, and for the same reason: this loop sets
  // a static colour from deviceState every 20ms and a late colour change is
  // invisible. It used to be 5, above both the task that feeds the speaker DMA
  // (3) and the one that decodes into it (2), which is the wrong way round on
  // principle.
  //
  // It is only principle, though -- this was changed to buy back the gap
  // between decode CPU time and decode wall time, and measured on hardware it
  // buys nothing: 8672us wall against 7609us CPU per packet before, 8578us
  // against 7729us after, which is noise. Nor should it have: the loop below
  // wakes every 20ms, writes one colour and sleeps, so even at priority 5 it
  // can only ever steal microseconds.
  //
  // The gap is audioStreamTask doing its job. It wakes every 1ms, so it runs
  // about eight times during one packet's decode, and 849us spread over eight
  // passes is ~106us each -- which is what a copier.copy() of up to 1024 bytes
  // plus an I2S write costs. That time is the speaker being fed; there is no
  // preemption here to reclaim, and a buffer sized for decode wall time has to
  // include it.
#if BOARD_HAS_STATUS_LED
  xTaskCreatePinnedToCore(ledTask,    // Function
                          "LED Task", // Name
                          4096,       // Stack size
                          NULL,       // Parameters
                          1,          // Priority
                          NULL,       // Handle
                          APP_CORE    // Core 1 (application core); 0 on a single-core chip
  );
#endif

  xTaskCreatePinnedToCore(audioStreamTask, // Function
                          "Speaker Task",  // Name
                          4096,            // Stack size
                          NULL,            // Parameters
                          3,                   // Priority
                          &speakerTaskHandle,  // Handle
                          APP_CORE             // Core 1 (application core)
  );

  // Opus decode, fed by networkTask over the queue allocated above.
  //
  // Core 1 rather than 0: core 0 belongs to the radio (the wifi driver task and
  // lwIP), and networkTask already sits above both of them at the top priority
  // in the system -- a decode burst there preempts the stack it is decoding
  // data from.
  //
  // Priority 2 is below the speaker task deliberately. This task spends most of
  // a turn parked in the PCM ring's blocking write, and the only thing that
  // frees that ring is the speaker task: it must always win. Above the display
  // task, whose redraws can wait.
  xTaskCreatePinnedToCore(decodeTask,        // Function
                          "Opus Decode",     // Name
                          6144,              // Stack size. opus keeps its
                                             // working arrays on the heap, so
                                             // this is mostly call depth --
                                             // but the decode used to run on
                                             // networkTask's 8192 and a stack
                                             // overflow here is a boot loop,
                                             // not a log line. Trim it against
                                             // the "Decode stack headroom"
                                             // figure, not by guessing.
                          NULL,              // Parameters
                          2,                 // Priority
                          &decodeTaskHandle, // Handle
                          APP_CORE           // Core 1 (application core)
  );

  xTaskCreatePinnedToCore(micTask,           // Function
                          "Microphone Task", // Name
                          4096,              // Stack size
                          NULL,              // Parameters
                          4,                 // Priority
                          &micTaskHandle,    // Handle
                          APP_CORE           // Core 1 (application core)
  );

  // Lowest priority on the application core: the audio tasks above must always
  // win, and a dropped redraw costs nothing.
  xTaskCreatePinnedToCore(displayTask,    // Function
                          "Display Task", // Name
                          4096,           // Stack size
                          NULL,           // Parameters
                          1,              // Priority
                          NULL,           // Handle
                          APP_CORE        // Core 1 (application core)
  );

  // Pin network task to Core 0 (protocol core)
  //
  // On a single core it cannot be the highest priority in the system: the
  // websocket's TLS handshake runs inside webSocket.loop() and is ~1.3s of
  // solid CPU on the C3, which at the top priority starved the speaker task
  // for 1138ms and froze the boot sound mid-note (measured 2026-09-30). Level
  // with the speaker task it still preempts decode, as it does on the S3,
  // but the speaker gets its DMA refills within a tick. This alone was not
  // enough: see wsMutex in setup() for the priority inheritance that kept it
  // at 23 regardless. With both, the boot sound plays through the handshake
  // untouched and the connect takes ~170ms longer.
#if CONFIG_FREERTOS_UNICORE
  const UBaseType_t networkTaskPriority = 3;
#else
  const UBaseType_t networkTaskPriority = configMAX_PRIORITIES - 1;
#endif
  xTaskCreatePinnedToCore(networkTask,              // Function
                          "Websocket Task",         // Name
                          8192,                     // Stack size
                          NULL,                     // Parameters
                          networkTaskPriority,      // See above
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
    // Same reason as the banner: these are decided during setup, and the host
    // has not finished enumerating the CDC port by then.
    boardReport();
    audioMemoryReport();
  }
  checkIdleTimeout();
  supplyMonitorPoll();
  processSleepRequest();
  otaPoll();
#ifdef OTA_TEST_CRASH_AFTER_CONFIRM_MS
  // A test image that passes probation and only then crash-loops, to watch the
  // fall-back to the other slot (P0-13). Command line only.
  if (!otaOnProbation() && millis() > OTA_TEST_CRASH_AFTER_CONFIRM_MS) {
    Serial.println("[OTA] Test build crashing on purpose (confirmed image)");
    abort();
  }
#endif
#ifdef OTA_TEST_CRASH_MS
  // A deliberately broken image, to watch the bootloader roll back (P0-13).
  // Only ever set on the command line: PLATFORMIO_BUILD_FLAGS=-DOTA_TEST_CRASH_MS=3000
  if (millis() > OTA_TEST_CRASH_MS) {
    Serial.println("[OTA] Test build crashing on purpose");
    abort();
  }
#endif
}
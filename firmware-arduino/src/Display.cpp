#include "Display.h"
#include "Audio.h"
#include <U8g2lib.h>
#include <Wire.h>
#include <WiFi.h>

// Most 0.96" modules are an SSD1306 at 0x3C. An SH1106 panel is the other
// common one; it is 132 columns wide internally, so on it this driver renders
// two pixels to the left. If the boot scan finds a display but everything sits
// slightly off screen, swap this one line for the SH1106 constructor:
//   U8G2_SH1106_128X64_NONAME_F_HW_I2C
static U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

static bool displayPresent = false;
static volatile bool displayAsleep = false;

// What the panel says for each state. Kept to plain ASCII: a CJK font would
// cost more flash than the whole rest of this file.
static const char *stateLabel(DeviceState state) {
    switch (state) {
    case SETUP: return "SETUP";
    case SOFT_AP: return "WIFI SETUP";
    case IDLE: return "READY";
    case LISTENING: return "LISTENING";
    case PROCESSING: return "THINKING";
    case SPEAKING: return "SPEAKING";
    case WAITING: return "WAITING";
    case OTA: return "UPDATING";
    case FACTORY_RESET: return "RESET";
    case SLEEP: return "SLEEP";
    default: return "?";
    }
}

// The panel model is unknown on this kit, so report whatever answers rather
// than assuming an address.
static uint8_t scanForDisplay() {
    uint8_t found = 0;
    for (uint8_t address = 1; address < 127; address++) {
        Wire.beginTransmission(address);
        if (Wire.endTransmission() == 0) {
            Serial.printf("I2C device at 0x%02X\n", address);
            if (address == 0x3C || address == 0x3D) {
                found = address;
            }
        }
    }
    return found;
}

void displaySetup() {
    Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, 400000);

    uint8_t address = scanForDisplay();
    if (address == 0) {
        Serial.printf("No display on SDA=%d SCL=%d, running headless\n",
                      I2C_SDA_PIN, I2C_SCL_PIN);
        return;
    }

    u8g2.setI2CAddress(address << 1);  // u8g2 wants the 8-bit form
    if (!u8g2.begin()) {
        Serial.println("Display found but failed to start");
        return;
    }
    u8g2.setBusClock(400000);
    displayPresent = true;
    Serial.printf("Display ready at 0x%02X\n", address);
}

static void draw(DeviceState state, int volume, bool wifiUp, bool wsUp) {
    u8g2.clearBuffer();

    u8g2.setFont(u8g2_font_5x8_tr);
    u8g2.drawStr(0, 7, "aibuddy");
    // Right-aligned link status, so the eye lands on the same spot every time.
    const char *link = !wifiUp ? "NO WIFI" : (wsUp ? "ONLINE" : "CONNECTING");
    u8g2.drawStr(128 - u8g2.getStrWidth(link), 7, link);
    u8g2.drawHLine(0, 10, 128);

    u8g2.setFont(u8g2_font_helvB14_tr);
    const char *label = stateLabel(state);
    u8g2.drawStr((128 - u8g2.getStrWidth(label)) / 2, 38, label);

    u8g2.setFont(u8g2_font_5x8_tr);
    char volumeText[16];
    snprintf(volumeText, sizeof(volumeText), "VOL %d", volume);
    u8g2.drawStr(0, 63, volumeText);
    // Bar starts clear of the longest "VOL 100".
    const int barLeft = 44, barRight = 127, barTop = 56, barHeight = 7;
    u8g2.drawFrame(barLeft, barTop, barRight - barLeft, barHeight);
    int fill = ((barRight - barLeft - 2) * constrain(volume, 0, 100)) / 100;
    if (fill > 0) {
        u8g2.drawBox(barLeft + 1, barTop + 1, fill, barHeight - 2);
    }

    u8g2.sendBuffer();
}

void displaySleep() {
    if (!displayPresent) {
        return;
    }
    displayAsleep = true;
    u8g2.clearBuffer();
    u8g2.sendBuffer();
    u8g2.setPowerSave(1);
}

void displayTask(void *parameter) {
    if (!displayPresent) {
        vTaskDelete(NULL);
        return;
    }

    // Redraw only on change: a full 1KB buffer over I2C is ~25ms, and there is
    // no reason to spend that while nothing on screen is moving.
    DeviceState lastState = (DeviceState)-1;
    int lastVolume = -1;
    bool lastWifi = false, lastWs = false;

    while (1) {
        if (displayAsleep) {
            vTaskDelay(pdMS_TO_TICKS(200));
            continue;
        }

        DeviceState state = deviceState;
        int volume = currentVolume;
        bool wifiUp = WiFi.status() == WL_CONNECTED;
        bool wsUp = webSocket.isConnected();

        if (state != lastState || volume != lastVolume || wifiUp != lastWifi ||
            wsUp != lastWs) {
            draw(state, volume, wifiUp, wsUp);
            lastState = state;
            lastVolume = volume;
            lastWifi = wifiUp;
            lastWs = wsUp;
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

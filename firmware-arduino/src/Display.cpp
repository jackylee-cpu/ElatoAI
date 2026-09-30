#include "Display.h"
#include "Audio.h"
#include "Battery.h"
#include <U8g2lib.h>
#include <Wire.h>
#include <WiFi.h>

// Most 0.96" modules are an SSD1306 at 0x3C. An SH1106 panel is the other
// common one; it is 132 columns wide internally, so on it this driver renders
// two pixels to the left. If the boot scan finds a display but everything sits
// slightly off screen, swap this one line for the SH1106 constructor:
//   U8G2_SH1106_128X64_NONAME_F_HW_I2C
static U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(BOARD_DISPLAY_ROTATION, U8X8_PIN_NONE);

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

// Signal strength as the number of arcs lit, 0..3. -1 means no WiFi at all.
// Thresholds are the usual phone ones; a step of hysteresis would stop a
// signal sitting on a boundary from redrawing the panel, but the redraw is
// cheap and the RSSI is already averaged by the driver.
static int wifiBars(bool wifiUp) {
    if (!wifiUp) return -1;
    const int rssi = WiFi.RSSI();
    if (rssi >= -60) return 3;
    if (rssi >= -70) return 2;
    if (rssi >= -80) return 1;
    return 0;
}

// The WiFi symbol, 15x10, hand-drawn rather than built from drawCircle():
// u8g2's circles at these radii leave vertical stubs at the arc ends and the
// arcs crowd each other. Each character is the signal level at which that
// pixel lights: '3' the outer arc, '1' the inner, '0' the dot, which is always
// on. Only lit arcs are drawn -- an unlit arc left dotted looked broken.
static const char *const kWifiArt[10] = {
    "....3333333....",
    "..33.......33..",
    ".3...........3.",
    "3....22222....3",
    "...22.....22...",
    "..2.........2..",
    "......111......",
    ".....1...1.....",
    ".......0.......",
    "......000......",
};
// No WiFi: the dot, with a cross where the arcs would be.
static const char *const kNoWifiArt[10] = {
    "...............",
    "...............",
    ".....0...0.....",
    "......0.0......",
    ".......0.......",
    "......0.0......",
    ".....0...0.....",
    "...............",
    ".......0.......",
    "......000......",
};
static const int kWifiW = 15, kWifiH = 10;

// Top-left at (x, y). `bars` is wifiBars(): -1 draws the no-WiFi symbol.
// Returns the width used. When the voice server is not reachable (`online`
// false) a "!" follows the symbol, which is the only difference between "on
// the network" and "ready to talk".
static int drawWifi(int x, int y, int bars, bool online) {
    const char *const *art = bars < 0 ? kNoWifiArt : kWifiArt;
    const int level = bars < 0 ? 0 : bars;
    for (int row = 0; row < kWifiH; row++) {
        for (int col = 0; col < kWifiW; col++) {
            const char c = art[row][col];
            if (c != '.' && c - '0' <= level) u8g2.drawPixel(x + col, y + row);
        }
    }
    if (bars < 0 || online) return kWifiW;
    u8g2.drawVLine(x + kWifiW + 2, y + 1, 5);
    u8g2.drawPixel(x + kWifiW + 2, y + 7);
    return kWifiW + 3;
}

// Battery outline 14x8 plus a 2px terminal, with the fill proportional to the
// level, top-left at (x, y). Charging draws a lightning bolt in XOR over the
// fill so it shows on both the filled and the empty part.
static void drawBattery(int x, int y, int percent, bool charging) {
    const int w = 14, h = 8;
    u8g2.drawFrame(x, y, w, h);
    u8g2.drawBox(x + w, y + 2, 2, h - 4);
    const int fill = ((w - 4) * constrain(percent, 0, 100) + 50) / 100;
    if (fill > 0) u8g2.drawBox(x + 2, y + 2, fill, h - 4);
    if (charging) {
        u8g2.setDrawColor(2);
        const int mx = x + w / 2;
        u8g2.drawLine(mx + 1, y + 1, mx - 2, y + 4);
        u8g2.drawLine(mx - 2, y + 4, mx + 2, y + 3);
        u8g2.drawLine(mx + 2, y + 3, mx - 1, y + 6);
        u8g2.setDrawColor(1);
    }
}

static void draw(DeviceState state, int volume, int bars, bool wsUp, bool battery,
                 int percent, bool charging) {
    u8g2.clearBuffer();

    u8g2.setFont(u8g2_font_5x8_tr);
    u8g2.drawStr(0, 7, "aibuddy");

    // Status icons, right-aligned so the eye lands on the same spot every
    // time: battery (with its percentage) at the edge, WiFi to its left.
    int right = 128;
    if (battery) {
        drawBattery(right - 16, 1, percent, charging);
        char text[6];
        snprintf(text, sizeof(text), "%d%%", percent);
        right -= 16 + 2 + u8g2.getStrWidth(text);
        u8g2.drawStr(right, 8, text);
        right -= 5;
    }
    const int wifiWidth = (bars < 0 || wsUp) ? kWifiW : kWifiW + 3;
    drawWifi(right - wifiWidth, 0, bars, wsUp);
    u8g2.drawHLine(0, 11, 128);

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
    int lastBars = -2;
    bool lastWs = false;
    bool lastBattery = false, lastCharging = false;
    int lastPercent = -1;

    while (1) {
        if (displayAsleep) {
            vTaskDelay(pdMS_TO_TICKS(200));
            continue;
        }

        batteryPoll();

        DeviceState state = deviceState;
        int volume = currentVolume;
        int bars = wifiBars(WiFi.status() == WL_CONNECTED);
        bool wsUp = webSocket.isConnected();
        bool battery = batteryPresent();
        int percent = batteryPercent();
        bool charging = batteryCharging();

        if (state != lastState || volume != lastVolume || bars != lastBars ||
            wsUp != lastWs || battery != lastBattery || percent != lastPercent ||
            charging != lastCharging) {
            draw(state, volume, bars, wsUp, battery, percent, charging);
            lastState = state;
            lastVolume = volume;
            lastBars = bars;
            lastWs = wsUp;
            lastBattery = battery;
            lastPercent = percent;
            lastCharging = charging;
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

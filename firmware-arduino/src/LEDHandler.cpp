#include "LEDHandler.h"
#include "LedRing.h"
#include "SupplyMonitor.h"
#include "ServerReach.h"

// This file was written for a discrete RGB LED on three GPIOs, which is what
// the breadboard kit has. The Waveshare board has a seven-pixel WS2812 ring on
// one data line instead, so the three primitives below redirect every call
// into a single ring colour and the logic above them stays as it was.
//
// The two conventions this file already mixes are both preserved rather than
// unified: ledPinWrite() is active-low, because the discrete LED is wired
// common-anode and setStaticColor() drives LOW to light a channel, while
// setLEDColor()'s ledPinAnalog() passes a straight intensity. Unifying them
// would change what the discrete LED does, which is not what this change is
// for.
#if BOARD_HAS_WS2812_RING

static uint8_t ringChannels[3] = {0, 0, 0};

static inline int ringIndexFor(int pin) {
    if (pin == RED_LED_PIN) return 0;
    if (pin == GREEN_LED_PIN) return 1;
    if (pin == BLUE_LED_PIN) return 2;
    return -1;
}

static inline void ringPush() {
    ledRingSet(ringChannels[0], ringChannels[1], ringChannels[2]);
}

static inline void ledPinMode(int) {}

static inline void ledPinWrite(int pin, int level) {
    const int index = ringIndexFor(pin);
    if (index < 0) return;
    ringChannels[index] = (level == LOW) ? 255 : 0;
    ringPush();
}

static inline void ledPinAnalog(int pin, int value) {
    const int index = ringIndexFor(pin);
    if (index < 0) return;
    ringChannels[index] = (uint8_t)value;
    ringPush();
}

#elif !BOARD_HAS_STATUS_LED

// Nothing to drive. The state logic below still runs; it just has no output.
static inline void ledPinMode(int) {}
static inline void ledPinWrite(int, int) {}
static inline void ledPinAnalog(int, int) {}

#else

static inline void ledPinMode(int pin) { pinMode(pin, OUTPUT); }
static inline void ledPinWrite(int pin, int level) { digitalWrite(pin, level); }
static inline void ledPinAnalog(int pin, int value) { analogWrite(pin, value); }

#endif


int brightness = 0;
int fadeAmount = 5;
static unsigned long lastToggle = 0;
static bool ledState = false;

void setLEDColor(uint8_t r, uint8_t g, uint8_t b)
{
    ledPinAnalog(RED_LED_PIN, r);
    ledPinAnalog(GREEN_LED_PIN, g);
    ledPinAnalog(BLUE_LED_PIN, b);
}

enum class StaticColor : uint8_t
{
    RED,
    GREEN,
    BLUE,
    YELLOW,
    MAGENTA,
    CYAN,
};

struct RGB {
    bool red;
    bool green;
    bool blue;
};

void setStaticColor(StaticColor color)
{
    RGB colorMap;

    switch (color)
    {
    case StaticColor::RED:
        colorMap = {LOW, HIGH, HIGH};
        break;
    case StaticColor::GREEN:
        colorMap = {HIGH, LOW, HIGH};
        break;
    case StaticColor::BLUE:
        colorMap = {HIGH, HIGH, LOW};
        break;
    case StaticColor::YELLOW:
        colorMap = {LOW, LOW, HIGH};
        break;
    case StaticColor::MAGENTA:
        colorMap = {LOW, HIGH, LOW};
        break;
    case StaticColor::CYAN:
        colorMap = {HIGH, LOW, LOW};
        break;
    default:
        colorMap = {HIGH, HIGH, HIGH};
        break;
    }

    ledPinWrite(RED_LED_PIN, colorMap.red);
    ledPinWrite(GREEN_LED_PIN, colorMap.green);
    ledPinWrite(BLUE_LED_PIN, colorMap.blue);
}

void loopCyanPinkYellow()
{
    // Cyan (Green + Blue)
    ledPinWrite(RED_LED_PIN, LOW);
    ledPinWrite(GREEN_LED_PIN, HIGH);
    ledPinWrite(BLUE_LED_PIN, HIGH);
    delay(500);

    // Pink (Red + Blue)
    ledPinWrite(RED_LED_PIN, HIGH);
    ledPinWrite(GREEN_LED_PIN, LOW);
    ledPinWrite(BLUE_LED_PIN, HIGH);
    delay(500);

    // Yellow (Red + Green)
    ledPinWrite(RED_LED_PIN, HIGH);
    ledPinWrite(GREEN_LED_PIN, HIGH);
    ledPinWrite(BLUE_LED_PIN, LOW);
    delay(500);
}

void pulseWhite()
{
    setLEDColor(brightness, brightness, brightness);
    brightness += fadeAmount;
    if (brightness <= 0 || brightness >= 255) // Changed from 255 to 128
    {
        fadeAmount = -fadeAmount;
    }
}

void pulseMagenta()
{
    setLEDColor(brightness, 0, brightness);
    brightness += fadeAmount;
    if (brightness <= 0 || brightness >= 255) // Changed from 255 to 128
    {
        fadeAmount = -fadeAmount;
    }
}

void pulseYellow()
{
    setLEDColor(brightness, brightness, 0);
    brightness += fadeAmount;
    if (brightness <= 0 || brightness >= 255) // Changed from 255 to 128
    {
        fadeAmount = -fadeAmount;
    }
}

void pulseBlue()
{
    setLEDColor(0, 0, brightness);
    brightness += fadeAmount;
    if (brightness <= 0 || brightness >= 255) // Changed from 255 to 128
    {
        fadeAmount = -fadeAmount;
    }
}

void blinkWhite()
{
    int out = ledState ? HIGH : LOW;
    ledPinWrite(RED_LED_PIN, out);
    ledPinWrite(GREEN_LED_PIN, out);
    ledPinWrite(BLUE_LED_PIN, out);
}

void blinkGreen()
{
    int out = ledState ? HIGH : LOW;
    ledPinWrite(BLUE_LED_PIN, LOW);
    ledPinWrite(RED_LED_PIN, LOW);   
    ledPinWrite(GREEN_LED_PIN, out);    
}

void blinkYellow()
{
    int out = ledState ? HIGH : LOW;
    ledPinWrite(BLUE_LED_PIN, LOW);
    ledPinWrite(RED_LED_PIN, out);
    ledPinWrite(GREEN_LED_PIN, out);    
}

void turnOffLED()
{
    ledPinWrite(RED_LED_PIN, LOW);
    ledPinWrite(GREEN_LED_PIN, LOW);
    ledPinWrite(BLUE_LED_PIN, LOW);
}

void turnOnLED()
{
    ledPinWrite(RED_LED_PIN, HIGH);
    ledPinWrite(GREEN_LED_PIN, HIGH);
    ledPinWrite(BLUE_LED_PIN, HIGH);
}

void setupRGBLED()
{
    // No-op where the LED is discrete; brings up the RMT channel on a ring.
    ledRingBegin();

    ledPinMode(RED_LED_PIN);
    ledPinMode(GREEN_LED_PIN);
    ledPinMode(BLUE_LED_PIN);
    turnOffLED(); // Turn off the LED initially
}

void blinkCyanPulse()
{
    ledPinAnalog(GREEN_LED_PIN, brightness);
    ledPinAnalog(BLUE_LED_PIN, brightness);

    brightness += fadeAmount;
    if (brightness <= 0 || brightness >= 255)
    {
        fadeAmount = -fadeAmount;
    }
}


void blinkBlue()
{
    int out = ledState ? HIGH : LOW;
    ledPinWrite(GREEN_LED_PIN, LOW);
    ledPinWrite(RED_LED_PIN, LOW);   
    ledPinWrite(BLUE_LED_PIN, out); 
}

void staticYellow()
{
    ledPinWrite(BLUE_LED_PIN, LOW);
    ledPinWrite(RED_LED_PIN, HIGH);
    ledPinWrite(GREEN_LED_PIN, HIGH);
}

static const uint8_t colorSequence[][3] = {
    {0, 255, 255}, // Cyan   (R=0,   G=255, B=255)
    {255, 0, 255}, // Pink   (R=255, G=0,   B=255)
    {255, 255, 0}, // Yellow (R=255, G=255, B=0)
};

static const int NUM_COLORS = sizeof(colorSequence) / sizeof(colorSequence[0]);

void loopCyanPinkYellowPulse(unsigned long currentTime)
{
    // Duration of each color fade
    const unsigned long transitionDuration = 1000; // 500 ms per fade

    // colorIndex = which color in colorSequence we’re currently *starting* from
    static int colorIndex = 0;

    // We'll store the "start color" and "end color" for the current fade
    static uint8_t startColor[3];
    static uint8_t endColor[3];

    // The timestamp at which the current fade *started*
    static unsigned long transitionStartTime = 0;

    // A flag so we can initialize the first fade
    static bool initialized = false;

    if (!initialized)
    {
        // On the very first call, set the starting color to colorSequence[0]
        // and the endColor to the next color in the array
        memcpy(startColor, colorSequence[colorIndex], 3);
        int nextIndex = (colorIndex + 1) % NUM_COLORS;
        memcpy(endColor, colorSequence[nextIndex], 3);

        transitionStartTime = currentTime;
        initialized = true;
    }

    // How long has this transition been running?
    unsigned long elapsed = currentTime - transitionStartTime;
    float t = (float)elapsed / (float)transitionDuration;
    if (t > 1.0f)
    {
        t = 1.0f; // clamp
    }

    // Interpolate each channel: R, G, B
    uint8_t r = startColor[0] + (endColor[0] - startColor[0]) * t;
    uint8_t g = startColor[1] + (endColor[1] - startColor[1]) * t;
    uint8_t b = startColor[2] + (endColor[2] - startColor[2]) * t;

    // Write these values to your LED pins
    ledPinAnalog(RED_LED_PIN, r);
    ledPinAnalog(GREEN_LED_PIN, g);
    ledPinAnalog(BLUE_LED_PIN, b);

    // Check if this transition has finished
    if (elapsed >= transitionDuration)
    {
        // Move to next color in the sequence
        colorIndex = (colorIndex + 1) % NUM_COLORS;
        memcpy(startColor, endColor, 3); // old 'end' becomes new 'start'

        int nextIndex = (colorIndex + 1) % NUM_COLORS;
        memcpy(endColor, colorSequence[nextIndex], 3);

        transitionStartTime = currentTime; // reset the clock for the next fade
    }
}

static volatile unsigned long flashUntilMs = 0;

void ledFlash(unsigned ms) { flashUntilMs = millis() + ms; }

void ledTask(void *parameter)
{
    setupRGBLED();
    unsigned long currentTime = 0;
    while (1)
    {
        currentTime += 20; // Track time based on vTaskDelay

        // Signed difference so a millis() rollover cannot leave the flash stuck
        // on, and so the initial 0 reads as long expired rather than far future.
        if ((long)(flashUntilMs - millis()) > 0)
        {
            // Every channel on, which is white on the ring and white on the
            // discrete LED. LOW is what lights a channel here -- the part is
            // common-anode, which is also why turnOffLED() below lights it.
            ledPinWrite(RED_LED_PIN, LOW);
            ledPinWrite(GREEN_LED_PIN, LOW);
            ledPinWrite(BLUE_LED_PIN, LOW);
            vTaskDelay(20 / portTICK_PERIOD_MS);
            continue;
        }

        // Toggle LED state every 200ms for blinking functions
        if (currentTime - lastToggle >= 200)
        {
            ledState = !ledState;
            lastToggle = currentTime;
        }

        switch (deviceState)
        {
        case IDLE:
            if (deviceUnclaimed) {
                // Nobody owns this board yet, so it cannot talk: a slow
                // magenta blink, next to the steady magenta of WiFi setup.
                if ((currentTime / 600) % 2) {
                    setStaticColor(StaticColor::MAGENTA);
                } else {
                    turnOnLED();  // common anode: all HIGH is off
                }
                break;
            }
            // No session for a while (ServerReach.cpp): a slow blink, so it
            // never reads as the steady colours of a working toy. Cyan while
            // it is getting back on (OTA's colour, also "the network"),
            // yellow when the internet works and our server does not.
            if (serverReachStatus() != NET_OK) {
                if ((currentTime / 600) % 2) {
                    setStaticColor(serverReachStatus() == NET_SERVER_DOWN ? StaticColor::YELLOW
                                                                          : StaticColor::CYAN);
                } else {
                    turnOnLED();  // common anode: all HIGH is off
                }
                break;
            }
            // Red instead of green once the battery is nearly flat. Only
            // boards with BOARD_LOW_BATTERY_VIA_VDD ever report low.
            setStaticColor(supplyLow() ? StaticColor::RED : StaticColor::GREEN);
            break;
        case SOFT_AP:
            setStaticColor(StaticColor::MAGENTA);
            break;
        case PROCESSING:
            setStaticColor(StaticColor::RED);
            break;
        case SPEAKING:
            setStaticColor(StaticColor::BLUE);
            break;
        case LISTENING:
            setStaticColor(StaticColor::YELLOW);
            break;
        case OTA:
            setStaticColor(StaticColor::CYAN);
            break;
#if BOARD_HAS_WS2812_RING
        case SLEEP:
            // A WS2812 holds the last colour it was sent for as long as it has
            // power, so a sleeping board would stay lit green. enterSleep()'s
            // digitalWrite()s only reach discrete LEDs.
            setLEDColor(0, 0, 0);
            break;
#endif
        default:
            setStaticColor(StaticColor::GREEN); // LED on
            break;
        }

        // Delay for smoother LED transitions
        vTaskDelay(20 / portTICK_PERIOD_MS); // Approximate the delay from the original `pulsateLED()`
    }
}
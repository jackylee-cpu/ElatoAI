#include "IoExpander.h"
#include <Wire.h>
#include "Battery.h"
#include "Codec.h"
#include "LedRing.h"

// Defined in Audio.cpp and declared in Audio.h, but that header pulls in the
// whole of AudioTools for one int.
extern const int BITS_PER_SAMPLE;

#if BOARD_HAS_IO_EXPANDER

namespace {

// TCA9555 register map. Ports are 8 bits each; "pin 8" in the board
// documentation is port 1 bit 0.
constexpr uint8_t kAddress       = 0x20;
constexpr uint8_t kRegInput0     = 0x00;
constexpr uint8_t kRegInput1     = 0x01;
constexpr uint8_t kRegOutput0    = 0x02;
constexpr uint8_t kRegOutput1    = 0x03;
constexpr uint8_t kRegConfig0    = 0x06;
constexpr uint8_t kRegConfig1    = 0x07;

// Port 1 bit assignments.
constexpr uint8_t kBitPaEnable   = 0;  // P10, NS4150B enable, active high
constexpr uint8_t kBitKey1       = 1;  // P11
constexpr uint8_t kBitKey2       = 2;  // P12
constexpr uint8_t kBitKey3       = 3;  // P13

// Config registers use 1 = input, 0 = output. Port 0 is left entirely as
// inputs: it carries the LCD, touch, SD and camera controls, none of which
// this firmware drives, and driving a reset line the wrong way would be worse
// than leaving it floating at its board default.
constexpr uint8_t kConfig0       = 0xFF;
constexpr uint8_t kConfig1       = (uint8_t)~(1u << kBitPaEnable);

// Shadow of the output register. The expander has no way to read back what an
// output pin is driving -- the input register reports the pin, which for an
// output is whatever it is already driving -- so a read-modify-write would
// work, but keeping the shadow means one transaction instead of two and no
// chance of a floating input bit leaking into an output.
uint8_t outputPort1 = 0;

bool present = false;
SemaphoreHandle_t mutex = nullptr;

bool writeRegister(uint8_t reg, uint8_t value) {
    Wire.beginTransmission(kAddress);
    Wire.write(reg);
    Wire.write(value);
    return Wire.endTransmission() == 0;
}

bool readRegister(uint8_t reg, uint8_t &value) {
    Wire.beginTransmission(kAddress);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom((int)kAddress, 1) != 1) return false;
    value = Wire.read();
    return true;
}

}  // namespace

bool boardI2CBegin() {
    static bool started = false;
    if (started) return present;
    started = true;

    mutex = xSemaphoreCreateMutex();
    Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, 400000);

    // Amplifier off before its pin becomes an output, so enabling the driver
    // cannot put a step through the speaker.
    outputPort1 = 0;
    present = writeRegister(kRegOutput1, outputPort1) &&
              writeRegister(kRegConfig1, kConfig1) &&
              writeRegister(kRegConfig0, kConfig0);

    Serial.printf("TCA9555 at 0x%02X: %s\n", kAddress, present ? "ok" : "NOT FOUND");
    return present;
}

bool ioExpanderPresent() { return present; }

void boardSetSpeakerAmp(bool enabled) {
    if (!present || mutex == nullptr) return;
    xSemaphoreTake(mutex, portMAX_DELAY);
    if (enabled) {
        outputPort1 |= (1u << kBitPaEnable);
    } else {
        outputPort1 &= ~(1u << kBitPaEnable);
    }
    writeRegister(kRegOutput1, outputPort1);
    xSemaphoreGive(mutex);
}

bool ioExpanderReadKeys(bool &key1, bool &key2, bool &key3) {
    if (!present || mutex == nullptr) return false;
    uint8_t port1 = 0;
    xSemaphoreTake(mutex, portMAX_DELAY);
    bool ok = readRegister(kRegInput1, port1);
    xSemaphoreGive(mutex);
    if (!ok) return false;

    // Keys pull their line to ground, so a pressed key reads low.
    key1 = (port1 & (1u << kBitKey1)) == 0;
    key2 = (port1 & (1u << kBitKey2)) == 0;
    key3 = (port1 & (1u << kBitKey3)) == 0;
    return true;
}

#else  // no expander on this board

bool boardI2CBegin() {
    static bool started = false;
    if (started) return false;
    started = true;
    Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, 400000);
    return false;
}

bool ioExpanderPresent() { return false; }

void boardSetSpeakerAmp(bool enabled) {
    // The kit does not break out the MAX98357A SD pin, so this drives a spare
    // GPIO and the amplifier is always on; kept so callers stay board-agnostic.
    if (I2S_SD_OUT >= 0) {
        pinMode(I2S_SD_OUT, OUTPUT);
        digitalWrite(I2S_SD_OUT, enabled ? HIGH : LOW);
    }
}

bool ioExpanderReadKeys(bool &, bool &, bool &) { return false; }

#endif

void boardReport() {
    Serial.printf("(replay) Board: %s\n", BOARD_NAME);
#if BOARD_HAS_IO_EXPANDER
    Serial.printf("(replay) TCA9555 0x%02X: %s | amp enable P1%d\n", kAddress,
                  ioExpanderPresent() ? "ok" : "NOT FOUND", kBitPaEnable);
#endif
#if BOARD_HAS_CODEC && BOARD_HAS_ES7210
    Serial.printf("(replay) Codec: ES8311 %s, ES7210 %s | %luHz/%dbit, MCLK GPIO%d\n",
                  codecDacReady() ? "ok" : "FAILED",
                  codecAdcReady() ? "ok" : "FAILED",
                  (unsigned long)SAMPLE_RATE, BITS_PER_SAMPLE, I2S_MCLK_OUT);
#elif BOARD_HAS_CODEC
    Serial.printf("(replay) Codec: ES8311 %s (DAC + ADC) | %luHz/%dbit, MCLK GPIO%d, amp GPIO%d\n",
                  codecDacReady() ? "ok" : "FAILED",
                  (unsigned long)SAMPLE_RATE, BITS_PER_SAMPLE, I2S_MCLK_OUT, I2S_SD_OUT);
#endif
#if BOARD_HAS_WS2812_RING
    Serial.printf("(replay) WS2812 ring GPIO%d: %s, %d pixels\n", LED_RING_PIN,
                  ledRingReady() ? "ok" : "FAILED", BOARD_WS2812_COUNT);
#endif
#if BOARD_HAS_BATTERY
    Serial.printf("(replay) Battery: ADC GPIO%d, charge GPIO%d | %s, %d%%, %s\n",
                  BATTERY_ADC_PIN, CHARGE_DETECT_PIN,
                  batteryPresent() ? "present" : "not connected", batteryPercent(),
                  batteryCharging() ? "charging" : "not charging");
#endif
#if BOARD_SHARED_I2S_BUS
    Serial.printf("(replay) I2S port %d full duplex: out GPIO%d, in GPIO%d, "
                  "BCLK %d, LRCK %d | spk %luHz, mic %luHz\n",
                  (int)I2S_PORT_OUT, I2S_DATA_OUT, I2S_SD, I2S_BCK_OUT, I2S_WS_OUT,
                  (unsigned long)SAMPLE_RATE, (unsigned long)MIC_SAMPLE_RATE);
#else
    Serial.printf("(replay) I2S: out port %d GPIO%d, in port %d GPIO%d | "
                  "spk %luHz, mic %luHz\n",
                  (int)I2S_PORT_OUT, I2S_DATA_OUT, (int)I2S_PORT_IN, I2S_SD,
                  (unsigned long)SAMPLE_RATE, (unsigned long)MIC_SAMPLE_RATE);
#endif
}


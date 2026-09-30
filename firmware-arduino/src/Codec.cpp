#include "Codec.h"

#if BOARD_HAS_CODEC

#include <Wire.h>

namespace {

constexpr uint8_t kEs8311Address = 0x18;
constexpr uint8_t kEs7210Address = 0x40;

// Both chips are clocked from MCLK at this multiple of the sample rate. 256 is
// what the ESP32 legacy I2S driver emits when mclk_multiple is left at its
// default, and it is the one multiple for which both coefficient tables below
// have an entry at 16kHz.
constexpr uint32_t kMclkMultiple = 256;

bool writeReg(uint8_t address, uint8_t reg, uint8_t value) {
    Wire.beginTransmission(address);
    Wire.write(reg);
    Wire.write(value);
    return Wire.endTransmission() == 0;
}

bool readReg(uint8_t address, uint8_t reg, uint8_t &value) {
    Wire.beginTransmission(address);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom((int)address, 1) != 1) return false;
    value = Wire.read();
    return true;
}

bool updateBits(uint8_t address, uint8_t reg, uint8_t mask, uint8_t value) {
    uint8_t current = 0;
    if (!readReg(address, reg, current)) return false;
    current = (current & ~mask) | (mask & value);
    return writeReg(address, reg, current);
}

// ---------------- ES8311 ----------------

struct Es8311Coefficient {
    uint32_t mclk;
    uint32_t rate;
    uint8_t pre_div;
    uint8_t pre_mult;
    uint8_t adc_div;
    uint8_t dac_div;
    uint8_t fs_mode;
    uint8_t lrck_h;
    uint8_t lrck_l;
    uint8_t bclk_div;
    uint8_t adc_osr;
    uint8_t dac_osr;
};

// Only the rates this firmware can actually run are listed, all at 256 x fs,
// copied from esp_codec_dev's es8311.c. 24kHz is here for the xmini-c3, whose
// ES8311 is alone on its bus. The Waveshare board cannot use it: the ES7210
// table has no 24kHz entry at 256 x fs -- its only 24kHz row is at 512 x fs --
// so that shared bus stays at 16kHz; see SAMPLE_RATE in Config.cpp.
const Es8311Coefficient kEs8311Coefficients[] = {
    // mclk      rate   pre_div pre_mult adc_div dac_div fs  lrck_h lrck_l bclk adc_osr dac_osr
    { 4096000,  16000,  0x01,   0x01,    0x01,   0x01,   0x00, 0x00, 0xff,  0x04, 0x10,  0x20},
    { 6144000,  24000,  0x01,   0x01,    0x01,   0x01,   0x00, 0x00, 0xff,  0x04, 0x10,  0x10},
    {12288000,  48000,  0x01,   0x01,    0x01,   0x01,   0x00, 0x00, 0xff,  0x04, 0x10,  0x10},
};

const Es8311Coefficient *findEs8311Coefficient(uint32_t mclk, uint32_t rate) {
    for (const auto &c : kEs8311Coefficients) {
        if (c.mclk == mclk && c.rate == rate) return &c;
    }
    return nullptr;
}

uint8_t es8311ResolutionBits(int bitsPerSample) {
    switch (bitsPerSample) {
    case 16: return (3 << 2);
    case 18: return (2 << 2);
    case 20: return (1 << 2);
    case 24: return (0 << 2);
    case 32: return (4 << 2);
    default: return (3 << 2);
    }
}

bool es8311Begin(uint32_t sampleRate, int bitsPerSample) {
    const uint32_t mclk = sampleRate * kMclkMultiple;
    const Es8311Coefficient *coeff = findEs8311Coefficient(mclk, sampleRate);
    if (coeff == nullptr) {
        Serial.printf("ES8311: no coefficients for %luHz at %luHz MCLK\n",
                      (unsigned long)sampleRate, (unsigned long)mclk);
        return false;
    }

    // Reset, then release.
    if (!writeReg(kEs8311Address, 0x00, 0x1F)) {
        Serial.println("ES8311: not responding at 0x18");
        return false;
    }
    writeReg(kEs8311Address, 0x00, 0x00);

    // Filters I2C glitches. esp_codec_dev writes it first, and twice, because
    // the first write after power-up occasionally does not take.
    writeReg(kEs8311Address, 0x44, 0x08);
    writeReg(kEs8311Address, 0x44, 0x08);

    // 0x01: enable every internal clock and take the master clock from the MCLK
    // pin. Bit 7 would select BCLK as the clock source instead, which this board
    // does not need because MCLK is wired.
    writeReg(kEs8311Address, 0x01, 0x3F);

    // System and analog reference setup, from esp_codec_dev's es8311_open() --
    // what xiaozhi runs on the xmini-c3. These were missing, which left the
    // analog references at their reset values.
    writeReg(kEs8311Address, 0x0B, 0x00);
    writeReg(kEs8311Address, 0x0C, 0x00);
    writeReg(kEs8311Address, 0x10, 0x1F);
    writeReg(kEs8311Address, 0x11, 0x7F);

    // pre_mult in the table is the multiplier itself (1, 2, 4, 8); the
    // register field wants its log2. Writing the table value straight in, as
    // this used to, turned x1 into x2 and ran the chip's internal clock at
    // 512 x fs against coefficients for 256 x fs.
    uint8_t preMultBits = 0;
    switch (coeff->pre_mult) {
    case 2: preMultBits = 1; break;
    case 4: preMultBits = 2; break;
    case 8: preMultBits = 3; break;
    default: preMultBits = 0; break;
    }
    uint8_t reg02 = 0;
    readReg(kEs8311Address, 0x02, reg02);
    reg02 &= 0x07;
    reg02 |= (uint8_t)((coeff->pre_div - 1) << 5);
    reg02 |= (uint8_t)(preMultBits << 3);
    writeReg(kEs8311Address, 0x02, reg02);

    writeReg(kEs8311Address, 0x03, (uint8_t)((coeff->fs_mode << 6) | coeff->adc_osr));
    writeReg(kEs8311Address, 0x04, coeff->dac_osr);
    writeReg(kEs8311Address, 0x05,
             (uint8_t)(((coeff->adc_div - 1) << 4) | (coeff->dac_div - 1)));

    uint8_t reg06 = 0;
    readReg(kEs8311Address, 0x06, reg06);
    reg06 &= 0xE0;
    reg06 &= ~(uint8_t)(1 << 5);  // do not invert BCLK
    reg06 |= (coeff->bclk_div < 19) ? (uint8_t)(coeff->bclk_div - 1) : coeff->bclk_div;
    writeReg(kEs8311Address, 0x06, reg06);

    uint8_t reg07 = 0;
    readReg(kEs8311Address, 0x07, reg07);
    reg07 &= 0xC0;
    reg07 |= coeff->lrck_h;
    writeReg(kEs8311Address, 0x07, reg07);
    writeReg(kEs8311Address, 0x08, coeff->lrck_l);

    // Secondary (slave) mode: the ESP32 drives BCLK and LRCK.
    uint8_t reg00 = 0;
    readReg(kEs8311Address, 0x00, reg00);
    writeReg(kEs8311Address, 0x00, (uint8_t)(reg00 & 0xBF));

    const uint8_t resolution = es8311ResolutionBits(bitsPerSample);
    writeReg(kEs8311Address, 0x09, resolution);  // SDP in  (what the DAC reads)
    writeReg(kEs8311Address, 0x0A, resolution);  // SDP out (ADC, unused here)

    // ADC path. On the Waveshare board nothing is wired to it -- the
    // microphones go through the ES7210 -- but these are part of the known-good
    // power-up sequence, so they stay. On the xmini-c3 this *is* the
    // microphone: 0x14 selects MIC1P/MIC1N with the analog PGA at 30dB, and
    // 0x16 is the digital gain set below.
    writeReg(kEs8311Address, 0x14, 0x1A);
    writeReg(kEs8311Address, 0x16, 0x03);
    writeReg(kEs8311Address, 0x17, 0xC8);

    codecSetDacGainDb(BOARD_DAC_GAIN_DB);

    writeReg(kEs8311Address, 0x0D, 0x01);  // power up analog
    writeReg(kEs8311Address, 0x0E, 0x02);  // enable analog PGA and ADC modulator
    writeReg(kEs8311Address, 0x12, 0x00);  // power up DAC
    writeReg(kEs8311Address, 0x13, 0x10);  // enable output to the headphone driver
    writeReg(kEs8311Address, 0x15, 0x40);  // ADC ramp rate
    writeReg(kEs8311Address, 0x1B, 0x0A);  // ADC high-pass filter
    writeReg(kEs8311Address, 0x1C, 0x6A);  // bypass ADC EQ, cancel DC offset
    writeReg(kEs8311Address, 0x37, 0x08);  // bypass DAC EQ
    writeReg(kEs8311Address, 0x45, 0x00);
    writeReg(kEs8311Address, 0x00, 0x80);  // power on

#if !BOARD_HAS_ES7210
    // xiaozhi runs this board at 30dB (AUDIO_CODEC_DEFAULT_MIC_GAIN), and here
    // that clipped: peaks of 32852 on ordinary speech and 33052 on a press
    // with nobody talking, a silent room averaging 465 (2026-09-24). 24dB
    // halves every level; see MIC_VOICE_LEVEL in Audio.cpp, tuned against it.
    codecSetMicGain(24.0f);
#endif

    return true;
}

#if BOARD_HAS_ES7210

// ---------------- ES7210 ----------------

struct Es7210Coefficient {
    uint32_t mclk;
    uint32_t rate;
    uint8_t ss_ds;
    uint8_t adc_div;
    uint8_t dll;
    uint8_t doubler;
    uint8_t osr;
    uint8_t mclk_src;
    uint8_t lrck_h;
    uint8_t lrck_l;
};

const Es7210Coefficient kEs7210Coefficients[] = {
    // mclk      rate   ss_ds adc_div dll  doubler osr  mclk_src lrck_h lrck_l
    { 4096000,  16000, 0x00, 0x01,   0x01, 0x01,  0x20, 0x00,   0x01,  0x00},
    {12288000,  48000, 0x00, 0x01,   0x01, 0x01,  0x20, 0x00,   0x01,  0x00},
};

const Es7210Coefficient *findEs7210Coefficient(uint32_t mclk, uint32_t rate) {
    for (const auto &c : kEs7210Coefficients) {
        if (c.mclk == mclk && c.rate == rate) return &c;
    }
    return nullptr;
}

uint8_t es7210GainRegValue(float gainDb) {
    gainDb += 0.5f;
    if (gainDb <= 33.0f) return (uint8_t)(gainDb / 3.0f);
    if (gainDb < 36.0f) return 12;
    if (gainDb < 37.0f) return 13;
    return 14;
}

uint8_t es7210ResolutionBits(int bitsPerSample) {
    switch (bitsPerSample) {
    case 16: return 0x60;
    case 18: return 0x40;
    case 20: return 0x20;
    case 24: return 0x00;
    case 32: return 0x80;
    default: return 0x60;
    }
}

bool es7210Begin(uint32_t sampleRate, int bitsPerSample) {
    const uint32_t mclk = sampleRate * kMclkMultiple;
    const Es7210Coefficient *coeff = findEs7210Coefficient(mclk, sampleRate);
    if (coeff == nullptr) {
        Serial.printf("ES7210: no coefficients for %luHz at %luHz MCLK\n",
                      (unsigned long)sampleRate, (unsigned long)mclk);
        return false;
    }

    if (!writeReg(kEs7210Address, 0x00, 0xFF)) {
        Serial.println("ES7210: not responding at 0x40");
        return false;
    }
    writeReg(kEs7210Address, 0x00, 0x32);
    writeReg(kEs7210Address, 0x01, 0x3F);  // all ADC clocks off while configuring

    writeReg(kEs7210Address, 0x09, 0x30);  // chip initial state period
    writeReg(kEs7210Address, 0x0A, 0x30);  // power-up state period

    // High-pass filters on all four channels. The board only populates two
    // microphones, but powering and filtering all four matches the reference
    // driver and costs nothing.
    writeReg(kEs7210Address, 0x23, 0x2A);
    writeReg(kEs7210Address, 0x22, 0x0A);
    writeReg(kEs7210Address, 0x20, 0x0A);
    writeReg(kEs7210Address, 0x21, 0x2A);

    updateBits(kEs7210Address, 0x08, 0x01, 0x00);  // secondary (slave) I2S mode

    writeReg(kEs7210Address, 0x40, 0xC3);  // analog power
    writeReg(kEs7210Address, 0x41, 0x70);  // mic 1/2 bias
    writeReg(kEs7210Address, 0x42, 0x70);  // mic 3/4 bias

    writeReg(kEs7210Address, 0x11, es7210ResolutionBits(bitsPerSample));
    // Not TDM: microphones 1 and 2 come out on SDOUT1, which is the only data
    // line wired to the ESP32. Mics 1 and 2 land in the left and right slots of
    // an ordinary stereo I2S frame.
    writeReg(kEs7210Address, 0x12, 0x00);

    // Clock dividers.
    uint8_t reg02 = (uint8_t)(coeff->adc_div | (coeff->doubler << 6) | (coeff->dll << 7));
    writeReg(kEs7210Address, 0x02, reg02);
    writeReg(kEs7210Address, 0x07, coeff->osr);
    writeReg(kEs7210Address, 0x04, coeff->lrck_h);
    writeReg(kEs7210Address, 0x05, coeff->lrck_l);

    codecSetMicGain(30.0f);

    writeReg(kEs7210Address, 0x47, 0x08);  // power on mic 1
    writeReg(kEs7210Address, 0x48, 0x08);
    writeReg(kEs7210Address, 0x49, 0x08);
    writeReg(kEs7210Address, 0x4A, 0x08);
    writeReg(kEs7210Address, 0x06, 0x04);  // power down DLL
    writeReg(kEs7210Address, 0x4B, 0x0F);  // mic 1/2 bias, ADC and PGA on
    writeReg(kEs7210Address, 0x4C, 0x0F);
    writeReg(kEs7210Address, 0x00, 0x71);  // enable
    writeReg(kEs7210Address, 0x00, 0x41);

    return true;
}

#endif  // BOARD_HAS_ES7210

}  // namespace

namespace {
bool lastDacOk = false;
bool lastAdcOk = false;
}  // namespace

bool codecDacReady() { return lastDacOk; }
bool codecAdcReady() { return lastAdcOk; }

bool codecBegin(uint32_t sampleRate, int bitsPerSample) {
    const bool dacOk = es8311Begin(sampleRate, bitsPerSample);
#if BOARD_HAS_ES7210
    const bool adcOk = es7210Begin(sampleRate, bitsPerSample);
    Serial.printf("Codec @ %luHz/%dbit: ES8311 %s, ES7210 %s\n",
                  (unsigned long)sampleRate, bitsPerSample,
                  dacOk ? "ok" : "FAILED", adcOk ? "ok" : "FAILED");
#else
    // One chip, both directions: the ADC is ready exactly when the DAC is.
    const bool adcOk = dacOk;
    Serial.printf("Codec @ %luHz/%dbit: ES8311 %s (DAC + ADC)\n",
                  (unsigned long)sampleRate, bitsPerSample, dacOk ? "ok" : "FAILED");
#endif
    lastDacOk = dacOk;
    lastAdcOk = adcOk;
    return dacOk && adcOk;
}

bool codecSetDacGainDb(float db) {
    // 0xBF is 0dB; each step either side is 0.5dB.
    int reg = 0xBF + (int)lroundf(db * 2.0f);
    if (reg < 0) reg = 0;
    if (reg > 0xFF) reg = 0xFF;
    return writeReg(kEs8311Address, 0x32, (uint8_t)reg);
}

#if !BOARD_HAS_ES7210

// The ES8311's digital ADC gain, 0x16, in 6dB steps from 0 to 42dB -- the same
// mapping esp_codec_dev uses, so 30dB here is what xiaozhi ran this mic at.
bool codecSetMicGain(float gainDb) {
    if (gainDb < 0.0f) gainDb = 0.0f;
    if (gainDb > 42.0f) gainDb = 42.0f;
    return writeReg(kEs8311Address, 0x16, (uint8_t)(gainDb / 6.0f));
}

#else

bool codecSetMicGain(float gainDb) {
    if (gainDb < 0.0f) gainDb = 0.0f;
    if (gainDb > 37.5f) gainDb = 37.5f;
    const uint8_t gain = es7210GainRegValue(gainDb);

    for (uint8_t i = 0; i < 4; i++) {
        updateBits(kEs7210Address, (uint8_t)(0x43 + i), 0x10, 0x00);
    }
    writeReg(kEs7210Address, 0x4B, 0xFF);
    writeReg(kEs7210Address, 0x4C, 0xFF);

    // Mics 1 and 2 share one clock domain, 3 and 4 another; each has to be
    // ungated before its gain register will take.
    updateBits(kEs7210Address, 0x01, 0x0B, 0x00);
    writeReg(kEs7210Address, 0x4B, 0x00);
    updateBits(kEs7210Address, 0x43, 0x10, 0x10);
    updateBits(kEs7210Address, 0x43, 0x0F, gain);

    updateBits(kEs7210Address, 0x01, 0x0B, 0x00);
    writeReg(kEs7210Address, 0x4B, 0x00);
    updateBits(kEs7210Address, 0x44, 0x10, 0x10);
    updateBits(kEs7210Address, 0x44, 0x0F, gain);

    updateBits(kEs7210Address, 0x01, 0x15, 0x00);
    writeReg(kEs7210Address, 0x4C, 0x00);
    updateBits(kEs7210Address, 0x45, 0x10, 0x10);
    updateBits(kEs7210Address, 0x45, 0x0F, gain);

    updateBits(kEs7210Address, 0x01, 0x15, 0x00);
    writeReg(kEs7210Address, 0x4C, 0x00);
    updateBits(kEs7210Address, 0x46, 0x10, 0x10);
    updateBits(kEs7210Address, 0x46, 0x0F, gain);

    return true;
}

#endif  // BOARD_HAS_ES7210

#else  // no codec on this board

bool codecBegin(uint32_t, int) { return true; }
bool codecDacReady() { return false; }
bool codecAdcReady() { return false; }
bool codecSetDacGainDb(float) { return true; }
bool codecSetMicGain(float) { return true; }

#endif

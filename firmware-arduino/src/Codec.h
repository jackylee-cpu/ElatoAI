#ifndef CODEC_H
#define CODEC_H

#include "Config.h"

// ES8311 (DAC, 0x18) and ES7210 (4-channel ADC, 0x40) on the Waveshare audio
// board; the ES8311 alone, using its own ADC for the microphone, on the
// xmini-c3. Both hang off the same I2S bus and the same I2C bus, and neither
// produces or accepts a sample until its registers have been written -- unlike
// the raw mic and the MAX98357A on the breadboard kit, which need no setup at
// all. Everything here compiles to nothing on boards without a codec.
//
// Register sequences follow ESPHome's es8311 and es7210 components, which are
// in turn derived from Espressif's ESP-ADF drivers. Do not reorder the writes:
// the power-up steps at the end of each sequence depend on the clock and
// format registers already being set.

// Configures both chips for `sampleRate` and `bitsPerSample`.
//
// MUST be called after the I2S port has started, not before: the ES8311 locks
// its internal DLL to MCLK, and MCLK does not exist until the I2S driver is
// running. Assumes MCLK is 256 x sampleRate, which is what the I2S driver
// produces when mclk_multiple is left at its default.
//
// Returns false if either chip failed to answer, in which case the board is
// silent and deaf but the rest of the firmware still runs.
bool codecBegin(uint32_t sampleRate, int bitsPerSample);

// What the last codecBegin() achieved. Kept because setup()'s own output does
// not survive USB CDC enumeration on these boards, so the only place this can
// usefully be reported is the replay in loop(). Both false where there is no
// codec.
bool codecDacReady();
bool codecAdcReady();

// The ES8311's DAC volume in dB, 0.5dB steps from -95.5 to +32. This is the
// codec's own attenuation, downstream of the software VolumeStream the rest
// of the firmware uses; codecBegin() sets it to BOARD_DAC_GAIN_DB.
bool codecSetDacGainDb(float db);

// Microphone gain, in dB. The ES7210 quantises to 3dB steps up to 33dB, then
// 34.5/36/37.5; the ES8311 alone (no ES7210) to 6dB steps up to 42dB.
bool codecSetMicGain(float gainDb);

#endif

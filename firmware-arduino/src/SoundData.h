#ifndef SOUNDDATA_H
#define SOUNDDATA_H

#include <stdint.h>

// The boot, sleep and low-battery sounds, as 16-bit mono PCM in flash. Generated from
// assets/*.wav by tools/wav_to_sound.py -- regenerate those rather than editing
// BootSoundData.cpp or SleepSoundData.cpp.
//
// The two run at different sample rates because the recordings need different
// bandwidth; the rate is defined alongside each table so the pair cannot drift.

extern const int16_t kBootSoundPcm[];
extern const unsigned kBootSoundFrames;
extern const int kBootSoundRate;

extern const int16_t kSleepSoundPcm[];
extern const unsigned kSleepSoundFrames;
extern const int kSleepSoundRate;

// Spoken, on boards that warn of a low battery (SupplyMonitor.h).
extern const int16_t kLowBatterySoundPcm[];
extern const unsigned kLowBatterySoundFrames;
extern const int kLowBatterySoundRate;

// Spoken when an OTA install starts: 「系統更新中，請稍候。」
extern const int16_t kOtaUpdateSoundPcm[];
extern const unsigned kOtaUpdateSoundFrames;
extern const int kOtaUpdateSoundRate;

#endif

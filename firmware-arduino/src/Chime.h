#ifndef CHIME_H
#define CHIME_H

// The boot and sleep sounds: two recordings held in flash as PCM (see
// SoundData.h) and written straight to I2S.
//
// Both install and uninstall the output port themselves, so they must run when
// nothing else owns it: the boot sound from audioStreamTask before it opens its
// own I2S, the sleep sound from enterSleep() once it has torn the drivers down.
// Keeping them off the shared pipeline is deliberate -- they cannot then be
// starved by it, and nothing about them depends on the network being up.

// Blocks its caller for the length of the sound (about 2.8s), but only its
// caller: it spends nearly all of that parked in i2s_write waiting on DMA, so
// setup() runs on and wifi associates underneath it.
void playBootChime();

// Blocks for about 2.0s, and here that is the point: deep sleep must not start
// until the amplifier has finished. Call it before the output pins are parked
// low -- it drives I2S_SD_OUT high and does not put it back.
void playSleepChime();

// The spoken low-battery reminder, about 2s. Like the boot sound it goes
// through the port audioStreamTask owns, so only that task may call it, and
// only while nothing else is playing. It switches the amplifier on for the
// length of the sound and off again.
void playLowBatteryReminder();

// 「系統更新中，請稍候。」, about 2.3s, as an OTA install starts (OTA.cpp asks
// for it; see otaTakeUpdatePrompt()). Same rules as the low-battery reminder.
void playOtaUpdatePrompt();

// A sound from the assets partition by name (P2-12), e.g. "wifi_ok". Same
// rules as the low-battery reminder: audioStreamTask only, nothing else
// playing. False, and silent, when the board has no such sound.
bool playAssetSound(const char *name);

#endif

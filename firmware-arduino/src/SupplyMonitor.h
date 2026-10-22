#ifndef SUPPLYMONITOR_H
#define SUPPLYMONITOR_H

#include "Config.h"

// A low-battery warning for boards that have a battery but cannot measure it
// (BOARD_LOW_BATTERY_VIA_VDD). It watches the chip's own 3.3V supply instead:
// that stays flat while the regulator has headroom and only sags once the cell
// is nearly empty, which is exactly when to warn. Everything here is a no-op
// on other boards, and supplyLow() is false there.

// Biases the sense pin, loads the reference and the run log from NVS, and
// takes a first reading. Call once from setup().
void supplyMonitorBegin();

// Takes a sample when one is due; cheap otherwise. Call from loop().
void supplyMonitorPoll();

// The warning state. Set once the supply has sagged; cleared only when it has
// clearly recovered, which in practice means the charger is plugged in.
bool supplyLow();

// True once for each spoken reminder that falls due, then false until the
// next. audioStreamTask asks while the device is idle and plays it.
bool supplyTakeReminder();

// Whether the supply is too low to start a firmware install (OTA.cpp): flagged
// low already, or under the low-battery line right now. percent and lowLine get
// the reading and the line as shares of the reference. False on other boards.
bool supplyTooLowForUpdate(float &percent, float &lowLine);

#endif

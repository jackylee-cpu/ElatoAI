#ifndef BATTERY_H
#define BATTERY_H

#include "Config.h"

// Battery level and charging state, on boards that wire them to the ESP32
// (BOARD_HAS_BATTERY). Everything here is a no-op elsewhere, and
// batteryPresent() is false, so callers need no guards.

// Configures the ADC input and the charge-detect pin. Call once from setup().
void batteryBegin();

// Takes a reading when one is due and updates the values below. Cheap when
// nothing is due; meant to be called from a task loop (the display task).
void batteryPoll();

// False when the board has no battery sense, or the ADC reads as nothing is
// connected (running from USB with no cell fitted). Hide the indicator then.
bool batteryPresent();

// 0..100. Only meaningful while batteryPresent().
int batteryPercent();

// The charger's own "charging" output. False where the board has none.
bool batteryCharging();

#endif

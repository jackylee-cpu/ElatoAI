#ifndef LEDHANDLER_H
#define LEDHANDLER_H

#include "Config.h"

void setLEDColor(uint8_t r, uint8_t g, uint8_t b);
void turnOffLED();
void turnOnLED();
void setupRGBLED();
void turnOnBlueLED();
void turnOnRedLEDFlash();
// Overrides the state colour with every channel on for `ms`, then lets the
// state colour come back. For acknowledging a press that changed nothing --
// the volume already being at its limit -- where there is no other way to tell
// the user the button worked.
//
// Safe to call from any task: it only stores a deadline, and ledTask does the
// driving.
void ledFlash(unsigned ms);

void ledTask(void *parameter);

#endif
#ifndef DISPLAY_H
#define DISPLAY_H

#include "Config.h"

// Optional status display on the I2C pins in Config.cpp. Everything here is a
// no-op when nothing answers on the bus, so a board without a panel behaves
// exactly as it did before.
void displaySetup();
void displayTask(void *parameter);

// Blank the panel before deep sleep. An OLED holds its last frame with no CPU
// behind it, so without this a sleeping device sits there showing READY.
void displaySleep();

#endif

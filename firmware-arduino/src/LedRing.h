#ifndef LEDRING_H
#define LEDRING_H

#include "Config.h"

// The Waveshare audio board has no discrete RGB LED. What it has is a ring of
// seven WS2812Bs on one data pin, which this drives as a single indicator:
// every pixel always shows the same colour, because everything LEDHandler
// expresses is a device state rather than a position on the ring.
//
// Driven straight from the RMT peripheral rather than through a LED library,
// so the build gains no dependency for what amounts to one 24-bit shift.
// Compiles to nothing on boards with a discrete LED.

void ledRingBegin();

// True once the RMT channel is up. False on boards with a discrete LED.
bool ledRingReady();

// Colour for the whole ring, 0-255 per channel, already gamma-free: these
// values go out as-is.
void ledRingSet(uint8_t r, uint8_t g, uint8_t b);

#endif

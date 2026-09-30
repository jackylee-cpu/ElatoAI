#ifndef IOEXPANDER_H
#define IOEXPANDER_H

#include "Config.h"

// TCA9555 16-bit I2C GPIO expander, at 0x20 on the Waveshare audio board.
//
// Two things this firmware needs are behind it rather than on a GPIO: the
// NS4150B speaker amplifier enable, and three of the four user keys. That
// makes the amplifier unavailable until I2C is up, which is why boardI2CBegin()
// has to run before anything tries to make a sound -- including the boot chime.
//
// Everything here is a no-op on boards without an expander, so callers do not
// need to guard their calls.

// Brings up Wire on the board's I2C pins and, where there is an expander,
// configures it. Safe to call more than once; the second call is a no-op.
// Returns false only if an expander was expected and did not answer.
bool boardI2CBegin();

// True once the expander has answered. Always false where there is none.
bool ioExpanderPresent();

// Prints what the board brought up: which board, the expander, the codecs, the
// LED ring and the I2S topology. Everything it describes is decided during
// setup(), whose output does not survive USB CDC enumeration on these boards,
// so this is called from the four-second replay in loop() for the same reason
// audioMemoryReport() is. Safe to call more than once.
void boardReport();

// Speaker amplifier enable (expander P10, active high). On boards that wire the
// amplifier's SD pin to a GPIO -- or do not break it out at all -- this falls
// back to that pin, so audio code can call it unconditionally.
void boardSetSpeakerAmp(bool enabled);

// The three keys on the expander (P11..P13), reported pressed-true. Returns
// false if the read failed or there is no expander, leaving the outputs
// untouched. Polled from the button task; the expander has no interrupt line
// wired on this board.
bool ioExpanderReadKeys(bool &key1, bool &key2, bool &key3);

#endif

#ifndef OTA_H
#define OTA_H

#include "Config.h"

// Bumped by hand for every release; tools/release_firmware.py reads it from
// here and refuses to publish a version that is already out. The #ifndef is
// for test builds only (release_firmware.py publish --dev --version).
#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "1.0.0"
#endif

// Once at boot, before WiFi: is this image on probation, and did the last one
// roll back?
void otaBootCheck();

// Whether this boot's check reached the backend. A server that keeps asking for
// an update the check could not deliver must not restart the board in a loop.
bool otaCheckedThisBoot();

// After the device token, before the voice websocket: ask the backend whether
// there is a new release for this board, and install it if so. Returns only if
// there was nothing to install or the install failed; a successful install
// restarts the board.
void otaCheckAndUpdate();

// The voice server answered (its "auth" frame). An image on probation is
// confirmed once it has stayed up a while after this; otherwise does nothing.
void otaServerReached();

// From loop(): confirms an image on probation that reached the voice server
// and stayed up, and rolls back one that has not reached it in time.
void otaPoll();

#endif

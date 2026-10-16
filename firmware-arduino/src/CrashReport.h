#ifndef CRASH_REPORT_H
#define CRASH_REPORT_H

#include <Arduino.h>

// Crashes, reported to the server so a toy that crashes in a family's home is
// not just "offline" (server/fastapi/device_crash.py).
//
// A panic (and the watchdogs, which end in one) leaves a note in RTC memory:
// where it happened, which task, the image's version. RTC memory survives the
// reset but not a power cut, so at the next boot crashReportBegin() moves it,
// with the reset reason, into NVS. From there it goes to the server after
// every "auth" until the server acknowledges it, so a board that crashes
// before it ever reaches the server still reports once it does: how many
// times, and the last one in full. A brownout has no note (it is not a
// panic); its reason alone is reported.
//
// Not caught: a flat cell or power cut (the next boot is a plain power-on)
// and a hang the watchdogs do not see.

// Once, early in setup(), before anything can crash again.
void crashReportBegin();

// The report waiting to go, as JSON for the socket; empty when none is.
String crashReportJson();

// The server stored report `id`: forget it.
void crashReportAcked(uint32_t id);

#if CRASH_TEST
// Test builds only (-D CRASH_TEST=1 panics, =2 starves the task watchdog):
// crashes once, CRASH_TEST_AFTER_MS after the first "auth", and not again
// until the chip loses power. Call from the network task.
void crashTestPoll(bool authed);
#endif

#endif

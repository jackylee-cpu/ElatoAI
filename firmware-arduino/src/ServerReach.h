#pragma once

#include <stdint.h>

/*
 * Getting back to our servers without a person (P2-25).
 *
 * On a phone hotspot (2026-10-13) a board lost its socket and every reconnect
 * then hung ~121s in the TLS handshake, for 26 minutes, until someone pulled
 * the power. Nothing in the firmware ever gave up on the network it was on.
 *
 * The websocket library raises no event when a connect fails, so failures are
 * not counted one by one. Instead this measures how long the board has been on
 * Wi-Fi without any answer from our servers, and escalates:
 *
 *   SERVER_REACH_WIFI_RESET_MS  drop Wi-Fi and join again (a fresh association
 *                               clears a stuck AP or DHCP lease)
 *   SERVER_REACH_RESTART_MS     restart, once per outage, without the boot
 *                               chime; after that only Wi-Fi resets, every
 *                               SERVER_REACH_WIFI_RESET_MS
 *
 * Time off Wi-Fi does not count: that is the router, and WifiManager already
 * deals with it. A websocket that opens counts as reached, even one the
 * server then refuses; so do a 202 for an unclaimed board and a refused token,
 * after which no socket is expected. A token alone does not.
 */

// From any task: a websocket opened.
void serverReached();

// The token request's outcome. `answered`: the server gave an answer after
// which no socket is expected (202 unclaimed, a refusal, an error), so the
// board is waiting on a person, not on the network. False for a 200 (the
// socket comes next) and for a request that never got an answer.
void serverReachTokenAnswer(bool answered);

// networkTask, every pass: does the accounting and the escalation. Time only
// counts while the board is on Wi-Fi with no open socket and is not waiting
// on an answered token request -- a healthy session is never "unreachable".
void serverReachPoll(bool socketOpen);

// Once at boot: true when this boot is a recovery restart, so it stays quiet.
bool serverReachSilentBoot();

// WifiManager::loop(): true once after the poll asked for a Wi-Fi reset.
bool serverReachTakeWifiReset();

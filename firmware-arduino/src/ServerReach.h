#pragma once

#include <stdint.h>

/*
 * Getting back to our servers without a person, and saying so (P2-25).
 *
 * On a phone hotspot (2026-10-13) a board lost its socket and every reconnect
 * then hung ~121s in the TLS handshake, for 26 minutes, until someone pulled
 * the power -- with its LED green the whole time, as if all was well.
 *
 * The websocket library raises no event when a connect fails, so failures are
 * not counted one by one; this measures time without a session instead:
 *
 *   SERVER_REACH_SEARCHING_MS   the LED blinks cyan and the board says
 *                               "正在連接" once (wifi_try)
 *   SERVER_REACH_CHECK_MS       on Wi-Fi all that time: the Wi-Fi task asks
 *                               whether the internet is there at all, and
 *                                 - it is not: try another saved network once,
 *                                   then open Wi-Fi setup (magenta, "無法連接"
 *                                   + "正在配網...") so a parent can fix it
 *                                 - it is: our server is down, not their Wi-Fi;
 *                                   blink yellow and keep trying
 *   SERVER_REACH_RESTART_MS     our server still gone: restart once per
 *                               outage, without the boot chime, in case the
 *                               board itself is stuck (heap, TLS)
 *
 * A websocket that opens counts as reached, even one the server then refuses;
 * so do a 202 for an unclaimed board and a refused token, after which no
 * socket is expected. A token alone does not.
 */

enum NetStatus : uint8_t {
    NET_OK,           // a session, or nothing expected (unclaimed, refused)
    NET_SEARCHING,    // no session for a while; working on it
    NET_SERVER_DOWN,  // the internet works and our server does not answer
};

// From any task: a websocket opened.
void serverReached();

// The token request's outcome. `answered`: the server gave an answer after
// which no socket is expected (202 unclaimed, a refusal, an error), so the
// board is waiting on a person, not on the network. False for a 200 (the
// socket comes next) and for a request that never got an answer.
void serverReachTokenAnswer(bool answered);

// networkTask, every pass. `socketOpen`: the voice socket is up. `settingUp`:
// Wi-Fi setup is open (SOFT_AP), which owns the LED and the prompts meanwhile.
void serverReachPoll(bool socketOpen, bool settingUp);

// For the LED.
NetStatus serverReachStatus();

// Once at boot: true when this boot is a recovery restart, so it stays quiet.
bool serverReachSilentBoot();

// WifiManager::loop(): true once each time the poll wants the internet
// checked, after which it reports what it found with one of these two.
bool serverReachTakeWifiCheck();
void serverReachInternetUp();  // so the server is what is down

// Wi-Fi setup opened. `hadNetworks`: setup opened because the saved networks
// failed, not because there were none -- "無法連接" goes first then.
void serverReachSetupOpened(bool hadNetworks);

// The audio task, while idle: the next prompt to play from the assets
// partition, or nullptr.
const char *serverReachTakePrompt();

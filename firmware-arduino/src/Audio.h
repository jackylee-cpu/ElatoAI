#ifndef AUDIO_H
#define AUDIO_H

#include "AudioTools.h"
#include "AudioTools/AudioCodecs/CodecOpus.h"
#include "Config.h"

extern SemaphoreHandle_t wsMutex;
extern WebSocketsClient webSocket;

extern TaskHandle_t speakerTaskHandle;
extern TaskHandle_t micTaskHandle;
extern TaskHandle_t networkTaskHandle;
extern TaskHandle_t decodeTaskHandle;

// Set when the server says the turn is over; networkTask closes the mic once
// the buffered tail has finished playing. Under push-to-talk the mic does not
// reopen on its own -- the button is the only thing that opens it.
extern volatile bool scheduleIdleAfterTurn;
extern unsigned long scheduledTime;
extern unsigned long speakingStartTime;

// Push-to-talk. The button callbacks only raise these flags: they run in the
// timer task, where blocking on wsMutex would stall every other button, so
// networkTask does the actual sending inside the lock it already holds.
extern volatile bool pttPressRequested;
extern volatile bool pttReleaseRequested;
extern volatile bool conversationResetRequested;

// True from the moment the button goes down until it comes up. Server-driven
// state changes check this: a RESPONSE.COMPLETE arriving mid-press must not
// close the mic out from under someone who is still talking.
extern volatile bool pttHeld;

// Millis of the last thing that counts as the device being in use: a button,
// the touch pad, or the bot holding the floor. loop() sleeps the device once
// this goes stale.
extern volatile unsigned long lastActivityAt;
void noteActivity();

extern int currentVolume;

// Volume control. nudgeVolume() is what the hardware buttons call; it persists
// the level so it survives a reboot and stops the server overwriting it.
void applyVolume(int volumePercent);
// Returns false when the level was already at its limit and nothing changed,
// so the caller can acknowledge the press rather than appearing dead.
bool nudgeVolume(int delta);
void applyRemoteVolume(int volumePercent);
bool hasLocalVolumeOverride();
void loadStoredVolume();
extern const int CHANNELS;         // Mono
extern const int BITS_PER_SAMPLE; // 16-bit audio

// AUDIO OUTPUT
// The server encodes 40ms Opus frames (server/fastapi/esp32_transport.py).
// At the 24kHz output rate one decodes to 1920 bytes, so this holds ~10 of
// them and absorbs network jitter without the network task ever blocking
// mid-write. A server still sending the old 120ms frames decodes to 5760
// bytes and is equally fine here. Keep this above 2x the frame size if
// SAMPLE_RATE is ever raised again.
#ifdef BOARD_HAS_PSRAM
constexpr size_t AUDIO_BUFFER_SIZE = 1024 * 20;     // total bytes in the buffer (~416ms @ 24kHz)
#else
// Without PSRAM (the xmini-c3) this comes out of the same internal RAM as
// TLS and lwIP. At 20KB, once that board went to 24kHz, free heap while
// speaking fell to 11.9KB with a 2KB largest block, long push-to-talk presses
// dropped the websocket, and a reconnect failed with "SSL - Memory allocation
// failed" (2026-09-30). The jitter cushion there is the Opus packet queue
// (8KB, ~1.6s at 40kbps), so this only has to ride out decode scheduling:
// 12KB is 256ms at 24kHz, still two of the 5760-byte 120ms frames the rule
// above asks for.
constexpr size_t AUDIO_BUFFER_SIZE = 1024 * 12;
#endif
constexpr size_t AUDIO_CHUNK_SIZE  = 1024;         // ideal read/write chunk size
// Subclassed in Audio.cpp so its state buffer can be pinned to internal RAM;
// see the memory notes there.
class PlacedOpusDecoder;
extern PlacedOpusDecoder opusDecoder;
extern BufferRTOS<uint8_t> audioBuffer;
extern I2SStream i2s; 
extern VolumeStream volume;
extern QueueStream<uint8_t> queue;
extern StreamCopy copier;

// NEW for pitch shift
extern VolumeStream volumePitch;
extern StreamCopy pitchCopier;

extern AudioInfo info;
extern volatile bool i2sOutputFlushScheduled;

// AUDIO INPUT
extern I2SStream i2sInput;
extern StreamCopy micToWsCopier;
extern volatile bool i2sInputFlushScheduled;

// WEBSOCKET
void webSocketEvent(WStype_t type, const uint8_t *payload, size_t length);
void websocketSetup(const String& server_domain, int port, const String& path);
String websocketExtraHeaders();
extern bool websocketStarted;  // websocketSetup() has run; the socket now reconnects itself
// The socket's token was refused, so it stops reconnecting until
// startSessionIfReady() has a new one in its headers. Guarded by wsMutex.
extern volatile bool websocketPaused;
void networkTask(void *parameter);

void transitionToIdle();

// AUDIO OUTPUT
unsigned long getSpeakingDuration();
void audioStreamTask(void *parameter);

// OPUS DECODE
// Allocates the networkTask -> decodeTask packet queue. Must run before any
// task is created: networkTask has the highest priority in the system and
// starts dispatching websocket frames immediately.
void audioPacketQueueSetup();
void decodeTask(void *parameter);

// Where each audio buffer actually ended up, internal RAM or PSRAM. Printed
// once by decodeTask and replayed from loop(), because everything it describes
// is allocated during setup and setup's output does not survive USB CDC
// enumeration on this board.
void audioMemoryReport();

// AUDIO INPUT
void micTask(void *parameter);

#endif
#ifndef DECODE_STATS_H
#define DECODE_STATS_H

#include <stddef.h>
#include <stdint.h>

// Per-turn timing for the TTS playback path, logged as two lines when the turn
// ends. It exists to answer questions the existing counters cannot:
//
//   - Is Opus decode actually expensive on this chip? `starvation` says the
//     ring ran dry but not whether decode, the network, or the I2S consumer is
//     to blame.
//
//     Read `rtf` carefully: it is WALL CLOCK per microsecond of audio, not CPU
//     time. decodeTask runs at priority 2 with three higher-priority tasks
//     above it on the same core, so most of what it measures is being
//     preempted, and the first measurement on hardware came out at 2076 cycles
//     per sample -- an order of magnitude above what fixed-point Opus costs.
//     It is still the right number for an A/B of two builds that schedule the
//     decode identically (buffer placement, optimisation level); it is the
//     wrong number to quote as "Opus costs N% of a core".
//
//     `cpu` is that second number: one packet per turn is decoded with the
//     scheduler suspended, so nothing else on this core can run during it.
//     That is real decode cost. `min` is the cheapest wall-clock packet of the
//     turn, which is a free lower bound on the same thing.
//
//   - How long is the websocket task parked? Decoded PCM is written into the
//     ring with portMAX_DELAY, so when the ring is full the producer blocks --
//     and whatever task is doing the decoding stops servicing everything else
//     it owns. `ring-block` is that time, and `ws gap` is what it costs the
//     task that reads the socket and sends the button presses.
//
//   - Where does the delay before the first word actually go? `onset` splits
//     it into waiting for the first packet, decoding it, and the priming
//     cushion (PLAYBACK_PRIME_BYTES) before anything reaches the amplifier.
//
// Counters are plain scalars, no locking. Each one has a single writer in
// steady state -- networkTask owns the arrival counters, whichever task holds
// the decoder owns the rest -- and the only cross-task write is the reset in
// decodeStatsBeginTurn(), which can race a decode still finishing the previous
// turn. That costs at most one packet's numbers at a turn boundary. These are
// diagnostics; a mutex on the decode path to protect them would be a worse
// trade than the error it prevents.
//
// Cost is a handful of esp_timer_get_time() calls per packet -- 25 packets a
// second at the current frame duration -- which is why this is not behind a
// build flag. The per-sample glitch detector in Audio.cpp is the expensive
// diagnostic, not this one.

/** Start of a bot turn. Called from transitionToSpeaking(). */
void decodeStatsBeginTurn();

/** A binary websocket frame arrived, before it is handed onward. */
void decodeStatsNotePacketArrived(size_t bytes);

/**
 * One packet finished decoding.
 *
 * `writeTotalUs` is the whole cost of OpusAudioDecoder::write(), which is
 * decode *plus* however long it was parked writing the result into a full ring
 * buffer. The blocked time is accumulated separately by decodeStatsAddRingBlockUs()
 * and subtracted here, so `decode` is the codec alone.
 */
void decodeStatsNotePacketDecoded(uint32_t writeTotalUs);

/** Time spent inside a blocking write to the PCM ring. Called from BufferPrint. */
void decodeStatsAddRingBlockUs(uint32_t us);

/** True once per turn, for the packet decoded with the scheduler suspended. */
bool decodeStatsWantsCpuSample();

/** That packet's uncontended decode time, ring-block already excluded. */
void decodeStatsNoteCpuSample(uint32_t us);

/**
 * PCM that reached the ring. Called from BufferPrint, which is the only place
 * that knows: the decoder reports what it decoded, but BufferPrint discards the
 * write outright once the turn is over, and a delta on audioBuffer.available()
 * cannot tell the difference because the consumer task is draining the ring at
 * the same time. Counting the wrong one shortens the audio duration the
 * real-time factor is divided by, which inflates it.
 */
void decodeStatsAddPcmBytes(size_t bytes);

/** Gap between two consecutive services of the websocket. Called from networkTask. */
void decodeStatsNoteWsServiceGap(uint32_t us);

/** PCM handed to the I2S pipeline. Only the first call of a turn is timed. */
void decodeStatsNoteAudioOut();

/** Two lines summarising the turn. Called from transitionToIdle(). */
void decodeStatsLogTurn();

#endif

#include "DecodeStats.h"

#include <Arduino.h>
#include <esp_timer.h>

#include "Config.h"

namespace {

// Turn start, in microseconds on the esp_timer clock. Everything in the second
// log line is relative to this.
int64_t turnStartUs = 0;

// First-of-turn milestones, 0 until they happen.
int64_t firstPacketUs = 0;
int64_t firstDecodeUs = 0;
int64_t firstAudioOutUs = 0;

uint32_t packets = 0;
uint32_t packetBytes = 0;
// Packets that were actually decoded. Not the same as `packets`: one that
// arrives after the turn is abandoned is dropped without being decoded, and
// averaging decode time over arrivals rather than decodes would understate it.
uint32_t decoded = 0;
uint32_t pcmBytes = 0;

uint64_t decodeSumUs = 0;
uint32_t decodeMaxUs = 0;
uint32_t decodeMinUs = 0xFFFFFFFF;

// Packets decoded with the scheduler suspended: the only figures here that are
// CPU time rather than wall clock.
//
// Sampled repeatedly, not once. A single sample per turn could not separate the
// effects being measured -- buffer placement and optimisation level moved the
// number by 2-4%, and the spread between two runs of the *same* build was just
// as wide. One sample per second of audio gives a dozen or so per turn, which
// is enough for the min and the mean to mean something.
//
// Each sample stops this core for one packet's decode (~8ms measured). The I2S
// DMA holds 64ms and the ring behind it up to 416ms, so even a dozen of those
// cannot reach the amplifier -- and `starvation` in the turn-over line is the
// check on that claim.
uint32_t cpuSamples = 0;
uint64_t cpuSumUs = 0;
uint32_t cpuMinUs = 0xFFFFFFFF;
uint32_t cpuMaxUs = 0;
// Skip the first few: the pipeline is still filling and the caches are cold
// from whatever ran before the turn.
constexpr uint32_t CPU_SAMPLE_AFTER_PACKETS = 4;
constexpr uint32_t CPU_SAMPLE_EVERY = 24;  // ~1s of audio at 40ms frames

uint64_t ringBlockSumUs = 0;
uint32_t ringBlockMaxUs = 0;

// Filled by BufferPrint between one decode and the next, drained by
// decodeStatsNotePacketDecoded(). Single producer: whichever task owns the
// decoder.
uint32_t ringBlockPendingUs = 0;

// Likewise for the PCM this packet actually produced.
uint32_t pcmBytesPendingBytes = 0;

uint32_t wsGapMaxUs = 0;

/** Bytes of 16-bit mono PCM per millisecond of audio at the output rate. */
inline uint32_t bytesPerMs() { return (SAMPLE_RATE * 2) / 1000; }

/** `value` as a per-mille of `total`, saturating rather than dividing by zero. */
inline uint32_t perMille(uint64_t value, uint64_t total) {
    if (total == 0) return 0;
    return (uint32_t)((value * 1000) / total);
}

/** Milliseconds from the start of the turn, or -1 if the milestone never came. */
inline long sinceStartMs(int64_t stampUs) {
    if (stampUs == 0) return -1;
    return (long)((stampUs - turnStartUs) / 1000);
}

}  // namespace

void decodeStatsBeginTurn() {
    turnStartUs = esp_timer_get_time();
    firstPacketUs = 0;
    firstDecodeUs = 0;
    firstAudioOutUs = 0;
    packets = 0;
    packetBytes = 0;
    decoded = 0;
    pcmBytes = 0;
    decodeSumUs = 0;
    decodeMaxUs = 0;
    decodeMinUs = 0xFFFFFFFF;
    cpuSamples = 0;
    cpuSumUs = 0;
    cpuMinUs = 0xFFFFFFFF;
    cpuMaxUs = 0;
    ringBlockSumUs = 0;
    ringBlockMaxUs = 0;
    ringBlockPendingUs = 0;
    pcmBytesPendingBytes = 0;
    wsGapMaxUs = 0;
}

void decodeStatsNotePacketArrived(size_t bytes) {
    if (firstPacketUs == 0) firstPacketUs = esp_timer_get_time();
    packets++;
    packetBytes += (uint32_t)bytes;
}

void decodeStatsAddRingBlockUs(uint32_t us) {
    ringBlockPendingUs += us;
}

void decodeStatsAddPcmBytes(size_t bytes) {
    pcmBytesPendingBytes += (uint32_t)bytes;
}

void decodeStatsNotePacketDecoded(uint32_t writeTotalUs) {
    const uint32_t blocked = ringBlockPendingUs;
    ringBlockPendingUs = 0;
    const uint32_t bytes = pcmBytesPendingBytes;
    pcmBytesPendingBytes = 0;

    // The subtraction is not guaranteed non-negative: the two clocks are the
    // same, but a preemption between the outer stamp and the inner one can put
    // the accumulated block time marginally above the total. Clamp rather than
    // wrap a uint32 round to four billion microseconds.
    const uint32_t decodeUs = writeTotalUs > blocked ? writeTotalUs - blocked : 0;

    if (firstDecodeUs == 0) firstDecodeUs = esp_timer_get_time();
    decoded++;
    decodeSumUs += decodeUs;
    if (decodeUs > decodeMaxUs) decodeMaxUs = decodeUs;
    if (decodeUs < decodeMinUs) decodeMinUs = decodeUs;
    ringBlockSumUs += blocked;
    if (blocked > ringBlockMaxUs) ringBlockMaxUs = blocked;
    pcmBytes += bytes;
}

bool decodeStatsWantsCpuSample() {
    return decoded >= CPU_SAMPLE_AFTER_PACKETS &&
           ((decoded - CPU_SAMPLE_AFTER_PACKETS) % CPU_SAMPLE_EVERY) == 0;
}

void decodeStatsNoteCpuSample(uint32_t us) {
    cpuSamples++;
    cpuSumUs += us;
    if (us < cpuMinUs) cpuMinUs = us;
    if (us > cpuMaxUs) cpuMaxUs = us;
}

void decodeStatsNoteWsServiceGap(uint32_t us) {
    if (us > wsGapMaxUs) wsGapMaxUs = us;
}

void decodeStatsNoteAudioOut() {
    if (firstAudioOutUs == 0) firstAudioOutUs = esp_timer_get_time();
}

void decodeStatsLogTurn() {
    if (packets == 0 || decoded == 0) {
        // A turn with no audio is not worth two lines; transitionToIdle()
        // already says the turn is over.
        return;
    }

    const uint32_t audioMs = pcmBytes / bytesPerMs();
    const uint32_t msPerPacket = decoded ? audioMs / decoded : 0;
    // Wall clock per microsecond of audio, NOT CPU -- see the header. Valid for
    // comparing two builds that schedule the decode the same way, misleading as
    // an absolute cost.
    const uint32_t rtf = perMille(decodeSumUs, (uint64_t)audioMs * 1000);
    // The same ratio for the uncontended packets. These are real CPU.
    const uint32_t cpuAvgUs = cpuSamples ? (uint32_t)(cpuSumUs / cpuSamples) : 0;
    const uint32_t cpuRtf = perMille((uint64_t)cpuAvgUs, (uint64_t)msPerPacket * 1000);

    Serial.printf(
        "Decode | %u pkt (%u decoded) / %u B -> %u ms audio (%u ms/pkt) | "
        "wall avg %u us min %u us max %u us rtf %u.%u%% | "
        "cpu n=%u avg %u us min %u us max %u us = %u.%u%% | "
        "ring-block avg %u us max %u us total %u ms\n",
        packets, decoded, packetBytes, audioMs, msPerPacket,
        (uint32_t)(decodeSumUs / decoded),
        decodeMinUs == 0xFFFFFFFF ? 0 : decodeMinUs, decodeMaxUs, rtf / 10, rtf % 10,
        cpuSamples, cpuAvgUs, cpuMinUs == 0xFFFFFFFF ? 0 : cpuMinUs, cpuMaxUs,
        cpuRtf / 10, cpuRtf % 10,
        (uint32_t)(ringBlockSumUs / decoded), ringBlockMaxUs,
        (uint32_t)(ringBlockSumUs / 1000));

    Serial.printf(
        "Onset  | first packet %+ld ms | first decode %+ld ms | first audio out %+ld ms | "
        "ws gap max %u ms\n",
        sinceStartMs(firstPacketUs), sinceStartMs(firstDecodeUs),
        sinceStartMs(firstAudioOutUs), wsGapMaxUs / 1000);
}

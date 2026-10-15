#pragma once

#include <stddef.h>
#include <stdint.h>

/*
 * IMA ADPCM for the microphone uplink (P2-24): a quarter of raw 16-bit PCM for
 * about 0.7% of the C3's CPU (measured 2026-10-13). One call makes one block,
 * which is one websocket frame:
 *
 *   int16 LE  predicted sample the block starts from
 *   uint8     step index the block starts from (0-88)
 *   uint8     flags: bit 0 set when the last low nibble is padding
 *   ...       4-bit codes, two per byte, first sample in the high nibble
 *
 * The state carries on from block to block, so the sound is that of one
 * continuous stream, but each block names its own starting state and decodes
 * on its own. The server's side is server/fastapi/mic_adpcm.py; the codes are
 * Python audioop's, and server/fastapi/tests/test_mic_adpcm.py compiles this
 * file and holds the two to the same bytes. Plain C++ for that reason: no
 * Arduino headers in here.
 */

struct MicAdpcmState {
    int32_t predicted = 0;
    int32_t index = 0;
};

constexpr size_t micAdpcmBlockBytes(size_t samples) { return 4 + (samples + 1) / 2; }

// Encodes `samples` 16-bit samples into `out` (micAdpcmBlockBytes(samples)
// long) and returns the block's size.
size_t micAdpcmEncodeBlock(MicAdpcmState &state, const int16_t *pcm, size_t samples, uint8_t *out);

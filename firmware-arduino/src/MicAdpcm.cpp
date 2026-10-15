#include "MicAdpcm.h"

// A port of CPython audioop's lin2adpcm (Intel/DVI IMA), step for step, so the
// server can decode with audioop.adpcm2lin. Change nothing here without
// running server/fastapi/tests/test_mic_adpcm.py.

static const int8_t kIndexTable[16] = {
    -1, -1, -1, -1, 2, 4, 6, 8,
    -1, -1, -1, -1, 2, 4, 6, 8,
};

static const int16_t kStepTable[89] = {
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
    19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
    130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
    337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
    5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
    15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
};

static uint8_t encodeSample(MicAdpcmState &state, int32_t val) {
    int32_t step = kStepTable[state.index];
    int32_t diff;
    uint8_t sign;
    if (val < state.predicted) {
        sign = 8;
        diff = state.predicted - val;
    } else {
        sign = 0;
        diff = val - state.predicted;
    }

    uint8_t delta = 0;
    int32_t vpdiff = step >> 3;
    if (diff >= step) {
        delta = 4;
        diff -= step;
        vpdiff += step;
    }
    step >>= 1;
    if (diff >= step) {
        delta |= 2;
        diff -= step;
        vpdiff += step;
    }
    step >>= 1;
    if (diff >= step) {
        delta |= 1;
        vpdiff += step;
    }

    state.predicted += sign ? -vpdiff : vpdiff;
    if (state.predicted > 32767) state.predicted = 32767;
    else if (state.predicted < -32768) state.predicted = -32768;

    delta |= sign;
    state.index += kIndexTable[delta];
    if (state.index < 0) state.index = 0;
    if (state.index > 88) state.index = 88;
    return delta;
}

size_t micAdpcmEncodeBlock(MicAdpcmState &state, const int16_t *pcm, size_t samples, uint8_t *out) {
    const int16_t start = (int16_t)state.predicted;
    out[0] = (uint8_t)(start & 0xff);
    out[1] = (uint8_t)((uint16_t)start >> 8);
    out[2] = (uint8_t)state.index;
    out[3] = (samples & 1) ? 0x01 : 0x00;

    uint8_t *codes = out + 4;
    for (size_t i = 0; i < samples; i++) {
        const uint8_t delta = encodeSample(state, pcm[i]);
        if ((i & 1) == 0) {
            codes[i / 2] = (uint8_t)(delta << 4);
        } else {
            codes[i / 2] |= delta;
        }
    }
    return micAdpcmBlockBytes(samples);
}

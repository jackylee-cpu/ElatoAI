#ifndef DOWNSAMPLE_H
#define DOWNSAMPLE_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

// 24kHz -> 16kHz, for a microphone that has to run at the speaker's rate.
//
// On a board where one codec does both directions over one I2S bus there is
// one LRCK, so the microphone captures at whatever rate playback needs. The
// server's STT is fed 16kHz (ESP32_INPUT_SAMPLE_RATE), so the uplink is
// brought down here rather than teaching the server a second input rate.
//
// A 3:2 polyphase FIR: conceptually upsample by 2 to 48kHz, low-pass, keep
// every third sample. Of the two phases only one is evaluated per output, so
// each output costs 48 multiply-adds, and every third input produces none.
// The prototype is a 96-tap remez low-pass designed at 48kHz: passband to
// 6.5kHz (ripple 0.09dB), stopband from 8kHz (the output's Nyquist) at
// -65.9dB or better, so nothing folds back into the speech band. Coefficients
// are Q15 of 2 x h, the 2 making up for the zero-stuffing; each phase sums to
// 32602 (-0.04dB at DC).
//
// Accumulation is in 32 bits. The sum of |coefficients| per phase is 64824,
// so the worst possible input, full scale with every sign aligned, reaches
// 64824 x 32768 = 2.124e9, inside int32's 2.147e9 with the rounding term.
// Changing the coefficients means redoing that check.
class Downsample3to2 {
public:
    Downsample3to2() { reset(); }

    void reset() {
        memset(line, 0, sizeof(line));
        pos = 0;
        phase = 0;
    }

    // Converts `count` input samples; returns how many were written to `out`,
    // which needs room for count * 2 / 3 + 1. State carries across calls, so
    // input can arrive in blocks of any length.
    size_t process(const int16_t *in, size_t count, int16_t *out) {
        size_t written = 0;
        for (size_t i = 0; i < count; i++) {
            // Newest sample at line[pos], the P - 1 before it following on
            // contiguously: every sample is stored twice, P apart, so the
            // window never wraps.
            pos = (pos == 0) ? kTapsPerPhase - 1 : pos - 1;
            line[pos] = line[pos + kTapsPerPhase] = in[i];

            const int16_t *taps;
            if (phase == 0) {
                taps = kEven;  // output 2j, aligned on input 3j
            } else if (phase == 1) {
                taps = kOdd;   // output 2j + 1, aligned on input 3j + 1
            } else {
                taps = nullptr;  // input 3j + 2 lands between outputs
            }
            phase = (phase == 2) ? 0 : phase + 1;
            if (taps == nullptr) continue;

            const int16_t *window = &line[pos];
            int32_t acc = 1 << 14;  // round to nearest
            for (int t = 0; t < kTapsPerPhase; t++) {
                acc += (int32_t)taps[t] * (int32_t)window[t];
            }
            acc >>= 15;
            if (acc > 32767) acc = 32767;
            if (acc < -32768) acc = -32768;
            out[written++] = (int16_t)acc;
        }
        return written;
    }

private:
    static constexpr int kTapsPerPhase = 48;

    // h[0], h[2], h[4], ... of the prototype.
    static constexpr int16_t kEven[kTapsPerPhase] = {
        -38, -79, 23, 82, -89, -62, 182, -28, -249, 211, 213, -446,
        6, 623, -439, -571, 1025, 93, -1582, 1031, 1788, -3351, -798, 13690,
        18824, 5959, -4003, -607, 2299, -715, -1115, 1019, 264, -843, 231, 486,
        -404, -148, 357, -68, -215, 146, 77, -132, 6, 78, -52, -77,
    };
    // h[1], h[3], h[5], ... -- the same filter, so the mirror image of kEven.
    static constexpr int16_t kOdd[kTapsPerPhase] = {
        -77, -52, 78, 6, -132, 77, 146, -215, -68, 357, -148, -404,
        486, 231, -843, 264, 1019, -1115, -715, 2299, -607, -4003, 5959, 18824,
        13690, -798, -3351, 1788, 1031, -1582, 93, 1025, -571, -439, 623, 6,
        -446, 213, 211, -249, -28, 182, -62, -89, 82, 23, -79, -38,
    };

    int16_t line[2 * kTapsPerPhase];
    int pos;
    int phase;
};

#endif

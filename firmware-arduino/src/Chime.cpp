#include "Chime.h"

#include "Audio.h"
#include "Config.h"
#include "SoundData.h"
#include <Arduino.h>
#include <driver/i2s.h>
#include "Codec.h"
#include "IoExpander.h"

namespace {

constexpr int kBlockFrames = 256;
int16_t block[kBlockFrames];

// Whatever startI2S() was last given. writeSilence() needs it to turn a
// duration into a frame count, and the two sounds do not run at the same rate.
int activeRate = 0;

// Both recordings are normalised to -1 dBFS by tools/wav_to_sound.py, so they
// need no headroom for summing voices the way a synthesised chime would, only
// to sit under speech. This is the knob to turn if they come out wrong on the
// toy; the WAVs should not be re-levelled for it. Was 0.70, which measured a
// little loud on the speaker.
//
// It is not the whole level, though: both sounds are also scaled by
// currentVolume, and setupDeviceMetadata() restores that from NVS before
// either can play. So how loud they actually are depends on where the volume
// buttons were last left, and a board sitting at volume 10 will barely be
// audible however this is set.
#ifdef CHIME_GAIN_OVERRIDE
// Diagnostic build: see the -quietchime environment in platformio.ini.
constexpr float kSoundGain = CHIME_GAIN_OVERRIDE;
#else
constexpr float kSoundGain = 0.50f;
#endif

void writeBlock(int frames) {
    size_t written = 0;
    i2s_write(I2S_PORT_OUT, block, frames * sizeof(int16_t), &written, portMAX_DELAY);
}

void writeSilence(int ms) {
    memset(block, 0, sizeof(block));
    int blocks = (activeRate * ms / 1000) / kBlockFrames;
    for (int i = 0; i < blocks; i++) writeBlock(kBlockFrames);
}

bool startI2S(int rate) {
    activeRate = rate;
    i2s_config_t cfg = {};
    cfg.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX);
    cfg.sample_rate = rate;
    cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
    cfg.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
    cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
    cfg.intr_alloc_flags = 0;
    cfg.dma_buf_count = 6;
    cfg.dma_buf_len = 256;
#if BOARD_SHARED_I2S_BUS
    // One port on this board, so there is nothing to fight over, and the
    // ES8311 needs an exact MCLK. Matches audioStreamTask.
    cfg.use_apll = BOARD_I2S_USE_APLL;
    cfg.mclk_multiple = I2S_MCLK_MULTIPLE_256;
#else
    // The mic port may be running at 16kHz alongside this one, and the chip has
    // a single APLL for the two of them to fight over. See audioStreamTask.
    cfg.use_apll = false;
#endif
    cfg.tx_desc_auto_clear = true;
    if (i2s_driver_install(I2S_PORT_OUT, &cfg, 0, NULL) != ESP_OK) return false;

    i2s_pin_config_t pins = {};
    pins.mck_io_num = (I2S_MCLK_OUT >= 0) ? I2S_MCLK_OUT : I2S_PIN_NO_CHANGE;
    pins.bck_io_num = I2S_BCK_OUT;
    pins.ws_io_num = I2S_WS_OUT;
    pins.data_out_num = I2S_DATA_OUT;
    pins.data_in_num = I2S_PIN_NO_CHANGE;
    return i2s_set_pin(I2S_PORT_OUT, &pins) == ESP_OK;
}

// The recording is streamed out of flash a block at a time and read in place:
// neither table would fit in the heap at the moments these run, and the samples
// are already exactly what I2S wants.
//
// Both recordings start and end on a zero sample -- the generator guarantees it
// with a fade at each end -- so the only clicks left to avoid are at the port's
// own edges, which is what the silence either side is for.
void playSample(const int16_t *pcm, unsigned frames, int rate) {
    if (!startI2S(rate)) {
        Serial.println("Chime: I2S unavailable, skipping");
        return;
    }

    // On a codec board there is no sound at all until the DAC has been
    // configured, and it can only be configured once the MCLK above is
    // running. On the breadboard kit this is a no-op and the amplifier is the
    // spare GPIO going high, exactly as before.
    codecBegin(rate, 16);
    boardSetSpeakerAmp(true);

    // Open on zeros so the amplifier is not handed whatever the pads were last
    // driven to, and give the DMA a moment to be full of silence.
    writeSilence(30);

    const float gain = kSoundGain * (currentVolume / 100.0f);
    for (unsigned done = 0; done < frames; done += kBlockFrames) {
        unsigned n = frames - done;
        if (n > kBlockFrames) n = kBlockFrames;
        for (unsigned i = 0; i < n; i++) {
            block[i] = (int16_t)(pcm[done + i] * gain);
        }
        writeBlock(n);
    }

    // Longer than the DMA holds, so the last thing the amplifier sees is
    // silence and not the tail of the sound repeated.
    writeSilence(120);
    i2s_zero_dma_buffer(I2S_PORT_OUT);
    // Mute before the clocks stop, or the amplifier is left enabled across the
    // gap until audioStreamTask reinstalls the port and hears whatever the
    // floating DAC output does in between.
    boardSetSpeakerAmp(false);
    i2s_driver_uninstall(I2S_PORT_OUT);
}

// Plays through the port audioStreamTask has already opened, instead of
// installing one. Measured 2026-09-10: installing a second driver on
// I2S_PORT_OUT, playing, uninstalling it and letting i2s.begin() reinstall the
// same port leaves the output stage unwell -- the first TTS after boot squealed
// and popped while the decoded PCM feeding it measured perfectly clean
// (glitches 0). Skipping the boot sound made that first TTS clean, five turns
// running. So the sound stays; the teardown goes.
//
// i2s.write() and not i2s_write(): audio-tools opened the port with channels=1
// and duplicates mono to the two I2S slots in software. Writing past it would
// play at half speed with the samples split across left and right.
//
// The recording is 16kHz and the port runs at 24kHz, which is why it wanted its
// own driver in the first place. Linear interpolation covers the 3:2 ratio
// perfectly well for a chime.
static void playResampledOnOpenPort(const int16_t *pcm, unsigned frames, int srcRate) {
    const float gain = kSoundGain * (currentVolume / 100.0f);
    const double stepPerOut = (double)srcRate / (double)SAMPLE_RATE;
    const unsigned outFrames = (unsigned)((double)frames / stepPerOut);

    double pos = 0.0;
    for (unsigned done = 0; done < outFrames; done += kBlockFrames) {
        unsigned n = outFrames - done;
        if (n > (unsigned)kBlockFrames) n = kBlockFrames;
        for (unsigned i = 0; i < n; i++) {
            unsigned idx = (unsigned)pos;
            float frac = (float)(pos - (double)idx);
            int16_t a = pcm[idx];
            int16_t b = (idx + 1 < frames) ? pcm[idx + 1] : a;
            block[i] = (int16_t)(((float)a + ((float)b - (float)a) * frac) * gain);
            pos += stepPerOut;
        }
        i2s.write((const uint8_t *)block, n * sizeof(int16_t));
    }

    // Leave the port on zeros so the amplifier is not handed the tail of the
    // last frame while the pipeline is still deciding what to do next.
    memset(block, 0, sizeof(block));
    for (int i = 0; i < 8; i++) i2s.write((const uint8_t *)block, sizeof(block));
}

}  // namespace

void playBootChime() {
    Serial.printf("Chime: boot, %u frames @ %d Hz -> %u Hz on the open port\n",
                  kBootSoundFrames, kBootSoundRate, (unsigned)SAMPLE_RATE);
    playResampledOnOpenPort(kBootSoundPcm, kBootSoundFrames, kBootSoundRate);
}

void playLowBatteryReminder() {
    Serial.printf("Chime: low battery, %u frames @ %d Hz -> %u Hz on the open port\n",
                  kLowBatterySoundFrames, kLowBatterySoundRate, (unsigned)SAMPLE_RATE);
    boardSetSpeakerAmp(true);
    playResampledOnOpenPort(kLowBatterySoundPcm, kLowBatterySoundFrames, kLowBatterySoundRate);
    boardSetSpeakerAmp(false);
}

void playSleepChime() {
    Serial.printf("Chime: sleep, %u frames @ %d Hz\n", kSleepSoundFrames, kSleepSoundRate);
    playSample(kSleepSoundPcm, kSleepSoundFrames, kSleepSoundRate);
}

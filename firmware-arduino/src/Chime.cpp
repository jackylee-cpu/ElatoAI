#include "Chime.h"

#include "Audio.h"
#include "Config.h"
#include "SoundData.h"
#include <Arduino.h>
#include <driver/i2s.h>

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
constexpr float kSoundGain = 0.50f;

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
    // The mic port may be running at 16kHz alongside this one, and the chip has
    // a single APLL for the two of them to fight over. See audioStreamTask.
    cfg.use_apll = false;
    cfg.tx_desc_auto_clear = true;
    if (i2s_driver_install(I2S_PORT_OUT, &cfg, 0, NULL) != ESP_OK) return false;

    i2s_pin_config_t pins = {};
    pins.mck_io_num = I2S_PIN_NO_CHANGE;
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

    pinMode(I2S_SD_OUT, OUTPUT);
    digitalWrite(I2S_SD_OUT, HIGH);

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
    i2s_driver_uninstall(I2S_PORT_OUT);
}

}  // namespace

void playBootChime() {
    Serial.printf("Chime: boot, %u frames @ %d Hz\n", kBootSoundFrames, kBootSoundRate);
    playSample(kBootSoundPcm, kBootSoundFrames, kBootSoundRate);
}

void playSleepChime() {
    Serial.printf("Chime: sleep, %u frames @ %d Hz\n", kSleepSoundFrames, kSleepSoundRate);
    playSample(kSleepSoundPcm, kSleepSoundFrames, kSleepSoundRate);
}

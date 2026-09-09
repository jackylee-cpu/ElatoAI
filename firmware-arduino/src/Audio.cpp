#include "OTA.h"
#include "Audio.h"
#include "Chime.h"
#include "PitchShift.h"
#include <esp_heap_caps.h>

// WEBSOCKET
SemaphoreHandle_t wsMutex;
WebSocketsClient webSocket;

// TASK HANDLES
TaskHandle_t speakerTaskHandle = NULL;
TaskHandle_t micTaskHandle = NULL;
TaskHandle_t networkTaskHandle = NULL;

// TIMING REGISTERS
volatile bool scheduleIdleAfterTurn = false;
unsigned long scheduledTime = 0;
unsigned long speakingStartTime = 0;

// Raised by the button callbacks, consumed by networkTask.
volatile bool pttPressRequested = false;
volatile bool pttReleaseRequested = false;
volatile bool conversationResetRequested = false;
volatile bool pttHeld = false;
volatile unsigned long lastActivityAt = 0;

// Playback starvation, in roughly milliseconds, over the current turn.
static volatile uint32_t starvationRun = 0;
static volatile uint32_t worstStarvationMs = 0;

void noteActivity() { lastActivityAt = millis(); }

// Set on release: keep streaming this much longer so the server's VAD hears
// the silence and closes the turn itself. See processPushToTalk() for why we
// do not just tell it the turn is over.
static unsigned long pttTailUntil = 0;

// True while the button is down or the tail is still running -- i.e. while the
// device, not the server, owns the mic.
static bool pttOwnsMic() { return pttHeld || pttTailUntil != 0; }

// The server opens every websocket session with a greeting, which is what we
// want after a boot or a deliberate reset -- but an idle link that drops and
// reconnects on its own would then have the device start talking to an empty
// room every few minutes. Only a session the user actually asked for gets to
// speak first.
static volatile bool greetingWanted = true;  // the boot session is asked for
static bool userSpokeThisSession = false;
static bool audioDiscardReported = false;

// AUDIO SETTINGS
int currentVolume = 70;

// Its own Preferences handle rather than the global one in Config.cpp: these
// run from the button task while the wifi task may be using that one.
static Preferences audioPrefs;
static const int VOLUME_MIN = 0;
static const int VOLUME_MAX = 100;

bool hasLocalVolumeOverride() {
    audioPrefs.begin("audio", true);
    int stored = audioPrefs.getInt("volume", -1);
    audioPrefs.end();
    return stored >= 0;
}

void loadStoredVolume() {
    audioPrefs.begin("audio", true);
    int stored = audioPrefs.getInt("volume", -1);
    audioPrefs.end();
    if (stored >= 0) {
        currentVolume = constrain(stored, VOLUME_MIN, VOLUME_MAX);
        Serial.printf("Restored local volume %d\n", currentVolume);
    }
}

void applyVolume(int volumePercent) {
    currentVolume = constrain(volumePercent, VOLUME_MIN, VOLUME_MAX);
    volume.setVolume(currentVolume / 100.0f);
    volumePitch.setVolume(currentVolume / 100.0f);
}

// Called from the hardware buttons. Persisting here is what makes the physical
// control authoritative: the server sends a volume in every auth frame, and a
// character switch forces a reconnect, so without this a button press would be
// undone seconds later.
void nudgeVolume(int delta) {
    applyVolume(currentVolume + delta);
    audioPrefs.begin("audio", false);
    audioPrefs.putInt("volume", currentVolume);
    audioPrefs.end();
    Serial.printf("Volume %+d -> %d\n", delta, currentVolume);
}
float currentPitchFactor = 1.0f;
const int CHANNELS = 1;         // Mono
const int BITS_PER_SAMPLE = 16; // 16-bit audio

// Glitch detection on the decoder's output, taken before the ring buffer so it
// separates the two halves of the pipeline: a fault visible here is decode or
// transport, and a squeal audible with clean numbers here is downstream --
// I2S clocking, the amplifier, the speaker.
//
// The test is the step between consecutive samples. 8000 was the first guess
// and it was wrong: a sinusoid of amplitude A steps by A*2*pi*f/fs between
// samples, so at the ~22000 peaks this stream actually reaches, 8000 is only a
// 1.5kHz component at full amplitude -- an ordinary sibilant. It flagged one to
// three samples a turn, all of them real signal.
//
// A step larger than the whole envelope, on the other hand, cannot be signal:
// no band-limited waveform moves further in one sample than its own peak. Real
// faults -- a torn buffer, a dropped frame, a stray write -- clear this easily
// and arrive in their hundreds, not ones.
static const int32_t PCM_STEP_LIMIT = 24000;
static volatile int32_t pcmPeak = 0;
static volatile int32_t pcmMaxStep = 0;
static volatile uint32_t pcmBigSteps = 0;
static int16_t pcmPrev = 0;
static bool pcmHavePrev = false;
static uint8_t pcmCarry = 0;
static bool pcmHaveCarry = false;

static void resetPcmStats() {
    pcmPeak = 0;
    pcmMaxStep = 0;
    pcmBigSteps = 0;
    pcmHavePrev = false;
    pcmHaveCarry = false;
}

static inline void inspectSample(int16_t sample) {
    int32_t mag = sample < 0 ? -(int32_t)sample : (int32_t)sample;
    if (mag > pcmPeak) pcmPeak = mag;
    if (pcmHavePrev) {
        int32_t step = (int32_t)sample - (int32_t)pcmPrev;
        if (step < 0) step = -step;
        if (step > pcmMaxStep) pcmMaxStep = step;
        if (step > PCM_STEP_LIMIT) pcmBigSteps++;
    }
    pcmPrev = sample;
    pcmHavePrev = true;
}

// Writes arrive on arbitrary byte boundaries, so a sample can straddle two of
// them. Carrying the odd byte matters: pairing it with the wrong neighbour
// would manufacture exactly the huge step this is looking for.
static void inspectDecodedPcm(const uint8_t *data, size_t size) {
    size_t i = 0;
    if (pcmHaveCarry && size > 0) {
        inspectSample((int16_t)((uint16_t)pcmCarry | ((uint16_t)data[0] << 8)));
        pcmHaveCarry = false;
        i = 1;
    }
    for (; i + 1 < size; i += 2) {
        inspectSample((int16_t)((uint16_t)data[i] | ((uint16_t)data[i + 1] << 8)));
    }
    if (i < size) {
        pcmCarry = data[i];
        pcmHaveCarry = true;
    }
}

// AUDIO OUTPUT
class BufferPrint : public Print {
public:
  explicit BufferPrint(BufferRTOS<uint8_t>& buf) : _buffer(buf) {}

  // networkTask -> webSocket.loop() -> webSocketEvent(WStype_BIN, ...) -> opusDecoder.write() -> bufferPrint.write()
  virtual size_t write(uint8_t data) override {
    if (webSocket.isConnected() && deviceState == SPEAKING) {
        return _buffer.writeArray(&data, 1);
    }
    return 1; //let opusDecoder write, otherwise thread will stuck
  }

  // networkTask -> webSocket.loop() -> webSocketEvent(WStype_BIN, ...) -> opusDecoder.write() -> bufferPrint.write()
  virtual size_t write(const uint8_t *buffer, size_t size) override {
    if (webSocket.isConnected() && deviceState == SPEAKING) {
        inspectDecodedPcm(buffer, size);
        return _buffer.writeArray(buffer, size);
    }
    return size; //let opusDecoder write, otherwise thread will stuck
  }

private:
  BufferRTOS<uint8_t>& _buffer;
};

BufferPrint bufferPrint(audioBuffer);
OpusAudioDecoder opusDecoder;  //access guarded by wsmutex
// audio-tools' DefaultAllocator tries ps_malloc first, so with PSRAM enabled
// this ring would live in external RAM -- on the SPI bus, behind the cache,
// with latency that jitters against flash access. It is drained at a fixed
// 48KB/s by the I2S pipeline, so it belongs in internal SRAM; the big
// latency-insensitive blocks (libopus' 60KB scratch) are what PSRAM is for.
static audio_tools::Allocator internalRamAllocator;
BufferRTOS<uint8_t> audioBuffer(AUDIO_BUFFER_SIZE, AUDIO_CHUNK_SIZE, portMAX_DELAY,
                                portMAX_DELAY, internalRamAllocator);  //producer: networkTask, consumer: audioStreamTask. Thread safe in single producer->single consumer scenario.
I2SStream i2s; //access from audioStreamTask only

// OLD with no pitch shift
VolumeStream volume(i2s); //access from audioStreamTask only
QueueStream<uint8_t> queue(audioBuffer); //access from audioStreamTask only
StreamCopy copier(volume, queue);

// NEW for pitch shift (lossy)
PitchShiftFixedOutput pitchShift(i2s);
VolumeStream volumePitch(pitchShift); //access from audioStreamTask only
StreamCopy pitchCopier(volumePitch, queue);

AudioInfo info(SAMPLE_RATE, CHANNELS, BITS_PER_SAMPLE);
volatile bool i2sOutputFlushScheduled = false;

// The MAX98357A's SD pin is not broken out on this kit (see Config.cpp), so
// I2S_SD_OUT drives a spare GPIO and mutes nothing: the amplifier is live from
// power-on and plays whatever the I2S DMA holds. Silence has to be written,
// never switched off -- and the buffers have to be emptied by hand, because
// I2SStream::flush(), VolumeStream::flush() and QueueStream::flush() are all
// no-ops in audio-tools. The old i2sOutputFlushScheduled block called those
// three and therefore cleared nothing at all.

// Set by transitionToSpeaking(); audioStreamTask holds the output silent until
// the ring has PLAYBACK_PRIME_BYTES in it. Starting on the first packet means
// playing at the exact rate the network delivers, and every jitter spike then
// becomes a gap -- a run of those gaps is the stutter.
static volatile bool playbackPrimed = false;
// ~170ms at 24kHz mono s16, out of the 416ms ring. Costs that much at the start
// of a turn and buys a matching cushion against network jitter for the rest of
// it. Lower it if responses feel sluggish, but watch the starvation figure
// transitionToIdle() logs.
static const size_t PLAYBACK_PRIME_BYTES = 8192;
// ...but never wait longer than this for it. A reply shorter than
// PLAYBACK_PRIME_BYTES of PCM (170ms) would otherwise never reach the
// threshold, and playback would never start at all: the audio just sits in the
// ring until the end of the turn drops it.
static const unsigned long PLAYBACK_PRIME_MAX_WAIT_MS = 150;
static volatile unsigned long playbackPrimeDeadline = 0;

// Drain in blocks, and never one byte at a time. BufferPrint writes with
// portMAX_DELAY, so a producer that filled the ring is parked inside
// xStreamBufferSend until a reader makes room: the old queue.read() freed a
// single byte per 1ms pass, which left networkTask -- and with it webSocket.loop()
// -- stalled for seconds after a barge-in.
static void drainAudioBuffer() {
    uint8_t scratch[512];
    int guard = 0;
    while (audioBuffer.available() > 0 && guard++ < 64) {
        if (audioBuffer.readArray(scratch, sizeof(scratch)) <= 0) break;
    }
}

// Stopping playback by simply not writing any more leaves the waveform wherever
// it happened to be and steps it to zero: that step is the click. Play the tail
// of what is already decoded for a few more milliseconds under a falling gain so
// the signal reaches zero smoothly, then drop the rest.
static void fadeOutAndSilence() {
    const int FADE_MS = 24;
    const int fadeFrames = (int)((SAMPLE_RATE * FADE_MS) / 1000);
    int16_t tail[256];
    const float gain = currentVolume / 100.0f;

    int done = 0;
    while (done < fadeFrames) {
        int want = (int)(sizeof(tail) / sizeof(tail[0]));
        if (want > fadeFrames - done) want = fadeFrames - done;

        int got = audioBuffer.readArray((uint8_t *)tail, want * sizeof(int16_t))
                  / (int)sizeof(int16_t);
        if (got <= 0) {
            // Nothing decoded left to fade; ramp from silence so the DMA still
            // ends on zeros rather than on whatever it was last handed.
            memset(tail, 0, want * sizeof(int16_t));
            got = want;
        }
        for (int i = 0; i < got; i++) {
            float g = gain * (1.0f - (float)(done + i) / (float)fadeFrames);
            tail[i] = (int16_t)(tail[i] * g);
        }
        i2s.write((uint8_t *)tail, got * sizeof(int16_t));
        done += got;
    }

    drainAudioBuffer();
    resetPitchShift();
    playbackPrimed = false;
}

unsigned long getSpeakingDuration() {
    if (deviceState == SPEAKING && speakingStartTime > 0) {
        return millis() - speakingStartTime;
    }
    return 0;
}

// networkTask -> webSocket.loop() -> webSocketEvent(WStype_TEXT, ...) -> transitionToSpeaking()
void transitionToSpeaking() {
    vTaskDelay(50);

    i2sInputFlushScheduled = true;

    // Flags only. This runs on networkTask, which is the ring's *writer*, and
    // BufferRTOS is a FreeRTOS StreamBuffer -- safe for one reader and one
    // writer, and nothing more. Draining from here put a second reader
    // alongside audioStreamTask. The consumer already clears the ring at the
    // end of every turn, inside fadeOutAndSilence(), so there is nothing left
    // here to clean up.
    playbackPrimed = false;
    playbackPrimeDeadline = millis() + PLAYBACK_PRIME_MAX_WAIT_MS;
    resetPcmStats();

    deviceState = SPEAKING;
    digitalWrite(I2S_SD_OUT, HIGH);
    noteActivity();
    speakingStartTime = millis();
    Serial.printf("Speaking: heap %u | largest block %u | buffered %d\n",
                  ESP.getFreeHeap(),
                  heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
                  audioBuffer.available());
    
    // webSocket.enableHeartbeat(30000, 15000, 3);
    
    Serial.println("Transitioned to speaking mode");
}

// networkTask -> transitionToListening()
// ( networkTask -> webSocket.loop() -> webSocketEvent(WStype_TEXT, ...) -> (sets scheduleIdleAfterTurn) -> networkTask -> transitionToIdle() )
void transitionToListening() {
    bool wasSpeaking = (deviceState == SPEAKING);
    deviceState = PROCESSING;   
    scheduleIdleAfterTurn = false;

    i2sInputFlushScheduled = true;
    i2sOutputFlushScheduled = true;

    if (wasSpeaking) {
        // A barge-in. Opening the mic now would point it at a speaker that is
        // still emptying the DMA, and the server would transcribe the answer it
        // is in the middle of giving. Wait for audioStreamTask to run the fade;
        // that is the whole of the output latency, so the cap is generous.
        for (int i = 0; i < 20 && i2sOutputFlushScheduled; i++) {
            vTaskDelay(pdMS_TO_TICKS(5));
        }
        vTaskDelay(pdMS_TO_TICKS(20));  // let the faded tail clear the DMA
        i2sInputFlushScheduled = true;  // and drop what the mic caught of it
    }

    deviceState = LISTENING;
    digitalWrite(I2S_SD_OUT, LOW);
    noteActivity();
    Serial.println("Mic open -- listening");
}

// networkTask -> transitionToIdle()
// End of a turn under push-to-talk: the mic stays shut until the button opens
// it again, so the server's VAD never sees audio we did not intend to send.
void transitionToIdle() {
    scheduleIdleAfterTurn = false;
    if (pttOwnsMic()) {
        // The button is still down. Closing the mic here is what silently ate
        // whole utterances: an interruption makes the server report the turn
        // complete while the user is only just starting to speak.
        Serial.println("Ignoring turn-over while the button is held");
        return;
    }
    deviceState = IDLE;
    digitalWrite(I2S_SD_OUT, LOW);
    i2sInputFlushScheduled = true;
    i2sOutputFlushScheduled = true;
    noteActivity();  // the clock starts when the turn ends, not when it began
    Serial.printf("Turn over | starvation %ums | pcm peak %ld maxstep %ld glitches %u\n",
                  worstStarvationMs, (long)pcmPeak, (long)pcmMaxStep,
                  (unsigned)pcmBigSteps);
    worstStarvationMs = 0;
    starvationRun = 0;
}

// audioStreamTask -> copier.copy() (conditional on webSocket.isConnected())
void audioStreamTask(void *parameter) {
    Serial.println("Starting I2S stream pipeline...");
    
    pinMode(I2S_SD_OUT, OUTPUT);

    OpusSettings cfg;
    cfg.sample_rate = SAMPLE_RATE;
    cfg.channels = CHANNELS;
    cfg.bits_per_sample = BITS_PER_SAMPLE;
    // A 120ms Opus frame is 5760 bytes at 24kHz mono s16. Kept at double that
    // so raising AUDIO_OUTPUT_SAMPLE_RATE on the server does not silently
    // truncate frames here.
    cfg.max_buffer_size = 16384;

    xSemaphoreTake(wsMutex, portMAX_DELAY);
    opusDecoder.setOutput(bufferPrint);
    bool decoderStarted = opusDecoder.begin(cfg);

    // arduino-libopus is built with NONTHREADSAFE_PSEUDOSTACK, so it keeps its
    // working arrays off the task stack: the first decode lazily mallocs a
    // single 60KB scratch block, and opus_alloc_scratch() never checks the
    // result. Audio only arrives once WiFi and TLS have taken the heap, and by
    // then that allocation returns null, which opus writes straight through.
    // Do it here instead, while the heap is still whole. 0x08 is a valid
    // TOC-only packet (SILK narrowband, 20ms, mono) that decodes to silence,
    // and the websocket is not up yet so nothing reaches the ring buffer.
    const uint8_t opusWarmupPacket[1] = {0x08};
    opusDecoder.write(opusWarmupPacket, sizeof(opusWarmupPacket));

    // That packet is the cheapest valid one there is, but it is SILK
    // narrowband, and the decoder keeps that mode. The server streams 24kHz, so
    // the first real packet forces a switch out of a state no normal stream
    // would ever start from -- and the transient lands on the first thing the
    // toy ever says, which is the greeting. Re-init clears the decoder.
    //
    // begin() and not end(): begin() re-runs opus_decoder_init over the same
    // buffer and frees nothing, while OpusAudioDecoder::end() calls
    // opus_decoder_destroy() on memory opus never malloc'd. The scratch block
    // the warmup just allocated is a libopus global and survives either way,
    // which is the whole point of doing this here rather than later.
    opusDecoder.begin(cfg);

    xSemaphoreGive(wsMutex);

    Serial.printf("Opus %s | heap %u | largest block %u\n",
                  decoderStarted ? "ready" : "FAILED", ESP.getFreeHeap(),
                  heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));

    // Here and not in setup(): this task owns the output port, so this is the
    // only place the boot sound can install its own I2S without racing anyone,
    // and it is late enough that the decoder already has its scratch block.
    // setup() has not finished yet -- it resumes while this blocks on DMA and
    // brings the radio up, so the sound plays over the association instead of
    // delaying it.
    playBootChime();

    audioBuffer.setReadMaxWait(0);
    
    queue.begin();

    auto config = i2s.defaultConfig(TX_MODE);
    config.bits_per_sample = BITS_PER_SAMPLE;
    config.sample_rate = SAMPLE_RATE;
    config.channels = CHANNELS;
    config.pin_bck = I2S_BCK_OUT;
    config.pin_ws = I2S_WS_OUT;
    config.pin_data = I2S_DATA_OUT;
    config.port_no = I2S_PORT_OUT;
    // buffer_size is fed straight to dma_buf_len, which the legacy I2S driver
    // counts in samples, not bytes. The config leaves tx_desc_auto_clear at
    // audio-tools' default of true, so an underrun outputs zeros rather than
    // replaying the descriptor -- the audible glitch is the discontinuity at
    // each end of the gap, not a replay.
    //
    // Everything queued here is audio we cannot take back without a click, so
    // it is the one buffer a barge-in cannot escape: 8 x 512 meant 170ms of the
    // abandoned answer still had to play. 6 x 256 is 64ms, and the jitter
    // cushion moves to the ring buffer, which PLAYBACK_PRIME_BYTES fills up
    // front and audioStreamTask tops up every 1ms.
    config.buffer_count = 6;
    config.buffer_size = 256;
    // audio-tools defaults I2S_USE_APLL to true on the S3 (AudioConfig.h), and
    // both configs here were taking that default. The chip has exactly one
    // APLL: the mic port asking for it at 16kHz and this one asking for it at
    // 24kHz means whichever starts second retunes the PLL out from under the
    // first, and the output clock is then wrong. The speaker self-test was
    // clean precisely because it ran one port with APLL off. Voice at these
    // rates has no need of the fractional accuracy APLL buys.
    config.use_apll = false;

    config.copyFrom(info);  
    bool i2sStarted = i2s.begin(config);  
    Serial.printf("I2S out %s | heap %u | dma %u\n", i2sStarted ? "ok" : "FAILED",
                  ESP.getFreeHeap(), heap_caps_get_free_size(MALLOC_CAP_DMA));

    // Initialize both volume streams once
    auto vcfg = volume.defaultConfig();
    vcfg.copyFrom(info);
    vcfg.allow_boost = true;
    volume.begin(vcfg);
    
    auto vcfgPitch = volumePitch.defaultConfig();
    vcfgPitch.copyFrom(info);
    vcfgPitch.allow_boost = true;
    volumePitch.begin(vcfgPitch);

    // The streams exist now, so a level restored from NVS at boot can finally
    // be applied -- before this both streams are at their library default.
    applyVolume(currentVolume);

    while (1) {
        if (i2sOutputFlushScheduled) {
            fadeOutAndSilence();
            i2sOutputFlushScheduled = false;
        }

        if (webSocket.isConnected() && deviceState == SPEAKING) {
            if (!playbackPrimed) {
                bool enough = audioBuffer.available() >= (int)PLAYBACK_PRIME_BYTES;
                bool waitedLongEnough = (long)(millis() - playbackPrimeDeadline) >= 0;
                if (!enough && !waitedLongEnough) {
                    starvationRun = 0;  // priming is not starvation
                    vTaskDelay(1);
                    continue;
                }
                playbackPrimed = true;
            }
            // Each pass is ~1ms, so a run of empty passes is roughly the number
            // of milliseconds the pipeline had nothing to play. Once that run
            // exceeds the DMA depth the amp is fed zeros, and the step in and
            // out of that silence is the click. Not counted once the server has
            // said the turn is over: the ring is meant to be empty then, and
            // counting the wait would bury the real figure.
            if (audioBuffer.available() == 0 && !scheduleIdleAfterTurn) {
                if (++starvationRun > worstStarvationMs) {
                    worstStarvationMs = starvationRun;
                }
            } else {
                starvationRun = 0;
            }
            if (currentPitchFactor != 1.0f) {
                pitchCopier.copy();
            } else {
                copier.copy();
            }
        }
        else {
            // Always read: BufferPrint writes with portMAX_DELAY, so a producer
            // that filled the ring stays blocked until something drains it.
            drainAudioBuffer();
        }
        vTaskDelay(1); 
    }
}


// Mic level over the current press, measured on the samples as they go out.
// A press that captured nothing but room noise should not be committed: the
// server would run STT over silence and answer a turn the user never took.
static volatile uint64_t micLevelSum = 0;
static volatile uint32_t micLevelCount = 0;
static volatile int32_t micLevelPeak = 0;

static void resetMicLevel() {
    micLevelSum = 0;
    micLevelCount = 0;
    micLevelPeak = 0;
}

static void accumulateMicLevel(const uint8_t *buffer, size_t size) {
    const int16_t *samples = (const int16_t *)buffer;
    size_t count = size / sizeof(int16_t);
    uint64_t sum = 0;
    int32_t peak = 0;
    for (size_t i = 0; i < count; i++) {
        int32_t magnitude = samples[i] < 0 ? -(int32_t)samples[i] : (int32_t)samples[i];
        sum += magnitude;
        if (magnitude > peak) peak = magnitude;
    }
    micLevelSum += sum;
    micLevelCount += count;
    if (peak > micLevelPeak) micLevelPeak = peak;
}

// Mean magnitude rather than peak: one keyboard click or a knock on the desk
// pushes the peak up without there being any speech to transcribe.
static uint32_t micAverageLevel() {
    uint32_t count = micLevelCount;
    return count == 0 ? 0 : (uint32_t)(micLevelSum / count);
}

class WebsocketStream : public Print {
public:
    // micTask -> micToWsCopier.copyBytes() -> wsStream.write()
    virtual size_t write(uint8_t b) override {
        if (!webSocket.isConnected() || deviceState != LISTENING) {
            return 1;
        }
        
        xSemaphoreTake(wsMutex, portMAX_DELAY);
        webSocket.sendBIN(&b, 1);
        xSemaphoreGive(wsMutex);
        return 1;
    }
    
    // micTask -> micToWsCopier.copyBytes() -> wsStream.write()
    virtual size_t write(const uint8_t *buffer, size_t size) override {
        if (size == 0 || !webSocket.isConnected() || deviceState != LISTENING) {
            return size;
        }

        accumulateMicLevel(buffer, size);

        xSemaphoreTake(wsMutex, portMAX_DELAY);
        webSocket.sendBIN(buffer, size);
        xSemaphoreGive(wsMutex);
        return size;
    }
};

WebsocketStream wsStream; //guard with wsMutex
I2SStream i2sInput; //access from micTask only
StreamCopy micToWsCopier(wsStream, i2sInput);
volatile bool i2sInputFlushScheduled = false;
// 64 bytes meant a websocket frame every 2ms: 500 sends per second, each one
// taking wsMutex and driving a separate TLS write on the task that also
// decodes audio. 512 costs 16ms of extra latency and an eighth of the churn.
const int MIC_COPY_SIZE = 512;

void micTask(void *parameter) {
    // Configure and start I2S input stream.
    auto i2sConfig = i2sInput.defaultConfig(RX_MODE);
    i2sConfig.bits_per_sample = BITS_PER_SAMPLE;
    i2sConfig.sample_rate = MIC_SAMPLE_RATE;
    i2sConfig.channels = CHANNELS;
    i2sConfig.i2s_format = I2S_LEFT_JUSTIFIED_FORMAT;
    i2sConfig.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
    // Configure your I2S input pins appropriately here:
    i2sConfig.pin_bck = I2S_SCK;
    i2sConfig.pin_ws  = I2S_WS;
    i2sConfig.pin_data = I2S_SD;
    i2sConfig.port_no = I2S_PORT_IN;
    // Same single-APLL problem seen from the other side: see audioStreamTask.
    i2sConfig.use_apll = false;
    i2sInput.begin(i2sConfig);

    micToWsCopier.setDelayOnNoData(0);

    while (1) {
        if (i2sInputFlushScheduled) {
            i2sInputFlushScheduled = false;
            i2sInput.flush();
        }

        if (deviceState == LISTENING && webSocket.isConnected()) {
            // Use smaller chunk size to avoid blocking too long
            micToWsCopier.copyBytes(MIC_COPY_SIZE);
            
            // Yield more frequently
            vTaskDelay(1);
        } else {
            vTaskDelay(10);
        }
    }
}

// WEBSOCKET EVENTS
// networkTask -> webSocket.loop() -> webSocketEvent()
void webSocketEvent(WStype_t type, const uint8_t *payload, size_t length)
{
    switch (type)
    {
    case WStype_DISCONNECTED:
        Serial.printf("[WSc] Disconnected!\n");
        deviceState = IDLE;
        // Nothing else takes this path to IDLE, so without this the tail of the
        // interrupted turn would still be in the ring when the next one starts.
        i2sOutputFlushScheduled = true;
        break;
    case WStype_CONNECTED:
        Serial.printf("[WSc] Connected to url: %s\n", payload);
        deviceState = PROCESSING;
        // Each websocket is a fresh session on the server, so nothing the user
        // said before this counts towards it.
        userSpokeThisSession = false;
        break;
    case WStype_TEXT:
    {
        Serial.printf("[WSc] get text: %s\n", payload);

        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, (char *)payload);

        if (error)
        {
            Serial.println("Error deserializing JSON");
            deviceState = IDLE;
            return;
        }

        String type = doc["type"];

        // auth messages
        if (strcmp((char*)type.c_str(), "auth") == 0) {
            // as<float>() on a missing key yields 0, and a factor of 0 makes
            // PitchShiftFixedOutput emit one sample of the grain buffer over
            // and over -- a constant tone at full volume, which is exactly the
            // squeal you hear if a server ever omits the field. Default to
            // 1.0 (no shift) and refuse anything outside a musical range.
            float requestedPitch = doc["pitch_factor"] | 1.0f;
            if (!(requestedPitch >= 0.25f && requestedPitch <= 4.0f)) {
                Serial.printf("Ignoring pitch_factor %.3f, using 1.0\n", requestedPitch);
                requestedPitch = 1.0f;
            }
            currentPitchFactor = requestedPitch;

            bool is_ota = doc["is_ota"].as<bool>();
            bool is_reset = doc["is_reset"].as<bool>();

            // Whoever touched the volume last on the device wins. Without this
            // the level from the server would undo a button press on the next
            // reconnect, and switching character now causes one.
            if (hasLocalVolumeOverride()) {
                applyVolume(currentVolume);
            } else {
                applyVolume(doc["volume_control"].as<int>());
            }
            
            // Only initialize pitch shift if needed
            if (currentPitchFactor != 1.0f) {
                auto pcfg = pitchShift.defaultConfig();
                pcfg.copyFrom(info);
                pcfg.pitch_shift = currentPitchFactor;
                pcfg.buffer_size = 512;
                pitchShift.begin(pcfg);
            }

            if (is_ota) {
                Serial.println("OTA update received");
                setOTAStatusInNVS(OTA_IN_PROGRESS);
                ESP.restart();
            }

            if (is_reset) {
                Serial.println("Factory reset received");
                // setFactoryResetStatusInNVS(true);
                ESP.restart();
            }
        }

        // oai messages
        if (strcmp((char*)type.c_str(), "server") == 0) {
            String msg = doc["msg"];
            Serial.println(msg);

            if (strcmp((char*)msg.c_str(), "RESPONSE.COMPLETE") == 0 || strcmp((char*)msg.c_str(), "RESPONSE.ERROR") == 0) {
                Serial.println("Received RESPONSE.COMPLETE or RESPONSE.ERROR, starting listening again");

                // Check if volume_control is included in the message
                if (doc.containsKey("volume_control")) {
                    int newVolume = doc["volume_control"].as<int>();
                    volume.setVolume(newVolume / 100.0f);
                }

                if (!pttOwnsMic()) {
                    // Let the buffered tail finish playing before shutting the
                    // output down, otherwise the last word gets cut off.
                    scheduleIdleAfterTurn = true;
                    scheduledTime = millis() + 1000;
                }
            } else if (strcmp((char*)msg.c_str(), "AUDIO.COMMITTED") == 0) {
                if (deviceState == SPEAKING) {
                    // The answer to that turn is already playing. Dropping to
                    // PROCESSING here would make WStype_BIN discard every
                    // remaining packet and cut the sentence off mid-word. The
                    // server suppresses the duplicate commit its VAD raises
                    // after an explicit end_of_speech, but a stray one must
                    // never be able to truncate playback.
                    Serial.println("Ignoring AUDIO.COMMITTED while speaking");
                } else if (!pttOwnsMic()) {
                    deviceState = PROCESSING;
                } else if (pttTailUntil != 0 && !pttHeld) {
                    // The turn is closed, so the tail has done its job. Keeping
                    // the mic open past this point only risks the VAD hearing a
                    // noise and interrupting the answer we are waiting for.
                    pttTailUntil = 0;
                    deviceState = PROCESSING;
                    i2sInputFlushScheduled = true;
                    Serial.println("Turn committed, mic closed early");
                }
            } else if (strcmp((char*)msg.c_str(), "RESPONSE.CREATED") == 0) {
                if (pttOwnsMic()) {
                    // Raced with a barge-in. Playing now would cut off the
                    // recording the user is in the middle of making.
                    Serial.println("Ignoring RESPONSE.CREATED while the button is held");
                } else if (!userSpokeThisSession && !greetingWanted) {
                    Serial.println("Ignoring unsolicited greeting after an automatic reconnect");
                } else {
                    greetingWanted = false;
                    Serial.println("Received RESPONSE.CREATED, transitioning to speaking");
                    transitionToSpeaking();
                }
            } else if (strcmp((char*)msg.c_str(), "SESSION.END") == 0) {
                Serial.println("Received SESSION.END, going to sleep");
                sleepRequested = true;
            }
        }
    }
        break;
    case WStype_BIN:
    {
        if (scheduleIdleAfterTurn || deviceState != SPEAKING) {
            // A discarded greeting is dozens of frames; report the run once
            // rather than once per packet, or the log becomes unreadable.
            if (!audioDiscardReported) {
                audioDiscardReported = true;
                Serial.println("Discarding audio: not in speaking state");
            }
            break;
        }
        audioDiscardReported = false;

        // Otherwise process the audio data normally
        size_t processed = opusDecoder.write(payload, length);
        if (processed != length) {
            Serial.printf("Warning: Only processed %d/%d bytes\n", processed, length);
        }
        // opus keeps its working arrays off the task stack, so this should
        // stay comfortable. Reported anyway to keep the assumption honest.
        static UBaseType_t worstStack = UINT32_MAX;
        UBaseType_t stackLeft = uxTaskGetStackHighWaterMark(NULL);
        if (stackLeft < worstStack) {
            worstStack = stackLeft;
            Serial.printf("Decode stack headroom: %u bytes\n", (unsigned)stackLeft);
        }
        break;
      }
    case WStype_ERROR:
        Serial.printf("[WSc] Error: %s\n", payload);    
        break;
    case WStype_FRAGMENT_TEXT_START:
    case WStype_FRAGMENT_BIN_START:
    case WStype_FRAGMENT:
    case WStype_PONG:
    case WStype_PING:
    case WStype_FRAGMENT_FIN:
        break;
    }
}

// wifiTask -> WIFIMANAGER::loop() -> WIFIMANAGER::tryConnect() -> connectCb() -> websocketSetup()
void websocketSetup(const String& server_domain, int port, const String& path)
{
    // Local development override, set at build time (platformio.ini, env
    // `esp32-s3-devkitc-1-localws`). It moves ONLY the voice websocket to a
    // machine on the LAN. The auth token, OTA and factory reset keep talking to
    // the deployed backend, and the local server reads the same Supabase, so
    // the board stays claimed by the same account and resolves the same
    // character and memory as it does against the cloud.
#ifdef LOCAL_WS_HOST
    const String host = LOCAL_WS_HOST;
    const int wsPort = LOCAL_WS_PORT;
    const String wsPath = LOCAL_WS_PATH;
    const bool plaintext = true;  // no certificate for a laptop on the LAN
#else
    const String host = server_domain;
    const int wsPort = port;
    const String wsPath = path;
  #ifdef DEV_MODE
    const bool plaintext = true;
  #else
    const bool plaintext = false;
  #endif
#endif

    Serial.printf("[WS] connecting to %s://%s:%d%s\n", plaintext ? "ws" : "wss",
                  host.c_str(), wsPort, wsPath.c_str());

    const String headers =
        "Authorization: Bearer " + String(authTokenGlobal) + "\r\n" +
        "X-Wifi-Rssi: " + String(WiFi.RSSI()) + "\r\n" +
        "X-Device-Mac: " + WiFi.macAddress();

    xSemaphoreTake(wsMutex, portMAX_DELAY);

    webSocket.setExtraHeaders(headers.c_str());
    webSocket.onEvent(webSocketEvent);
    webSocket.setReconnectInterval(1000);
    // Cloudflare closes a websocket that has been idle for ~100s, and a quiet
    // user easily exceeds that between turns, so keep pinging.
    // Generous timeouts: a 15s pong window was missed while the device was busy
    // decoding audio, and three of those in a row would drop a healthy session.
    // 45s ping interval, 30s pong timeout, drop after 5 missed.
    webSocket.enableHeartbeat(45000, 30000, 5);

    if (plaintext) {
        webSocket.begin(host.c_str(), wsPort, wsPath.c_str());
    } else {
        webSocket.beginSslWithCA(host.c_str(), wsPort, wsPath.c_str(), CA_cert);
    }

    xSemaphoreGive(wsMutex);
}

// A tap shorter than this carried no speech worth sending: the press was there
// to barge in, not to say something.
static const unsigned long PTT_MIN_CAPTURE_MS = 250;
static unsigned long pttPressedAt = 0;

// Mean magnitude below which a press is treated as silence. Deliberately low:
// dropping real speech is far worse in a demo than letting a quiet turn
// through. Every release logs its avg and peak, so tune this against what a
// silent room and a normal sentence actually measure on this mic.
static const uint32_t MIC_SILENCE_LEVEL = 150;

// Releasing the button commits the turn immediately. bot.py no longer mutes STT
// on end_of_speech (that mute used to latch: its only unmute runs when a bot
// turn starts, so a turn with no transcript killed every turn after it), so the
// instruction now does exactly one thing -- close the user turn -- and saves the
// PTT_VAD_TAIL_MS the VAD path spent waiting. Set this back to false to fall
// back to letting the server's VAD close the turn.
static const bool PTT_SEND_EXPLICIT_COMMIT = true;
// Only used when PTT_SEND_EXPLICIT_COMMIT is off. The server's Silero VAD needs
// stop_secs of *continuous* silence before it declares the turn over -- 0.6s for
// the azure STT path, 0.8s otherwise (voice_pipeline.py). Once the mic closes
// there are no more frames for it to count, so a tail equal to stop_secs leaves
// no margin at all: one breath in the tail restarts its timer and the turn never
// closes. Give it double the longest setting.
static const unsigned long PTT_VAD_TAIL_MS = 1600;

// networkTask -> processPushToTalk(), with wsMutex already held.
static void processPushToTalk() {
    if (conversationResetRequested) {
        conversationResetRequested = false;
        // The server builds a fresh LLMContext per websocket session, so
        // dropping the socket is what starts a new conversation. The client's
        // reconnect interval brings it straight back.
        Serial.println("Reset: dropping websocket for a fresh conversation");
        greetingWanted = true;  // this reconnect is the user's doing
        deviceState = IDLE;
        i2sInputFlushScheduled = true;
        i2sOutputFlushScheduled = true;
        webSocket.disconnect();
        pttPressRequested = false;
        pttReleaseRequested = false;
        return;
    }

    // A press during the tail cancels it: the user is talking again.
    if (pttTailUntil != 0 && (pttHeld || millis() >= pttTailUntil)) {
        pttTailUntil = 0;
        if (!pttHeld && deviceState == LISTENING) {
            deviceState = PROCESSING;
            i2sInputFlushScheduled = true;
            Serial.println("Mic closed, waiting for the server to answer");
        }
    }

    if (pttPressRequested) {
        pttPressRequested = false;
        pttPressedAt = millis();
        pttTailUntil = 0;
        resetMicLevel();
        if (webSocket.isConnected()) {
            // Pressing while the bot holds the floor is a barge-in: drop the
            // turn it is streaming before we start capturing the new one.
            if (deviceState == SPEAKING || deviceState == PROCESSING) {
                webSocket.sendTXT("{\"type\":\"instruction\",\"msg\":\"INTERRUPT\"}");
                Serial.println("PTT: INTERRUPT sent");
            }
            transitionToListening();
        }
    }

    if (pttReleaseRequested) {
        pttReleaseRequested = false;
        if (webSocket.isConnected() && deviceState == LISTENING) {
            unsigned long held = millis() - pttPressedAt;
            uint32_t level = micAverageLevel();
            int32_t peak = micLevelPeak;
            if (held < PTT_MIN_CAPTURE_MS) {
                deviceState = PROCESSING;
                i2sInputFlushScheduled = true;
                Serial.printf("PTT: %lums tap, treated as interrupt only\n", held);
                transitionToIdle();
            } else if (level < MIC_SILENCE_LEVEL) {
                // Nothing worth transcribing, so close the mic without a tail:
                // the server's VAD never sees a turn and stays quiet.
                deviceState = PROCESSING;
                i2sInputFlushScheduled = true;
                Serial.printf("PTT: %lums but silent (avg %u, peak %d), discarded\n",
                              held, level, (int)peak);
                transitionToIdle();
            } else if (PTT_SEND_EXPLICIT_COMMIT) {
                deviceState = PROCESSING;
                i2sInputFlushScheduled = true;
                userSpokeThisSession = true;
                webSocket.sendTXT("{\"type\":\"instruction\",\"msg\":\"end_of_speech\"}");
                Serial.printf("PTT: end_of_speech sent after %lums (avg %u, peak %d)\n",
                              held, level, (int)peak);
            } else {
                // Stay in LISTENING so the mic keeps feeding the server a
                // little silence, which is what its VAD needs to close a turn.
                userSpokeThisSession = true;
                pttTailUntil = millis() + PTT_VAD_TAIL_MS;
                Serial.printf("PTT: %lums captured (avg %u, peak %d), %lums VAD tail\n",
                              held, level, (int)peak, PTT_VAD_TAIL_MS);
            }
        }
    }
}

// networkTask -> webSocket.loop()
void networkTask(void *parameter) {
    while (1) {
        xSemaphoreTake(wsMutex, portMAX_DELAY);

        processPushToTalk();

        if (scheduleIdleAfterTurn && millis() >= scheduledTime) {
            transitionToIdle();
        }

        webSocket.loop();
        xSemaphoreGive(wsMutex);

        vTaskDelay(1);
    }
}
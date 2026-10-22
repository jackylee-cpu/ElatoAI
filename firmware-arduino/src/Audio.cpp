#include "CrashReport.h"
#include "OTA.h"
#include "Audio.h"
#include "WifiManager.h"
#include "DecodeStats.h"
#include "Chime.h"
#include "PitchShift.h"
#include "Codec.h"
#include "IoExpander.h"
#include "LEDHandler.h"
#include "SupplyMonitor.h"
#include "Battery.h"
#if BOARD_MIC_DOWNSAMPLE_3_2
#include "Downsample.h"
#endif
#include "MicAdpcm.h"
#include "ServerReach.h"
#include <esp_heap_caps.h>
#include <esp_timer.h>

// libopus' pseudo-stack (celt/stack_alloc.h, NONTHREADSAFE_PSEUDOSTACK). Seeded
// by decodeTask on boards without PSRAM; see kOpusScratchBytes.
extern "C" {
extern char *global_stack;
extern char *scratch_ptr;
}
#include <soc/soc_memory_types.h>
#include <freertos/message_buffer.h>

// WEBSOCKET
SemaphoreHandle_t wsMutex;
WebSocketsClient webSocket;

// TASK HANDLES
TaskHandle_t speakerTaskHandle = NULL;
TaskHandle_t micTaskHandle = NULL;
TaskHandle_t networkTaskHandle = NULL;
TaskHandle_t decodeTaskHandle = NULL;

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

// Set when a press ran past PTT_MAX_CAPTURE_MS. The button is still physically
// down, but the device has already closed the turn, so every "the button is
// held" rule below has to stop applying to it.
static bool pttCapped = false;

// True while the button is down and the press still owns the turn.
static bool pttCapturing() { return pttHeld && !pttCapped; }

// True while the press or the tail is still running -- i.e. while the device,
// not the server, owns the mic.
static bool pttOwnsMic() { return pttCapturing() || pttTailUntil != 0; }

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

// A level set from the web app. That is the newest touch, so it also drops a
// level the buttons left in NVS -- otherwise every later auth frame would put
// the button level back. Called from networkTask; its own handle for the same
// reason audioPrefs has one.
void applyRemoteVolume(int volumePercent) {
    applyVolume(volumePercent);
    if (hasLocalVolumeOverride()) {
        Preferences prefs;
        prefs.begin("audio", false);
        prefs.remove("volume");
        prefs.end();
    }
    Serial.printf("Volume set remotely -> %d\n", currentVolume);
}

// Called from the hardware buttons. Persisting here is what makes the physical
// control authoritative: the server sends a volume in every auth frame, and a
// character switch forces a reconnect, so without this a button press would be
// undone seconds later.
bool nudgeVolume(int delta) {
    const int before = currentVolume;
    applyVolume(currentVolume + delta);
    if (currentVolume == before) {
        // Already at the limit. A held button repeats every 160ms for as long
        // as it is held, so persisting and logging here would be an NVS open,
        // write and close plus a serial line six times a second, forever, for
        // a value that did not change. The caller acknowledges instead.
        return false;
    }
    audioPrefs.begin("audio", false);
    audioPrefs.putInt("volume", currentVolume);
    audioPrefs.end();
    Serial.printf("Volume %+d -> %d\n", delta, currentVolume);
    return true;
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
        const int written = _buffer.writeArray(&data, 1);
        decodeStatsAddPcmBytes(written > 0 ? (size_t)written : 0);
        return written;
    }
    return 1; //let opusDecoder write, otherwise thread will stuck
  }

  // networkTask -> webSocket.loop() -> webSocketEvent(WStype_BIN, ...) -> opusDecoder.write() -> bufferPrint.write()
  virtual size_t write(const uint8_t *buffer, size_t size) override {
    if (webSocket.isConnected() && deviceState == SPEAKING) {
        inspectDecodedPcm(buffer, size);
        // writeArray() waits portMAX_DELAY for room, so on a full ring this is
        // where the decoding task stops being a decoding task. Timed rather
        // than assumed: it is the whole of the case for moving the decode off
        // the task that also reads the socket.
        const int64_t blockedAt = esp_timer_get_time();
        const int written = _buffer.writeArray(buffer, size);
        decodeStatsAddRingBlockUs((uint32_t)(esp_timer_get_time() - blockedAt));
        decodeStatsAddPcmBytes(written > 0 ? (size_t)written : 0);
        return written;
    }
    return size; //let opusDecoder write, otherwise thread will stuck
  }

private:
  BufferRTOS<uint8_t>& _buffer;
};

BufferPrint bufferPrint(audioBuffer);

// ---------------------------------------------------------------------------
// Where the audio buffers actually live
//
// This build has CONFIG_SPIRAM_USE_MALLOC=1 with CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL
// at 4096 (framework-arduinoespressif32/tools/sdk/esp32s3/qio_opi/include/sdkconfig.h),
// which means heap_caps_malloc_default() sends *every* allocation over 4KB to
// PSRAM first and only falls back to internal RAM if that fails. Every buffer
// on this path is over 4KB, so all of them were in external RAM:
//
//   - the PCM ring below (20KB). The previous allocator here was
//     audio_tools::Allocator, whose do_allocate() is plain calloc() -- the
//     comment said "internal SRAM" and the 4096 rule quietly overruled it.
//   - the Opus decoder state (~18KB, via audio-tools' AllocatorExt, which
//     tries ps_malloc explicitly).
//   - libopus' 60KB pseudostack scratch (opus_alloc_scratch -> malloc).
//
// On the S3 that memory is reached through the same cache as the code, which
// also runs from flash -- so a decoder walking its state in PSRAM evicts the
// instructions decoding it. The two that matter are the ones touched randomly
// and constantly: the decoder state and the scratch. The ring matters for a
// different reason -- it is drained at a fixed 48KB/s by the I2S DMA and must
// not jitter against flash access.
//
// The decode *output* buffer stays in PSRAM deliberately: opus_decode() fills
// it front to back and the copy to the ring reads it front to back, which is
// the access pattern external RAM is actually good at, and it is 16KB of
// internal RAM this board cannot spare.
//
// Nothing here is allowed to fail: every allocation falls back to PSRAM, i.e.
// to exactly the behaviour that was in place before. audioMemoryReport() prints
// what each one got once Serial is up -- these run from static constructors,
// long before anything can be logged.
namespace {

struct Placement {
    const char *what;
    void *address;
    size_t bytes;
    bool internalRam;
};

Placement placements[4];
size_t placementCount = 0;

// libopus' pseudostack does not go through an Allocator -- it is a plain
// malloc() inside the library -- so its outcome is recorded separately and
// printed by the same report.
struct ScratchResult {
    bool decided;
    bool forcedInternal;
    size_t internalBefore;
    size_t internalAfter;
};
ScratchResult scratchResult = {false, false, 0, 0};

// Without PSRAM (the xmini-c3) libopus' default 60KB scratch would cost a
// quarter of the chip's RAM, and with it gone the radio and TLS do not fit. It
// is sized for the *encoder*; this firmware only decodes. Measured on the host
// 2026-09-23 with this library's own opus_config.h (FIXED_POINT, mono): over
// 405 encoder configurations -- 16/24/48kHz input, VOIP/AUDIO/LOWDELAY, 6 to
// 64kbps, 2.5 to 120ms frames, plus PLC and FEC decodes -- the decoder's peak
// pseudo-stack use was 6880 bytes, at 16kHz output and at 24kHz alike. 16KB is
// that with more than 2x to spare, and audioMemoryReport() prints the on-device
// high-water mark so the margin is checked on real traffic, not assumed.
//
// libopus never bounds-checks this stack, so an overflow would be silent
// corruption; the report is the guard.
#ifndef BOARD_HAS_PSRAM
constexpr size_t kOpusScratchBytes = 16 * 1024;
constexpr uint8_t kOpusScratchFill = 0xA5;
char *opusScratch = nullptr;

size_t opusScratchHighWater() {
    if (opusScratch == nullptr) return 0;
    size_t i = kOpusScratchBytes;
    while (i > 0 && (uint8_t)opusScratch[i - 1] == kOpusScratchFill) i--;
    return i;
}
#endif

void notePlacement(const char *what, void *address, size_t bytes) {
    if (placementCount >= (sizeof(placements) / sizeof(placements[0]))) return;
    placements[placementCount++] = {what, address, bytes,
                                    address != nullptr && !esp_ptr_external_ram(address)};
}

}  // namespace

// The A/B switch for the two buffers above: `-D AUDIO_BUFFERS_IN_PSRAM` puts
// them back where the sdkconfig would have put them, so the two builds can be
// flashed one after the other and their `cpu` figures compared. See the
// `-psrambufs` environment in platformio.ini. Placement is the kind of claim
// that is easy to argue and cheap to measure; measure it. It no longer covers
// libopus' 60KB scratch, which that measurement sent back to PSRAM for good.
#ifdef AUDIO_BUFFERS_IN_PSRAM
static constexpr bool kPreferInternalRam = false;
#else
static constexpr bool kPreferInternalRam = true;
#endif

class InternalRamAllocator : public audio_tools::Allocator {
public:
    explicit InternalRamAllocator(const char *what) : _what(what) {}

protected:
    void *do_allocate(size_t size) override {
        if (size == 0) size = 1;
        // MALLOC_CAP_INTERNAL, not calloc: this is the only way to say "not
        // PSRAM" while CONFIG_SPIRAM_USE_MALLOC is on.
        const uint32_t first = kPreferInternalRam ? MALLOC_CAP_INTERNAL : MALLOC_CAP_SPIRAM;
        const uint32_t second = kPreferInternalRam ? MALLOC_CAP_SPIRAM : MALLOC_CAP_INTERNAL;
        void *result = heap_caps_calloc(1, size, first | MALLOC_CAP_8BIT);
        if (result == nullptr) {
            result = heap_caps_calloc(1, size, second | MALLOC_CAP_8BIT);
        }
        notePlacement(_what, result, size);
        return result;
    }

private:
    const char *_what;
};

// One line per buffer. Called once from decodeTask and again from loop()'s
// four-second replay: everything here is placed during setup, and on this board
// setup's output is lost to USB CDC enumeration. Safe to call repeatedly -- it
// only reads what the allocators recorded.
void audioMemoryReport() {
    for (size_t i = 0; i < placementCount; i++) {
        const Placement &p = placements[i];
        Serial.printf("Audio memory | %-14s %6u B at %p -> %s\n", p.what,
                      (unsigned)p.bytes, p.address, p.internalRam ? "INTERNAL" : "psram");
    }
#ifndef BOARD_HAS_PSRAM
    if (opusScratch != nullptr) {
        Serial.printf("Audio memory | %-14s %6u B at %p -> INTERNAL (high water %u B)\n",
                      "opus scratch", (unsigned)kOpusScratchBytes, opusScratch,
                      (unsigned)opusScratchHighWater());
    } else
#endif
    if (scratchResult.decided) {
        // Not steered by kPreferInternalRam: it is always PSRAM now, on
        // measured evidence. See decodeTask().
        Serial.printf("Audio memory | %-14s %6u B         -> %s (internal free %u -> %u)\n",
                      "opus scratch", 60000,
                      scratchResult.forcedInternal ? "INTERNAL" : "psram",
                      (unsigned)scratchResult.internalBefore,
                      (unsigned)scratchResult.internalAfter);
    }
    Serial.printf("Audio memory | free: internal %u, psram %u, largest internal block %u\n",
                  (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                  (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
                  (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
}

static InternalRamAllocator pcmRingAllocator("pcm ring");
static InternalRamAllocator opusStateAllocator("opus state");

BufferRTOS<uint8_t> audioBuffer(AUDIO_BUFFER_SIZE, AUDIO_CHUNK_SIZE, portMAX_DELAY,
                                portMAX_DELAY, pcmRingAllocator);  //producer: decodeTask, consumer: audioStreamTask. Thread safe in single producer->single consumer scenario.

/**
 * OpusAudioDecoder with its state buffer placed by hand.
 *
 * `decbuf` holds the OpusDecoder struct itself -- the SILK and CELT histories,
 * the overlap buffers, the resampler state -- which opus_decode() walks on
 * every frame. It is the one allocation on this path with a genuinely random
 * access pattern, so it is the one worth spending internal RAM on. Both members
 * are protected, which is the only reason this subclass exists.
 */
class PlacedOpusDecoder : public OpusAudioDecoder {
public:
    /// Must be called before begin(): Vector only consults its allocator on resize.
    void placeStateInInternalRam(audio_tools::Allocator &allocator) {
        decbuf.setAllocator(allocator);
    }
};

PlacedOpusDecoder opusDecoder;  //owned by decodeTask
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

// Set when a turn ends or is abandoned; decodeTask throws away whatever of the
// old answer is still queued rather than spending CPU decoding audio that
// BufferPrint will discard anyway. Lives up here with the other flush flags
// because the transitions that raise it run well before decodeTask is defined.
static volatile bool packetQueueFlushScheduled = false;

// Raised by audioStreamTask once the I2S port is up. Only meaningful where the
// codecs share one port: micTask cannot install a driver of its own there, so
// it has to wait for the output side to install the one they both use.
static volatile bool i2sBusReady = false;

// These transitions all call boardSetSpeakerAmp(), which does different things
// on the two boards. On the Waveshare board it really does gate the NS4150B,
// through the I2C expander, so the amplifier is off whenever the device is not
// speaking. On the breadboard kit it drives the spare GPIO below and mutes
// nothing, which is the behaviour everything after this comment was written
// for, and the reason silence still has to be written rather than switched off.
//
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
// ~21ms at 24kHz mono s16, out of the 416ms ring.
//
// This was 8192 (~170ms), then 4096 on the argument that 40ms frames make
// jitter arrive in finer steps. Both numbers were reasoned, not measured. Swept
// on hardware 2026-09-11, one greeting turn each, everything else identical:
//
//   prime   cushion   first audio out   worst starvation run   glitches
//    4096      85ms            +136ms                    9ms          0
//    2048      42ms             +52ms                   13ms          0
//    1024      21ms             +12ms                   10ms          0
//       0       0ms             +14ms                   11ms          0
//
// The cushion costs up to 120ms of time-to-first-word and buys nothing back:
// starvation is flat across the whole sweep, inside its own run-to-run spread
// (0-14ms across every turn measured that day). It was redundant. The jitter it
// was meant to absorb is already absorbed twice over -- by the 64KB packet
// queue upstream of the decoder, and by the 64ms of I2S DMA downstream of the
// ring -- and the server pushes at twice real time, so the ring refills faster
// than it drains anyway.
//
// 1024 rather than 0 because 0 is the same latency for less margin: the two are
// within noise of each other on first audio, so there is no reason to give up
// the last packet of cushion.
//
// The safety check is that a starvation *run* has to exceed the DMA depth
// before anything reaches the amplifier, and the worst run anywhere in the
// sweep was 13ms against 64ms of DMA. If playback ever does stutter this is
// still the knob -- raise it and watch that figure -- but raise it on a
// measurement, not on the argument that more buffer must be safer.
//
// Overridable at build time so the floor can be swept without editing this
// file: PLATFORMIO_BUILD_FLAGS="-DAUDIO_PLAYBACK_PRIME_BYTES=2048" etc.
#ifndef AUDIO_PLAYBACK_PRIME_BYTES
#define AUDIO_PLAYBACK_PRIME_BYTES 1024
#endif
static const size_t PLAYBACK_PRIME_BYTES = AUDIO_PLAYBACK_PRIME_BYTES;
// ...but never wait longer than this for it. A reply shorter than
// PLAYBACK_PRIME_BYTES of PCM (85ms) would otherwise never reach the
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

    // Flags only. BufferRTOS is a FreeRTOS StreamBuffer -- safe for exactly
    // one reader and one writer, and nothing more -- so draining from here
    // would put a second reader alongside audioStreamTask. (This used to run
    // on the ring's writer; since the decode moved to decodeTask it is neither
    // end of it, which makes touching the ring from here worse, not better.)
    // The consumer already clears the ring at the end of every turn, inside
    // fadeOutAndSilence(), so there is nothing left here to clean up.
    playbackPrimed = false;
    playbackPrimeDeadline = millis() + PLAYBACK_PRIME_MAX_WAIT_MS;
    resetPcmStats();
    decodeStatsBeginTurn();

    deviceState = SPEAKING;
    boardSetSpeakerAmp(true);
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
    // The PCM ring is cleared by audioStreamTask below; the compressed packets
    // behind it have to go too, or decodeTask spends the next second refilling
    // the ring with the answer the user just interrupted.
    packetQueueFlushScheduled = true;

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
    boardSetSpeakerAmp(false);
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
    boardSetSpeakerAmp(false);
    i2sInputFlushScheduled = true;
    i2sOutputFlushScheduled = true;
    packetQueueFlushScheduled = true;
    noteActivity();  // the clock starts when the turn ends, not when it began
    Serial.printf("Turn over | starvation %ums | pcm peak %ld maxstep %ld glitches %u\n",
                  worstStarvationMs, (long)pcmPeak, (long)pcmMaxStep,
                  (unsigned)pcmBigSteps);
    decodeStatsLogTurn();
    worstStarvationMs = 0;
    starvationRun = 0;
}

// ---------------------------------------------------------------------------
// Opus packets: networkTask -> decodeTask
//
// Decoding used to happen inside webSocketEvent(), on networkTask, which meant
// the task that reads the socket and sends the button presses was also the task
// that parked in xStreamBufferSend whenever the PCM ring was full. And the ring
// is full for most of a turn by design: the server pushes at twice real time
// (pipecat's websocket output transport sleeps half a chunk per chunk), so it
// runs ahead until something stops it, and the thing that stopped it was this
// device refusing to read. That is correct backpressure landing on entirely the
// wrong task -- webSocket.enableHeartbeat()'s comment already records a pong
// window missed "while the device was busy decoding audio", and the same stall
// delays a barge-in by however long the ring takes to drain.
//
// So the blocking moves to a task whose only job is to block: decodeTask waits
// on the ring, and networkTask hands over a compressed packet and returns.
//
// The handover buffer is deliberately generous and deliberately in PSRAM. Opus
// packets are compressed, latency-insensitive bytes -- nobody waits on them the
// way the I2S DMA waits on the PCM ring -- which is exactly what external RAM
// is for. 64KB holds around twelve seconds of audio at the server's 40kbps
// (it was twenty at 24kbps), so in practice most of the backlog the server
// builds up lives here and networkTask rarely blocks. When it does, it waits
// for the decoder to free one 40ms packet, not for the whole backlog.
//
// If it ever does overflow, the send blocks -- and it blocks inside
// webSocketEvent(), which holds wsMutex, so that is the old stall in miniature.
// It is still the right trade: dropping a packet is a hole in the middle of a
// sentence, and twenty seconds of backlog means something upstream is already
// badly wrong. The `ws gap max` figure in the per-turn log is what to watch.
constexpr size_t PACKET_QUEUE_BYTES = 64 * 1024;
static StaticMessageBuffer_t packetQueueStruct;
static MessageBufferHandle_t packetQueue = nullptr;

// main.cpp setup() -> audioPacketQueueSetup()
// Before any task exists, because networkTask has the highest priority in the
// system and will be dispatching websocket frames the moment it is created.
void audioPacketQueueSetup() {
    uint8_t *storage = (uint8_t *)heap_caps_malloc(PACKET_QUEUE_BYTES,
                                                   MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (storage == nullptr) {
        // No PSRAM, or it is full. Internal RAM would work but 64KB of it is
        // most of what is left, so fall back to a much smaller queue: the
        // backlog then lands on TCP instead, which is slower but still correct.
        storage = (uint8_t *)heap_caps_malloc(8 * 1024, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        packetQueue = storage ? xMessageBufferCreateStatic(8 * 1024, storage, &packetQueueStruct)
                              : nullptr;
        Serial.printf("Opus packet queue: PSRAM unavailable, %s\n",
                      packetQueue ? "8KB in internal RAM" : "FAILED");
        return;
    }
    packetQueue = xMessageBufferCreateStatic(PACKET_QUEUE_BYTES, storage, &packetQueueStruct);
    Serial.printf("Opus packet queue: %u KB at %p (%s) | internal free %u\n",
                  (unsigned)(PACKET_QUEUE_BYTES / 1024), storage,
                  esp_ptr_external_ram(storage) ? "psram" : "internal",
                  heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
}

// networkTask -> webSocket.loop() -> webSocketEvent(WStype_BIN, ...) -> audioQueueOpusPacket()
// Returns false only if the packet could not be handed over at all.
static bool audioQueueOpusPacket(const uint8_t *payload, size_t length) {
    if (packetQueue == nullptr) return false;
    return xMessageBufferSend(packetQueue, payload, length, portMAX_DELAY) == length;
}

// decodeTask -> opusDecoder.write() -> bufferPrint.write() -> audioBuffer
// The most PCM one Opus packet can decode to: 120ms, the longest frame Opus
// can express, of mono s16 at the output rate (5760 bytes at 24kHz).
static const size_t MAX_DECODED_PACKET_BYTES = SAMPLE_RATE * 2 * 120 / 1000;

void decodeTask(void *parameter) {
    OpusSettings cfg;
    cfg.sample_rate = SAMPLE_RATE;
    cfg.channels = CHANNELS;
    cfg.bits_per_sample = BITS_PER_SAMPLE;
    // This is the decode *output* buffer, and OpusAudioDecoder derives
    // opus_decode()'s frame_count from it -- so it caps the longest packet
    // this build can decode at all, not just the one the server happens to
    // send. A packet larger than it fails with OPUS_BUFFER_TOO_SMALL and is
    // dropped silently into a LOGW.
    //
    // The server now sends 40ms frames (1920 bytes at 24kHz mono s16), but it
    // is deployed separately from this firmware: a device in the field must
    // still decode the 120ms frames (5760 bytes) an older or rolled-back
    // server sends, and 120ms is the longest packet Opus can express. Kept at
    // 16384 for that, and for headroom if AUDIO_OUTPUT_SAMPLE_RATE is ever
    // raised. Do not shrink this to fit the current frame size.
    //
    // Without PSRAM (the xmini-c3) those 16KB come out of the same internal RAM
    // as the radio and TLS, so it is sized to exactly the 120ms worst case at
    // the board's own output rate instead -- 3840 bytes at 16kHz -- which
    // still honours the rule above.
#ifdef BOARD_HAS_PSRAM
    cfg.max_buffer_size = 16384;
#else
    cfg.max_buffer_size = SAMPLE_RATE * 120 / 1000 * CHANNELS * (BITS_PER_SAMPLE / 8);
#endif

    // No wsMutex any more: this task is the only thing that touches the
    // decoder. It used to be shared with networkTask, which is precisely the
    // arrangement this change exists to undo.
    opusDecoder.setOutput(bufferPrint);
    // Before begin(), which is what actually sizes the buffer.
    opusDecoder.placeStateInInternalRam(opusStateAllocator);
    bool decoderStarted = opusDecoder.begin(cfg);

    // arduino-libopus is built with NONTHREADSAFE_PSEUDOSTACK, so it keeps its
    // working arrays off the task stack: the first decode lazily mallocs a
    // single 60KB scratch block, and opus_alloc_scratch() never checks the
    // result. Audio only arrives once WiFi and TLS have taken the heap, and by
    // then that allocation returns null, which opus writes straight through.
    // Do it here instead, while the heap is still whole -- this task is created
    // before setupWiFi() and outranks the Arduino loop task that calls it, so
    // it reaches this line first. 0x08 is a valid TOC-only packet (SILK
    // narrowband, 20ms, mono) that decodes to silence, and the websocket is not
    // up yet so nothing reaches the ring buffer.
    //
    // It goes to PSRAM, which is where CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=4096
    // sends it on its own. This build did briefly force it into internal RAM --
    // heap_caps_malloc_extmem_enable() raised the always-internal threshold for
    // exactly this call -- and the hardware says it was not worth it.
    //
    // Measured 2026-09-11 over a full greeting turn, 40ms frames: with the
    // ring, the decoder state and this scratch all in internal RAM, decode cost
    // 7900us per packet (n=19 scheduler-suspended samples); with all three in
    // PSRAM, 8341us (n=13). 5.3%, for 98KB of the scarcest memory on the chip --
    // and the scratch is 60KB of that 98KB. The radio is not up yet at this
    // point (setupWiFi() runs after this task), so every byte taken here is
    // taken from the wifi driver and the mbedTLS session buffers later.
    //
    // The before/after is still measured, because "where did 60KB go" is worth
    // one line in the boot log even when the answer is never going to change.
    const size_t internalBefore = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);

#ifndef BOARD_HAS_PSRAM
    // Hand libopus its pseudo-stack before the warmup below would malloc the
    // 60KB default: ALLOC_STACK only allocates while global_stack is null. See
    // kOpusScratchBytes.
    opusScratch = (char *)heap_caps_malloc(kOpusScratchBytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (opusScratch != nullptr) {
        memset(opusScratch, kOpusScratchFill, kOpusScratchBytes);
        scratch_ptr = global_stack = opusScratch;
    }
#endif

    const uint8_t opusWarmupPacket[1] = {0x08};
    opusDecoder.write(opusWarmupPacket, sizeof(opusWarmupPacket));

    scratchResult = {true, false, internalBefore,
                     heap_caps_get_free_size(MALLOC_CAP_INTERNAL)};

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

    Serial.printf("Opus %s | heap %u | largest block %u | internal free %u\n",
                  decoderStarted ? "ready" : "FAILED", ESP.getFreeHeap(),
                  heap_caps_get_largest_free_block(MALLOC_CAP_8BIT),
                  heap_caps_get_free_size(MALLOC_CAP_INTERNAL));

    // Only now: the ring was placed by a static constructor, long before there
    // was anywhere to print to, but the decoder's state buffer is not placed
    // until begin() above sizes it. Reporting any earlier would print the ring
    // and silently omit the allocation this is mostly here to check.
    audioMemoryReport();

    // One packet at a time. Sized for the longest packet Opus can express at
    // this bitrate with room to spare; a longer one is refused by
    // xMessageBufferReceive and dropped, which is the same outcome as the
    // OPUS_BUFFER_TOO_SMALL above and just as loud in the log.
    static uint8_t packet[1500];

    while (1) {
        if (packetQueue == nullptr) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }

        // Wake up periodically even with nothing queued, so a flush requested
        // between turns is honoured promptly rather than on the next packet.
        size_t length = xMessageBufferReceive(packetQueue, packet, sizeof(packet),
                                              pdMS_TO_TICKS(50));

        if (packetQueueFlushScheduled) {
            packetQueueFlushScheduled = false;
            length = 0;
            // xMessageBufferReset() needs the buffer to be idle on both ends,
            // which it is not while networkTask may be mid-send. Draining by
            // reading is always safe, and the queue is never deep enough at
            // this point for the loop to matter.
            int guard = 0;
            while (guard++ < 2048 &&
                   xMessageBufferReceive(packetQueue, packet, sizeof(packet), 0) > 0) {
            }
        }

        if (length == 0) continue;

        // The same guard WStype_BIN used to apply before decoding. A packet
        // that arrives after the turn is over decodes into a BufferPrint that
        // discards it, so the only thing decoding it would buy is CPU.
        if (scheduleIdleAfterTurn || deviceState != SPEAKING) continue;

        // Once per turn, decode one packet with this core's scheduler stopped.
        // Every other figure here is wall clock and therefore mostly a record
        // of this task -- priority 2, under three others on this core -- being
        // preempted; this is the one that is actually decode cost.
        //
        // Safe to suspend for: the I2S DMA holds 64ms (6 x 256 frames) and the
        // ring behind it holds up to 416ms, so audioStreamTask losing a couple
        // of milliseconds cannot reach the amplifier. ISRs still run.
        //
        // Only with room in the ring for the whole decoded packet, though.
        // writeArray() waits for space, and with the scheduler stopped the
        // speaker task that makes space can never run: the board froze
        // mid-turn until the task watchdog rebooted it -- about one boot in
        // seven on the C3, whose ring is smaller (P2-11, 2026-10-08). A
        // skipped sample just waits for the next one.
        const bool cpuSample = decodeStatsWantsCpuSample() &&
                               audioBuffer.availableForWrite() >= (int)MAX_DECODED_PACKET_BYTES;
        if (cpuSample) vTaskSuspendAll();

        const int64_t decodeStartedAt = esp_timer_get_time();
        const size_t processed = opusDecoder.write(packet, length);
        const uint32_t writeTotalUs = (uint32_t)(esp_timer_get_time() - decodeStartedAt);

        if (cpuSample) {
            xTaskResumeAll();
            // decodeStatsNotePacketDecoded() below drains the ring-block
            // accumulator, so read it out of the same subtraction it does.
            decodeStatsNoteCpuSample(writeTotalUs);
        }

        // The decoded byte count comes from BufferPrint, not from a delta on
        // audioBuffer.available() -- audioStreamTask is draining that ring
        // concurrently, so the delta undercounts and silently inflates rtf.
        decodeStatsNotePacketDecoded(writeTotalUs);

        if (processed != length) {
            Serial.printf("Warning: Only processed %u/%u bytes\n", (unsigned)processed,
                          (unsigned)length);
        }

        // opus keeps its working arrays off the task stack, so this should
        // stay comfortable. Reported anyway to keep the assumption honest.
        static UBaseType_t worstStack = UINT32_MAX;
        UBaseType_t stackLeft = uxTaskGetStackHighWaterMark(NULL);
        if (stackLeft < worstStack) {
            worstStack = stackLeft;
            Serial.printf("Decode stack headroom: %u bytes\n", (unsigned)stackLeft);
        }
    }
}

// audioStreamTask -> copier.copy() (conditional on webSocket.isConnected())
void audioStreamTask(void *parameter) {
    Serial.println("Starting I2S stream pipeline...");
    
    audioBuffer.setReadMaxWait(0);
    
    queue.begin();

    // RXTX_MODE where the two codecs share BCLK and LRCK: one driver, one set
    // of clocks, data out to the ES8311 on pin_data and data in from the
    // ES7210 on pin_data_rx. micTask reads from this same object rather than
    // installing a second driver on the port.
#if BOARD_SHARED_I2S_BUS
    auto config = i2s.defaultConfig(RXTX_MODE);
    config.pin_data_rx = I2S_SD;
    // One config serves both directions here, and the default of
    // I2S_CHANNEL_FMT_RIGHT_LEFT is wrong for the read side: with channels=1
    // audio-tools would satisfy it by reading twice as many bytes into a
    // variable-length array on micTask's stack and averaging the two ES7210
    // channels down to one. That is a 1KB stack allocation per 512-byte copy
    // and a comb filter across two spaced microphones.
    //
    // ONLY_LEFT makes isNoChannelConversion() true, so both directions go
    // straight to i2s_read()/i2s_write() with no conversion at all: the mic
    // side captures the left slot, which is the ES7210's microphone 1, and the
    // speaker side puts mono samples in the left slot, which is what the mono
    // ES8311 reads. It is also what the breadboard kit's mic port already did.
    config.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
#else
    auto config = i2s.defaultConfig(TX_MODE);
#endif
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
#if BOARD_SHARED_I2S_BUS
    // The single-APLL argument above does not apply here: there is only one
    // port, so nothing can retune the PLL out from under it. A codec wants an
    // exact MCLK -- the ES8311 locks a DLL to it -- and APLL is what makes
    // 4.096MHz exact rather than the nearest fractional divider to it. The C3
    // has no APLL, so there it is the fractional divider regardless.
    config.use_apll = BOARD_I2S_USE_APLL;
    // Left at the driver default, which is 256 x the sample rate. Both
    // coefficient tables in Codec.cpp are indexed on that multiple, so
    // changing it here means changing them too.
    config.pin_mck = I2S_MCLK_OUT;
#else
    config.use_apll = false;
#endif

    config.copyFrom(info);  
    bool i2sStarted = i2s.begin(config);  
    Serial.printf("I2S out %s | heap %u | dma %u\n", i2sStarted ? "ok" : "FAILED",
                  ESP.getFreeHeap(), heap_caps_get_free_size(MALLOC_CAP_DMA));

    // Order matters: the ES8311 locks its internal DLL to MCLK, and MCLK does
    // not exist until the driver above is running. Configuring the codecs
    // first would leave both chips clocked from nothing.
    codecBegin(SAMPLE_RATE, BITS_PER_SAMPLE);
    i2sBusReady = true;

    // Only now is it safe to unmute: the amplifier is downstream of a DAC that
    // has just been powered up, and enabling it earlier puts that step through
    // the speaker. On the breadboard kit this falls back to the spare GPIO and
    // changes nothing.
    boardSetSpeakerAmp(true);

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

    // After i2s.begin(), deliberately: the boot sound plays through the port
    // this task owns rather than installing and tearing down one of its own.
    // setup() has not finished yet -- it resumes while this blocks on DMA and
    // brings the radio up, so the sound plays over the association instead of
    // delaying it.
#ifndef SKIP_BOOT_CHIME
    // A restart to get back to the server (ServerReach.cpp) is not a boot
    // anyone asked for; it should not announce itself.
    if (serverReachSilentBoot()) {
        Serial.println("Chime: boot skipped (recovery restart)");
    } else {
        playBootChime();
    }
#ifdef ASSET_PROMPT_TEST
    void playAssetPromptTest();
    playAssetPromptTest();
#endif
#else
    Serial.println("Chime: boot skipped (SKIP_BOOT_CHIME)");
#endif

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
            // The stamp goes here rather than at the decode, because this is
            // the first point in the turn where audio is actually on its way
            // to the amplifier: everything upstream of it can be running well
            // while PLAYBACK_PRIME_BYTES still holds the speaker silent.
            const size_t played = (currentPitchFactor != 1.0f)
                                      ? pitchCopier.copy()
                                      : copier.copy();
            if (played > 0) decodeStatsNoteAudioOut();
        }
        else {
#if BOARD_LOW_BATTERY_VIA_VDD
            // Here because this task owns the port. Idle only, so it never
            // talks over the toy or into an open mic; a reminder that falls
            // due mid-conversation waits for the turn to end.
            if (deviceState == IDLE && supplyTakeReminder()) {
                playLowBatteryReminder();
            }
#endif
            // "正在連接", "無法連接", "正在配網..." (ServerReach.cpp), from the
            // assets partition. Same rule: only while nobody is talking.
            if (deviceState == IDLE || deviceState == SOFT_AP) {
                if (const char *prompt = serverReachTakePrompt()) {
                    playAssetSound(prompt);
                }
            }
            // 「系統更新中，請稍候。」 as an OTA install starts (OTA.cpp). No
            // websocket is open yet, so nothing else can be playing.
            if (deviceState == OTA && otaTakeUpdatePrompt()) {
                playOtaUpdatePrompt();
                otaUpdatePromptDone();
            }
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
//
// What decides that is how much *speech* the press caught, not how loud the
// press was on average. A mean over the whole hold answers the wrong question,
// because it falls the longer the button is down: a child who says one word
// and then keeps their thumb on the button for another eight seconds measures
// as silence and has the turn thrown away -- while the server, which was
// streamed that word as it was spoken, answers it anyway. The device then sits
// in IDLE while the toy talks. Voiced time does not dilute: eight seconds of
// quiet adds nothing to it and takes nothing away either.
static volatile uint64_t micLevelSum = 0;
static volatile uint32_t micLevelCount = 0;
static volatile int32_t micLevelPeak = 0;
static volatile uint32_t micVoicedMs = 0;
// millis() of the last block that counted as speech, or 0 if this press has
// not caught any yet. micTask writes it, networkTask reads it to tell a press
// that is still a turn from one the child is only leaning on.
// The standing offset the last block was centred on. Diagnostic only.
static volatile int32_t micLevelDc = 0;

// How the current press got onto the socket: frames, bytes, time spent in
// sendMicFrame() (waiting for wsMutex plus the TLS write), the worst single
// frame, and the lowest free internal heap seen while sending. A press whose
// send time approaches its own length is backing up on the device -- memory
// or wifi -- and its end_of_speech queues behind the backlog. Diagnostic only.
static volatile uint32_t micSendFrames = 0;
static volatile uint32_t micSendBytes = 0;    // on the wire, after ADPCM
static volatile uint32_t micSendSamples = 0;  // 16kHz samples those carried
static volatile uint64_t micSendUs = 0;
static volatile uint32_t micSendMaxUs = 0;
static volatile uint32_t micSendMinHeap = UINT32_MAX;

// Mean magnitude of one block, above which that block counts as speech. Mean
// within the block rather than peak, for the reason the old whole-press mean
// was chosen over a peak: a knock on the desk or the click of the button is a
// sample or two wide and lifts a peak without there being anything to
// transcribe. The number is the one the old whole-press threshold used, which
// was tuned against this mic -- a block of real speech sits well above it, a
// block of a quiet room below.
//
// Per board, because it is a level and the boards' mics are nothing alike. On
// the xmini-c3 (one ES8311, analog PGA 30dB) a silent 1.1s press measured avg
// 465 at 30dB digital gain -- every block over 150, so silence was committed
// as speech and the device sat in THINKING waiting for an answer to nothing
// (2026-09-24). The gain is now 24dB, which halves both: silence ~230, speech
// ~530 averaged over a press with its pauses, its words well above that.
// The Spotpear AI Toy takes the same number on the strength of the same codec
// at the same gains; its own mic has not been measured.
#ifndef MIC_VOICE_LEVEL_OVERRIDE
#if defined(BOARD_XMINI_C3) || defined(BOARD_SPOTPEAR_AI_TOY)
static const int32_t MIC_VOICE_LEVEL = 450;
#else
static const int32_t MIC_VOICE_LEVEL = 150;
#endif
#else
static const int32_t MIC_VOICE_LEVEL = MIC_VOICE_LEVEL_OVERRIDE;
#endif

static void resetMicLevel() {
    micLevelSum = 0;
    micLevelCount = 0;
    micLevelPeak = 0;
    micVoicedMs = 0;
    micSendFrames = 0;
    micSendBytes = 0;
    micSendSamples = 0;
    micSendUs = 0;
    micSendMaxUs = 0;
    micSendMinHeap = UINT32_MAX;
}

// IMA ADPCM on the uplink (P2-24, MicAdpcm.h): raw 16kHz PCM is 256 kbps,
// which a phone hotspot could not drain -- the send queue grew until TLS had
// no heap left (2026-10-13). The server learns it from X-Mic-Codec. Build with
// -DMIC_UPLINK_ADPCM=0 to send PCM as before.
#ifndef MIC_UPLINK_ADPCM
#define MIC_UPLINK_ADPCM 1
#endif

#if MIC_UPLINK_ADPCM
// micTask only. Carries on across frames and presses; every block names the
// state it starts from, so nothing has to reset it.
static MicAdpcmState micAdpcm;
static constexpr size_t kMicAdpcmMaxSamples = 512;
#endif

static void sendMicBytes(const uint8_t *data, size_t length) {
    const int64_t t0 = esp_timer_get_time();
    xSemaphoreTake(wsMutex, portMAX_DELAY);
    webSocket.sendBIN(data, length);
    xSemaphoreGive(wsMutex);
    const uint32_t us = (uint32_t)(esp_timer_get_time() - t0);
    micSendFrames++;
    micSendBytes += length;
    micSendUs += us;
    if (us > micSendMaxUs) micSendMaxUs = us;
    const uint32_t heap = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    if (heap < micSendMinHeap) micSendMinHeap = heap;
}

// micTask -> wsStream.write() -> sendMicFrame(): 16-bit PCM at 16kHz.
static void sendMicFrame(const uint8_t *data, size_t length) {
    const size_t samples = length / sizeof(int16_t);
    micSendSamples += samples;
#if MIC_UPLINK_ADPCM
    static uint8_t block[micAdpcmBlockBytes(kMicAdpcmMaxSamples)];
    const int16_t *pcm = (const int16_t *)data;
    for (size_t done = 0; done < samples;) {
        const size_t n = samples - done < kMicAdpcmMaxSamples ? samples - done : kMicAdpcmMaxSamples;
        sendMicBytes(block, micAdpcmEncodeBlock(micAdpcm, pcm + done, n, block));
        done += n;
    }
#else
    sendMicBytes(data, length);
#endif
}

// networkTask, at the end of a press.
static void logMicUplink(unsigned long held) {
    const uint32_t frames = micSendFrames;
    Serial.printf("PTT uplink | %u frames, %u B (%ums of 16kHz audio) in %lums held | "
                  "send total %ums, max %ums | min free heap %u\n",
                  (unsigned)frames, (unsigned)micSendBytes,
                  (unsigned)(micSendSamples / 16), held,
                  (unsigned)(micSendUs / 1000), (unsigned)(micSendMaxUs / 1000),
                  frames ? (unsigned)micSendMinHeap : 0u);
}

static void accumulateMicLevel(const uint8_t *buffer, size_t size) {
    const int16_t *samples = (const int16_t *)buffer;
    size_t count = size / sizeof(int16_t);
    if (count == 0) return;
    // Magnitude has to be measured around this block's own mean, not around
    // zero. This mic sits on a standing offset of a few hundred LSB, and
    // |sample| against zero measures that offset and nothing else: a silent
    // room and a spoken word came back with the same average, so every block
    // counted as speech and every level threshold downstream was dead. The
    // mean over one block -- 16ms at MIC_SAMPLE_RATE -- also takes out slow
    // rumble, and leaves everything in the speech band alone.
    int64_t dc = 0;
    for (size_t i = 0; i < count; i++) dc += samples[i];
    const int32_t mean = (int32_t)(dc / (int64_t)count);
    uint64_t sum = 0;
    int32_t peak = 0;
    for (size_t i = 0; i < count; i++) {
        int32_t centred = (int32_t)samples[i] - mean;
        int32_t magnitude = centred < 0 ? -centred : centred;
        sum += magnitude;
        if (magnitude > peak) peak = magnitude;
    }
    // Kept for the release log: it is what told us the offset was there, and
    // it is the first thing to look at if these thresholds ever go strange on
    // a different board or a different mic.
    micLevelDc = mean;
    micLevelSum += sum;
    micLevelCount += count;
    if (peak > micLevelPeak) micLevelPeak = peak;
    // Judged one block at a time, which is what makes this short-term energy
    // rather than another average: MIC_COPY_SIZE is 16ms at MIC_SAMPLE_RATE,
    // inside the window speech is normally measured over.
    if ((int32_t)(sum / count) >= MIC_VOICE_LEVEL) {
        micVoicedMs += (uint32_t)((count * 1000) / MIC_SAMPLE_RATE);
    }
}

// Kept for the release log only. It is what the discard used to be decided on,
// and printing both next to the voiced total is what makes the thresholds
// tunable against what this mic actually measures.
static uint32_t micAverageLevel() {
    uint32_t count = micLevelCount;
    return count == 0 ? 0 : (uint32_t)(micLevelSum / count);
}

// 64 bytes meant a websocket frame every 2ms: 500 sends per second, each one
// taking wsMutex and driving a separate TLS write on the task that also
// decodes audio. 512 costs 16ms of extra latency and an eighth of the churn.
const int MIC_COPY_SIZE = 512;

#if BOARD_MIC_DOWNSAMPLE_3_2
// micTask only: written in wsStream.write(), reset where micTask flushes the
// mic, so it needs no lock.
static Downsample3to2 micDownsampler;
// StreamCopy's whole buffer (1024 bytes) in one piece, so a normal write is
// one websocket frame; anything longer is simply done in more than one.
static constexpr size_t kMicChunkSamples = 512;
#endif

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

#if BOARD_MIC_DOWNSAMPLE_3_2
        // The capture rate is the speaker's; the server's STT wants 16kHz.
        //
        // Any size has to be taken. copyBytes(MIC_COPY_SIZE) does not cap the
        // write at MIC_COPY_SIZE: with check_available on it reads whatever is
        // available up to StreamCopy's own 1024-byte buffer. A first version
        // refused anything over 512 bytes, StreamCopy retried and gave up,
        // and not one sample of a press reached the server (2026-09-30). It
        // does round to whole samples, so size is even.
        static int16_t downsampled[kMicChunkSamples * 2 / 3 + 2];
        const int16_t *in = (const int16_t *)buffer;
        size_t remaining = size / sizeof(int16_t);
        while (remaining > 0) {
            const size_t n = remaining < kMicChunkSamples ? remaining : kMicChunkSamples;
            const size_t outSamples = micDownsampler.process(in, n, downsampled);
            if (outSamples > 0) {
                sendMicFrame((const uint8_t *)downsampled, outSamples * sizeof(int16_t));
            }
            in += n;
            remaining -= n;
        }
        return size;
#else
        sendMicFrame(buffer, size);
        return size;
#endif
    }
};

WebsocketStream wsStream; //guard with wsMutex
I2SStream i2sInput; //access from micTask only
StreamCopy micToWsCopier(wsStream, i2sInput);
volatile bool i2sInputFlushScheduled = false;

void micTask(void *parameter) {
#if BOARD_SHARED_I2S_BUS
    // Nothing to configure: the ES7210 is on the port audioStreamTask installs,
    // and a second i2s_driver_install() on it would simply fail. Wait for that
    // port, then read from the same object. i2s_read() and i2s_write() take
    // separate DMA channels and the driver locks each independently, so the two
    // tasks sharing this object do not need a mutex between them.
    while (!i2sBusReady) {
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    micToWsCopier.begin(wsStream, i2s);
    Serial.printf("Mic sharing I2S port %d with the speaker at %luHz\n",
                  (int)I2S_PORT_IN, (unsigned long)MIC_SAMPLE_RATE);
#else
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
#endif

    micToWsCopier.setDelayOnNoData(0);

    while (1) {
        if (i2sInputFlushScheduled) {
            i2sInputFlushScheduled = false;
#if BOARD_MIC_DOWNSAMPLE_3_2
            micDownsampler.reset();  // do not start a press on the last one's tail
#endif
#if BOARD_SHARED_I2S_BUS
            i2s.flush();
#else
            i2sInput.flush();
#endif
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

// A connection the server closes before sending "auth" is one it refused: it
// checks the device token first and closes with 4401 when it is not live. The
// library does not hand the close code up, so this is how it shows.
static bool wsOpen = false;
static bool wsAuthed = false;
// What reportPower() last told the server this session.
static bool powerSent = false;
static bool powerSentLow = false;
static int powerSentPercent = -1;
static bool powerSentCharging = false;
static bool powerSentFull = false;
// The crash report waiting in NVS has gone out on this session.
static bool crashSent = false;
static unsigned long powerSentAt = 0;

void sayBye(const char *reason) {
    if (!webSocket.isConnected()) return;
    JsonDocument doc;
    doc["type"] = "bye";
    doc["reason"] = reason;
    String out;
    serializeJson(doc, out);
    webSocket.sendTXT(out);
    Serial.printf("[WSc] bye: %s\n", reason);
}

// A restart the server asked for ("Update now", factory reset). No disconnect
// here: this runs inside the library's own event callback. The pause gives
// the "bye" time to leave before the radio goes down with the chip.
static void restartWithBye() {
    sayBye("restart");
    delay(200);
    ESP.restart();
}

// WEBSOCKET EVENTS
// networkTask -> webSocket.loop() -> webSocketEvent()
void webSocketEvent(WStype_t type, const uint8_t *payload, size_t length)
{
    switch (type)
    {
    case WStype_DISCONNECTED:
        Serial.printf("[WSc] Disconnected!\n");
        if (wsOpen && !wsAuthed) {
            // Retrying with the same token gets the same answer -- once a
            // second, for as long as the board has no owner. Stop here until
            // startSessionIfReady() on the wifi task has a new one.
            Serial.println("[WSc] Closed before auth: device token refused, pausing");
            authTokenRejected = true;
            websocketPaused = true;
        }
        wsOpen = false;
        // enterSleep()'s own disconnect lands here. Going back to IDLE would
        // light the LED again for the whole sleep.
        if (deviceState != SLEEP) deviceState = IDLE;
        // Nothing else takes this path to IDLE, so without this the tail of the
        // interrupted turn would still be in the ring when the next one starts.
        i2sOutputFlushScheduled = true;
        break;
    case WStype_CONNECTED:
        Serial.printf("[WSc] Connected to url: %s\n", payload);
        serverReached();
        wsOpen = true;
        wsAuthed = false;
        // PROCESSING (red) only while a greeting is on its way. An automatic
        // reconnect ignores the greeting, so the light would go red for the
        // seconds it took the server to finish one nobody hears, on an idle
        // board nobody touched.
        deviceState = greetingWanted ? PROCESSING : IDLE;
        // Each websocket is a fresh session on the server, so nothing the user
        // said before this counts towards it.
        userSpokeThisSession = false;
        break;
    case WStype_TEXT:
    {
        // A Wi-Fi request can carry a password (R-37), so it never goes to the
        // serial log. Checked before parsing: deserializeJson rewrites the
        // buffer in place.
        if (strstr((const char *)payload, "\"wifi\"") == nullptr) {
            Serial.printf("[WSc] get text: %s\n", payload);
        } else {
            Serial.println("[WSc] get text: (Wi-Fi request)");
        }

        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, (char *)payload);

        if (error)
        {
            Serial.println("Error deserializing JSON");
            deviceState = IDLE;
            return;
        }

        String type = doc["type"];

        // Wi-Fi management from the web app's Network page (R-37). Queued for
        // the Wi-Fi task, which answers on this socket.
        if (type == "wifi") {
            const char *id = doc["id"] | "";
            if (!*id || !wifiRemoteEnqueue(doc["op"] | "", id, doc["ssid"] | "", doc["password"] | "")) {
                JsonDocument busy;
                busy["type"] = "wifi_result";
                busy["id"] = id;
                busy["ok"] = false;
                busy["error"] = "busy";
                String out;
                serializeJson(busy, out);
                webSocket.sendTXT(out);   // wsMutex is already held here
            }
            // The password lives on in doc until it goes out of scope here;
            // wipe the parsed copy now rather than leave it in the heap.
            if (doc["password"].is<const char *>()) {
                char *pw = (char *)doc["password"].as<const char *>();
                memset(pw, 0, strlen(pw));
            }
            break;
        }

        // auth messages
        if (strcmp((char*)type.c_str(), "auth") == 0) {
            wsAuthed = true;
            // A new session on the server: reportPower() says it again.
            powerSent = false;
            crashSent = false;
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

            // The voice server answered. A new image is confirmed if it now
            // stays up (OTA.cpp).
            otaServerReached();

            // Tell the server which Wi-Fi this board is on and has saved, so
            // the web app can show it even after the board falls asleep.
            wifiRemoteEnqueue("status", "", "", "");

            // "Update now": the check runs on every boot, so a restart is the
            // whole job. Not if this boot's check failed, though -- the flag
            // would still be set next time and the board would never stop.
            if (is_ota) {
                if (otaCheckedThisBoot()) {
                    Serial.println("OTA requested, restarting to check for an update");
                    restartWithBye();
                } else {
                    Serial.println("OTA requested, but this boot could not reach the update check");
                }
            }

            if (is_reset) {
                Serial.println("Factory reset received");
                // setFactoryResetStatusInNVS(true);
                restartWithBye();
            }
        }

        // The server stored the crash report (CrashReport.cpp).
        if (strcmp((char*)type.c_str(), "crash_ack") == 0) {
            crashReportAcked(doc["id"].as<uint32_t>());
        }

        // The volume was changed in the web app while connected
        // (server/fastapi/device_volume.py).
        if (strcmp((char*)type.c_str(), "volume") == 0 && doc.containsKey("volume_control")) {
            applyRemoteVolume(doc["volume_control"].as<int>());
        }

        // oai messages
        if (strcmp((char*)type.c_str(), "server") == 0) {
            String msg = doc["msg"];
            Serial.println(msg);

            if (strcmp((char*)msg.c_str(), "RESPONSE.COMPLETE") == 0 || strcmp((char*)msg.c_str(), "RESPONSE.ERROR") == 0) {
                Serial.println("Received RESPONSE.COMPLETE or RESPONSE.ERROR, starting listening again");

                // The server no longer sends this: it arrived after the answer
                // had played and could undo a newer level (device_volume.py).
                // Kept so an older server still works.
                if (doc.containsKey("volume_control")) {
                    applyRemoteVolume(doc["volume_control"].as<int>());
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
                } else if (pttTailUntil != 0 && !pttCapturing()) {
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
                sleepReason = "sleep_session_end";
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
        decodeStatsNotePacketArrived(length);

        // Hand it to decodeTask and go straight back to servicing the socket.
        // This is the whole point: the decode, and the wait on a full PCM ring
        // that follows it, no longer happen on the task that also carries the
        // button presses.
        if (!audioQueueOpusPacket(payload, length)) {
            static bool queueDropReported = false;
            if (!queueDropReported) {
                queueDropReported = true;
                Serial.printf("Opus packet queue refused %u bytes\n", (unsigned)length);
            }
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

bool websocketStarted = false;
volatile bool websocketPaused = false;

// The server takes the device's identity from the token alone; the MAC rides
// along only so a refused connection says in the server log who it claimed to
// be. X-Firmware-Version tells the server this board handles the "volume"
// message; 1.0.1 sends none and gets its level in a second auth frame instead
// (server/fastapi/device_volume.py). X-Device-Caps lists what else this
// firmware does that older ones did not: "bye" means a close with no "bye"
// before it was a lost connection, not a sleep (server/fastapi/device_connection.py).
String websocketExtraHeaders()
{
    return "Authorization: Bearer " + authTokenGlobal + "\r\n" +
           "X-Wifi-Rssi: " + String(WiFi.RSSI()) + "\r\n" +
           "X-Firmware-Version: " FIRMWARE_VERSION "\r\n" +
           "X-Device-Caps: bye\r\n" +
           "X-Device-Mac: " + WiFi.macAddress()
#if MIC_UPLINK_ADPCM
           + "\r\nX-Mic-Codec: ima-adpcm"
#endif
        ;
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
  #ifdef LOCAL_WS_TLS
    // Test builds only (P2-25): wss to a LAN port that accepts and never
    // answers, which is how a stalled hotspot handshake looks to the board.
    const bool plaintext = false;
  #else
    const bool plaintext = true;  // no certificate for a laptop on the LAN
  #endif
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

    xSemaphoreTake(wsMutex, portMAX_DELAY);

    webSocket.setExtraHeaders(websocketExtraHeaders().c_str());
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
    websocketStarted = true;

    xSemaphoreGive(wsMutex);
}

// A tap shorter than this carried no speech worth sending: the press was there
// to barge in, not to say something.
static const unsigned long PTT_MIN_CAPTURE_MS = 250;
static unsigned long pttPressedAt = 0;

// How much speech a press has to have caught to be worth committing. Short
// enough to keep a one-word answer -- the shortest spoken word runs 200ms and
// up -- and long enough that the click of the button or a knock on the desk,
// a few milliseconds each, never adds up to it. Deliberately generous:
// dropping real speech is far worse than letting a quiet turn through, and a
// turn let through costs one answer while a turn dropped costs the child's
// question. Every release logs voiced ms next to the press's avg and peak, so
// tune this against what a silent room and a normal sentence measure here.
static const uint32_t MIC_MIN_VOICED_MS = 120;

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

// The longest one press may hold the mic, whatever it hears while it does.
// Nothing else ever ends a press: a child who says nothing and keeps holding
// streams a silent minute to the recognizer, and no release ever comes. This
// also covers a button stuck down or a toy pressed against the inside of a
// bag, which is why it is a plain duration and not a silence rule -- an
// earlier version cut the turn once the mic had heard nothing for a minute,
// and measuring that on the device turned out not to work. The level metric
// it needed was reading the mic's DC offset rather than the room (see
// accumulateMicLevel), so every block counted as speech, the silence never
// arrived, and the rule could not fire. A duration depends on none of that:
// no mic gain, no noise floor, no board. If cutting a turn short on real
// silence is ever wanted, the server already runs Silero VAD over this same
// stream and is where it belongs.
#ifdef PTT_MAX_CAPTURE_MS_OVERRIDE
static const unsigned long PTT_MAX_CAPTURE_MS = PTT_MAX_CAPTURE_MS_OVERRIDE;
#else
static const unsigned long PTT_MAX_CAPTURE_MS = 60000;
#endif

// Close the turn a press opened, and decide what to do with what it caught.
// Called when the button comes up, and when a press runs past
// PTT_MAX_CAPTURE_MS with the button still down -- both want this same
// decision made on the same numbers.
static void endPttCapture(unsigned long held) {
    uint32_t level = micAverageLevel();
    uint32_t voicedMs = micVoicedMs;
    int32_t peak = micLevelPeak;
    if (held < PTT_MIN_CAPTURE_MS) {
        deviceState = PROCESSING;
        i2sInputFlushScheduled = true;
        Serial.printf("PTT: %lums tap, treated as interrupt only\n", held);
        transitionToIdle();
    } else if (voicedMs < MIC_MIN_VOICED_MS) {
        // Nothing worth transcribing, so close the mic without a tail: the
        // server's VAD never sees a turn and stays quiet. The two agree on
        // this press -- neither heard enough to call it speech -- which is
        // what keeps the device out of the state where it discards a turn the
        // server is busy answering.
        deviceState = PROCESSING;
        i2sInputFlushScheduled = true;
        Serial.printf("PTT: %lums but only %ums voiced (avg %u, peak %d, dc %d), discarded\n",
                      held, voicedMs, level, (int)peak, (int)micLevelDc);
        transitionToIdle();
    } else if (PTT_SEND_EXPLICIT_COMMIT) {
        deviceState = PROCESSING;
        i2sInputFlushScheduled = true;
        userSpokeThisSession = true;
        webSocket.sendTXT("{\"type\":\"instruction\",\"msg\":\"end_of_speech\"}");
        Serial.printf("PTT: end_of_speech sent after %lums (%ums voiced, avg %u, peak %d, dc %d)\n",
                      held, voicedMs, level, (int)peak, (int)micLevelDc);
        logMicUplink(held);
    } else {
        // Stay in LISTENING so the mic keeps feeding the server a little
        // silence, which is what its VAD needs to close a turn.
        userSpokeThisSession = true;
        pttTailUntil = millis() + PTT_VAD_TAIL_MS;
        Serial.printf("PTT: %lums captured (%ums voiced, avg %u, peak %d), %lums VAD tail\n",
                      held, voicedMs, level, (int)peak, PTT_VAD_TAIL_MS);
    }
}

// How long the device waits in PROCESSING (THINKING on the display) for the
// server to start answering before it gives up and goes back to IDLE. A turn
// the server has nothing to say to -- a commit whose audio held no words --
// gets no RESPONSE.* at all, and nothing else ever leaves the state: the idle
// sleep used to, two minutes later, and a board with idle sleep off (the
// xmini-c3) stayed on THINKING for good. Long enough that a slow first answer
// is not cut off; if one does arrive later, RESPONSE.CREATED still plays it.
static const unsigned long PROCESSING_TIMEOUT_MS = 15000;

static void checkProcessingTimeout() {
    static unsigned long processingSince = 0;
    if (deviceState != PROCESSING) {
        processingSince = 0;
        return;
    }
    if (processingSince == 0) {
        processingSince = millis();
        return;
    }
    if (millis() - processingSince >= PROCESSING_TIMEOUT_MS) {
        processingSince = 0;
        Serial.printf("No answer after %lus, back to idle\n", PROCESSING_TIMEOUT_MS / 1000);
        transitionToIdle();
    }
}

// networkTask -> processPushToTalk(), with wsMutex already held.
static void processPushToTalk() {
    checkProcessingTimeout();

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
        // The button may still be down, and this press no longer has a turn
        // behind it. Restart its clock so the cap below measures the press
        // rather than firing on the one the reset just threw away.
        pttPressedAt = millis();
        pttPressRequested = false;
        pttReleaseRequested = false;
        pttCapped = false;
        return;
    }

    // A press during the tail cancels it: the user is talking again.
    if (pttTailUntil != 0 && (pttCapturing() || millis() >= pttTailUntil)) {
        pttTailUntil = 0;
        if (!pttCapturing() && deviceState == LISTENING) {
            deviceState = PROCESSING;
            i2sInputFlushScheduled = true;
            Serial.println("Mic closed, waiting for the server to answer");
        }
    }

    if (pttPressRequested) {
        pttPressRequested = false;
        pttPressedAt = millis();
        pttTailUntil = 0;
        pttCapped = false;
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

    // A press nobody ended. Close the turn ourselves and latch it: from here
    // the press behaves as if the button were already up, so the mic shuts,
    // the upload stops, and an answer to whatever was said can play while the
    // button is still down.
    if (pttCapturing() && millis() - pttPressedAt >= PTT_MAX_CAPTURE_MS) {
        const unsigned long held = millis() - pttPressedAt;
        pttCapped = true;
        // The button is still down and nothing is going to play if this press
        // caught no speech, so the flash is the only way the child is told the
        // device stopped listening. ledFlash() only stores a deadline, so it
        // is safe from this task.
        ledFlash(400);
        Serial.printf("PTT: %lums held, capping the turn at %lums\n",
                      held, PTT_MAX_CAPTURE_MS);
        if (webSocket.isConnected() && deviceState == LISTENING) {
            endPttCapture(held);
        } else {
            transitionToIdle();
        }
    }

    if (pttReleaseRequested) {
        pttReleaseRequested = false;
        if (pttCapped) {
            // The cap already closed this turn, so the button coming up now
            // has nothing left to commit -- it only clears the latch for the
            // next press.
            pttCapped = false;
            Serial.println("PTT: button up after the cap closed the turn");
        } else if (webSocket.isConnected() && deviceState == LISTENING) {
            endPttCapture(millis() - pttPressedAt);
        }
    }
}

// The battery state the app shows (R-41): sent once per session after "auth",
// then again whenever it changes, so the server's copy is never older than the
// last time the board was awake. Each field goes out only when the board can
// sense it, and the server stores a missing one as "unknown":
//
//   low       always. The Spotpear board can say only this (SupplyMonitor).
//   percent   boards that measure the cell.
//   charging  the charger's own output, on boards wired to read it.
//   full      the cell is charged: the charger has finished, or reads as near
//             100% without charging.
//
// Boards with no sense at all send nothing, and the app shows no battery.
// Runs on networkTask with wsMutex held.

// A percentage that drifts by a point or two is not news; a sample every few
// seconds would otherwise be a write to the database each time.
constexpr int kPowerPercentStep = 5;
constexpr unsigned long kPowerMinGapMs = 60UL * 1000;
constexpr int kPowerLowPercent = 15;
// A cell the charger has finished with rests a little under the table's 100%.
constexpr int kPowerFullPercent = 95;

static void reportPower() {
    if (!wsAuthed || !webSocket.isConnected()) return;
#if BOARD_HAS_BATTERY
    if (!batteryPresent()) return;
    const int percent = batteryPercent();
    const bool charging = batteryCharging();
    const bool low = !charging && percent <= kPowerLowPercent;
    const bool full = !charging && percent >= kPowerFullPercent;
#elif BOARD_LOW_BATTERY_VIA_VDD
    // On USB the regulator holds VDD at 3.3V whether the cell is charging,
    // full or absent, and the charger's CHRG pin reaches only an LED, so
    // charging and full are unknowable here (BOARDS.md).
    const int percent = -1;
    const bool charging = false;
    const bool full = false;
    const bool low = supplyLow();
#else
    // No battery sense of any kind: nothing to report.
    const int percent = -1;
    const bool charging = false;
    const bool full = false;
    const bool low = false;
    return;
#endif
    if (powerSent) {
        const bool flipped =
            low != powerSentLow || charging != powerSentCharging || full != powerSentFull;
        const bool moved = percent >= 0 && abs(percent - powerSentPercent) >= kPowerPercentStep;
        if (!flipped && !(moved && millis() - powerSentAt >= kPowerMinGapMs)) return;
    }

    JsonDocument doc;
    doc["type"] = "power";
    doc["low"] = low;
    if (percent >= 0) {
        doc["percent"] = percent;
        doc["charging"] = charging;
        doc["full"] = full;
    }
    String out;
    serializeJson(doc, out);
    webSocket.sendTXT(out);
    Serial.printf("[WSc] power: %s\n", out.c_str());

    powerSent = true;
    powerSentLow = low;
    powerSentPercent = percent;
    powerSentCharging = charging;
    powerSentFull = full;
    powerSentAt = millis();
}

// Once per session, until the server acknowledges it (crash_ack). A board
// that crashed reports at its next "auth", however many boots later.
// Runs on networkTask with wsMutex held.
static void reportCrash() {
    if (crashSent || !wsAuthed || !webSocket.isConnected()) return;
    crashSent = true;
    String out = crashReportJson();
    if (out.isEmpty()) return;
    webSocket.sendTXT(out);
    Serial.printf("[WSc] crash: %s\n", out.c_str());
}

// networkTask -> webSocket.loop()
void networkTask(void *parameter) {
    int64_t lastServicedAt = esp_timer_get_time();
    while (1) {
        // Everything this task owns -- reading the socket, and sending the
        // button presses that barge in -- happens once per pass, so this gap
        // is the worst case latency on all of it. A pass that decodes audio
        // into a full ring buffer is a pass that does none of the rest.
        const int64_t now = esp_timer_get_time();
        decodeStatsNoteWsServiceGap((uint32_t)(now - lastServicedAt));
        lastServicedAt = now;

        // enterSleep() has closed the socket; servicing it now would only
        // reconnect, a second after the disconnect, while the sleep chime
        // plays, and open a session on the server nobody will use.
        if (deviceState == SLEEP) {
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }

        serverReachPoll(webSocket.isConnected(), deviceState == SOFT_AP);

        xSemaphoreTake(wsMutex, portMAX_DELAY);

        processPushToTalk();

        if (scheduleIdleAfterTurn && millis() >= scheduledTime) {
            transitionToIdle();
        }

        // Paused, the library never gets the chance to reconnect.
        if (!websocketPaused) {
            webSocket.loop();
        }
        reportPower();
        reportCrash();
#if CRASH_TEST
        crashTestPoll(wsAuthed && webSocket.isConnected());
#endif
        xSemaphoreGive(wsMutex);

        vTaskDelay(1);
    }
}
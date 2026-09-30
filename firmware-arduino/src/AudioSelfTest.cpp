#include "AudioSelfTest.h"
#include "Codec.h"
#include "IoExpander.h"
#include "LEDHandler.h"

#ifdef AUDIO_SELFTEST

#include "Config.h"
#include <Arduino.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <driver/i2s.h>
#include <math.h>

// One phase at a time, each one removing a suspect. The order matters: if the
// noise is already there in PHASE 1 it cannot be the audio data, and if it is
// still there in PHASE 5 it cannot be I2S at all.
#if BOARD_HAS_CODEC
// A codec only accepts the rates its coefficient table lists at 256 x fs, and
// on the Waveshare board 24kHz is not one of them -- that is the whole reason
// its pipeline runs at 16kHz (see SAMPLE_RATE in Config.cpp). Testing at 24kHz there
// left both chips unconfigured and the board silent for every phase, which is
// a confusing way to fail a test whose entire job is to tell you whether the
// hardware makes a sound. Test at the rate the board actually runs.
static const int TEST_SAMPLE_RATE = (int)SAMPLE_RATE;
#else
static const int TEST_SAMPLE_RATE = (int)24000;
#endif

// Top of the sweep, kept below Nyquist. 8kHz is fine at 24kHz but is exactly
// Nyquist at 16kHz, where it would alias back down the scale and read as a
// fault in the amplifier rather than in the test signal.
static const float SWEEP_TOP_HZ =
    (TEST_SAMPLE_RATE * 0.45f < 8000.0f) ? TEST_SAMPLE_RATE * 0.45f : 8000.0f;
static const int BLOCK_FRAMES = 256;
static int16_t block[BLOCK_FRAMES];

// -20 dBFS. Loud enough to judge, quiet enough that clipping is not the story.
static const float AMPLITUDE = 0.1f * 32767.0f;

static double phase = 0.0;

// Cycles alternate radio-off and radio-on so the two can be compared by ear
// within one sitting, with the audio source held identical. The board is USB
// powered and the amplifier shares that rail, so a transmit burst is the one
// large load the speaker path cannot see coming.
static bool radioOn = false;
static WiFiUDP udp;
static TaskHandle_t rfLoadHandle = NULL;

// Unicast to the gateway's discard port rather than a broadcast flood: the same
// transmit activity, contained to one host on what may well be a shared network.
static void rfLoadTask(void *) {
    static uint8_t payload[512];
    memset(payload, 0xA5, sizeof(payload));
    while (true) {
        if (WiFi.status() == WL_CONNECTED) {
            udp.beginPacket(WiFi.gatewayIP(), 9);
            udp.write(payload, sizeof(payload));
            udp.endPacket();
            vTaskDelay(pdMS_TO_TICKS(2));
        } else {
            // Not associated: an active scan still puts probe requests on the
            // air, which is the transmit current we are trying to provoke.
            WiFi.scanNetworks(false, true);
            vTaskDelay(pdMS_TO_TICKS(50));
        }
    }
}

static void radioUp() {
    Preferences p;
    String ssid, pass;
    if (p.begin("wifimanager", true)) {
        ssid = p.getString("apName0", "");
        pass = p.getString("apPass0", "");
        p.end();
    }

    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);                      // no power save: keep the PA busy
    WiFi.setTxPower(WIFI_POWER_19_5dBm);       // worst case on purpose
    if (ssid.length() > 0) {
        Serial.printf("  radio: associating with '%s'\n", ssid.c_str());
        WiFi.begin(ssid.c_str(), pass.c_str());
        for (int i = 0; i < 60 && WiFi.status() != WL_CONNECTED; i++) delay(250);
    }
    Serial.printf("  radio: %s\n",
                  WiFi.status() == WL_CONNECTED
                      ? WiFi.localIP().toString().c_str()
                      : "not associated -- falling back to active scanning");

    if (rfLoadHandle == NULL) {
        xTaskCreatePinnedToCore(rfLoadTask, "RF load", 4096, NULL, 2, &rfLoadHandle, 0);
    }
    radioOn = true;
}

static void radioDown() {
    if (rfLoadHandle != NULL) {
        vTaskDelete(rfLoadHandle);
        rfLoadHandle = NULL;
    }
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
    radioOn = false;
}

static void writeBlock(int frames) {
    size_t written = 0;
    i2s_write(I2S_PORT_OUT, block, frames * sizeof(int16_t), &written, portMAX_DELAY);
}

static void playSilence(int ms) {
    memset(block, 0, sizeof(block));
    int blocks = (TEST_SAMPLE_RATE * ms / 1000) / BLOCK_FRAMES;
    for (int i = 0; i < blocks; i++) writeBlock(BLOCK_FRAMES);
}

// gainStart/gainEnd give every tone a short attack and release, so a click
// heard between notes is the hardware and not the test signal stepping.
static void playTone(float freq, int ms, float gain) {
    int total = TEST_SAMPLE_RATE * ms / 1000;
    int fade = TEST_SAMPLE_RATE * 5 / 1000;  // 5ms each end
    if (fade > total / 2) fade = total / 2;

    double step = 2.0 * M_PI * freq / TEST_SAMPLE_RATE;
    int done = 0;
    while (done < total) {
        int n = BLOCK_FRAMES;
        if (n > total - done) n = total - done;
        for (int i = 0; i < n; i++) {
            float env = 1.0f;
            int pos = done + i;
            if (pos < fade) env = (float)pos / fade;
            else if (pos > total - fade) env = (float)(total - pos) / fade;
            block[i] = (int16_t)(AMPLITUDE * gain * env * sin(phase));
            phase += step;
            if (phase > 2.0 * M_PI) phase -= 2.0 * M_PI;
        }
        writeBlock(n);
        done += n;
    }
}

static void playSweep(float f0, float f1, int ms) {
    int total = TEST_SAMPLE_RATE * ms / 1000;
    int done = 0;
    while (done < total) {
        int n = BLOCK_FRAMES;
        if (n > total - done) n = total - done;
        for (int i = 0; i < n; i++) {
            float t = (float)(done + i) / total;
            float f = f0 * powf(f1 / f0, t);   // log sweep: even octaves
            phase += 2.0 * M_PI * f / TEST_SAMPLE_RATE;
            if (phase > 2.0 * M_PI) phase -= 2.0 * M_PI;
            block[i] = (int16_t)(AMPLITUDE * sin(phase));
        }
        writeBlock(n);
        done += n;
    }
}

// Twinkle Twinkle Little Star. A tune rather than more test tones because a
// melody makes intermittent noise far easier to notice than a steady sine.
static void playMelody() {
    static const float C4 = 261.63f, D4 = 293.66f, E4 = 329.63f, F4 = 349.23f;
    static const float G4 = 392.00f, A4 = 440.00f;
    struct Note { float f; int ms; };
    static const Note tune[] = {
        {C4,400},{C4,400},{G4,400},{G4,400},{A4,400},{A4,400},{G4,800},
        {F4,400},{F4,400},{E4,400},{E4,400},{D4,400},{D4,400},{C4,800},
    };
    for (unsigned i = 0; i < sizeof(tune) / sizeof(tune[0]); i++) {
        playTone(tune[i].f, tune[i].ms, 1.0f);
        playSilence(60);
    }
}

static void startI2S() {
    i2s_config_t cfg = {};
    cfg.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX);
    cfg.sample_rate = TEST_SAMPLE_RATE;
    cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
    cfg.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
    cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
    cfg.intr_alloc_flags = 0;
    cfg.dma_buf_count = 6;
    cfg.dma_buf_len = 256;
#if BOARD_SHARED_I2S_BUS
    cfg.use_apll = BOARD_I2S_USE_APLL;
    cfg.mclk_multiple = I2S_MCLK_MULTIPLE_256;
#else
    cfg.use_apll = false;
#endif
    cfg.tx_desc_auto_clear = true;
    i2s_driver_install(I2S_PORT_OUT, &cfg, 0, NULL);

    i2s_pin_config_t pins = {};
    pins.mck_io_num = (I2S_MCLK_OUT >= 0) ? I2S_MCLK_OUT : I2S_PIN_NO_CHANGE;
    pins.bck_io_num = I2S_BCK_OUT;
    pins.ws_io_num = I2S_WS_OUT;
    pins.data_out_num = I2S_DATA_OUT;
    pins.data_in_num = I2S_PIN_NO_CHANGE;
    i2s_set_pin(I2S_PORT_OUT, &pins);
}

void runAudioSelfTest() {

    // A codec board can make no sound until I2C is up; on the breadboard kit
    // this is a no-op. The codec itself is configured inside the loop, because
    // PHASE 5 removes the I2S driver every cycle and the DAC has to be brought
    // back up with the MCLK it locks to.
    boardI2CBegin();

#if BOARD_HAS_WS2812_RING
    setupRGBLED();
#else
    pinMode(I2S_SD_OUT, OUTPUT);
    digitalWrite(I2S_SD_OUT, HIGH);
    pinMode(BLUE_LED_PIN, OUTPUT);
    pinMode(RED_LED_PIN, OUTPUT);
    pinMode(GREEN_LED_PIN, OUTPUT);
#endif

    Serial.println();
    Serial.println("################ AUDIO SELF TEST ################");
    Serial.println("No websocket, no Opus. I2S -> amp -> speaker only.");
    Serial.println("Cycles alternate: odd = radio off (green LED),");
    Serial.println("                  even = radio on and transmitting (red LED).");
    Serial.printf("Pins: BCK=%d WS=%d DATA=%d SD=%d | %d Hz mono s16\n",
                  I2S_BCK_OUT, I2S_WS_OUT, I2S_DATA_OUT, I2S_SD_OUT, TEST_SAMPLE_RATE);
    Serial.println("#################################################");

    int cycle = 0;
    while (true) {
        cycle++;
        // Odd cycles quiet, even cycles transmitting. Same tones either way.
        if (cycle % 2 == 0) {
            radioUp();
        } else {
            radioDown();
        }
#if BOARD_HAS_WS2812_RING
        setLEDColor(radioOn ? 255 : 0, radioOn ? 0 : 255, 0);
#else
        digitalWrite(RED_LED_PIN, radioOn ? HIGH : LOW);
        digitalWrite(GREEN_LED_PIN, radioOn ? LOW : HIGH);
#endif

        Serial.printf("\n--------- cycle %d | RADIO %s (%s LED) ---------\n", cycle,
                      radioOn ? "ON, TRANSMITTING" : "OFF",
                      radioOn ? "red" : "green");

        startI2S();
        // Both no-ops on the breadboard kit. On a codec board the DAC has to be
        // reconfigured after every reinstall above, and only then is it safe to
        // let the amplifier through.
        codecBegin(TEST_SAMPLE_RATE, 16);
        boardSetSpeakerAmp(true);

        Serial.println("PHASE 1 (6s): I2S clocked, all-zero data. SHOULD BE SILENT.");
        Serial.println("             Noise here = supply, ground or wiring, not the audio.");
        playSilence(6000);

        Serial.println("PHASE 2 (5s): steady 440 Hz sine at -20 dBFS. SHOULD BE A CLEAN TONE.");
        playTone(440.0f, 5000, 1.0f);

        Serial.printf("PHASE 3 (8s): log sweep 100 Hz -> %.0f Hz. SHOULD RISE SMOOTHLY.\n",
                      SWEEP_TOP_HZ);
        playSweep(100.0f, SWEEP_TOP_HZ, 8000);

        Serial.println("PHASE 4 (~7s): melody. SHOULD BE CLEAN, no clicks between notes.");
        playMelody();

        Serial.println("PHASE 5 (6s): I2S driver removed, every pin driven low.");
        Serial.println("             Noise here = the amp or its supply, nothing digital left.");
        i2s_zero_dma_buffer(I2S_PORT_OUT);
        i2s_driver_uninstall(I2S_PORT_OUT);
        pinMode(I2S_BCK_OUT, OUTPUT);  digitalWrite(I2S_BCK_OUT, LOW);
        pinMode(I2S_WS_OUT, OUTPUT);   digitalWrite(I2S_WS_OUT, LOW);
        pinMode(I2S_DATA_OUT, OUTPUT); digitalWrite(I2S_DATA_OUT, LOW);
        // MCLK too where there is one, or the DAC still has a clock and the
        // phase does not mean what it says.
        if (I2S_MCLK_OUT >= 0) {
            pinMode(I2S_MCLK_OUT, OUTPUT); digitalWrite(I2S_MCLK_OUT, LOW);
        }
        delay(6000);
    }
}

#endif  // AUDIO_SELFTEST

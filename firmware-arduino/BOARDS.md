# Supported boards

One firmware, four boards. `src/BoardConfig.h` turns a single build flag into
capability macros; `src/Config.cpp` holds the pin map for each. Nothing else in
the tree should need a `#if` for a new board that resembles one of these.

| | Elato breadboard kit | Waveshare ESP32-S3-AUDIO-Board |
|---|---|---|
| Build env | `esp32-s3-devkitc-1` | `waveshare-s3-audio` |
| Chip / flash / PSRAM | ESP32-S3, 16MB, 8MB octal | identical |
| Microphone | raw I2S mic | ES7210 ADC, I2C `0x40` |
| Speaker | MAX98357A | ES8311 DAC `0x18` + NS4150B |
| I2S | two ports, independent rates | one port, full duplex, shared LRCK |
| MCLK | none | GPIO12, 256 × fs |
| Pipeline rate | 24kHz out / 16kHz in | 16kHz both ways |
| Amp enable | not broken out | TCA9555 `0x20` P10 |
| Status LED | discrete RGB, 3 GPIOs | 7-pixel WS2812 ring, GPIO38 |
| Volume / touch | GPIO40 / GPIO39 / GPIO47 | expander KEY1-3, polled |
| Push-to-talk | GPIO0 | GPIO0 |

## Buttons on the Waveshare board

| Key | Gesture | Action |
|---|---|---|
| GPIO0 (BOOT) | hold / release | Push to talk, release to send |
| GPIO0 | press while asleep | Wake. **The only key that can** |
| KEY1 | tap | Volume +10 |
| KEY1 | hold | Repeats after 500ms, every 160ms |
| KEY2 | tap / hold | Volume -10, same repeat |
| KEY3 | tap | Start a fresh conversation |
| KEY3 | hold 500ms | Deep sleep |
| KEY1 + KEY2 | hold 2s | Reboot |
| RESET | press | Hardware reset, wired to EN |

The microphone is on GPIO0 because of the wake constraint, not preference.
KEY1-3 are behind the TCA9555 and I2C is dead in deep sleep, so a mic key there
would leave the user pressing "talk" on a device that cannot hear them and
cannot wake.

At the volume limit the LED flashes white for 120ms: nothing moves, and with
keys polled over I2C a press that does nothing is otherwise indistinguishable
from a press that was not read. `nudgeVolume()` returns false there and skips
the NVS write, which a held key would otherwise repeat six times a second for a
value that did not change.

The reboot combination is a convenience for a board in an enclosure where RESET
cannot be reached. It is **not** a recovery path: it runs in a FreeRTOS task, so
anything that stops the scheduler stops it too. RESET is wired to EN and works
regardless. The combination exists only on this board — the breadboard kit's
volume keys are real GPIOs behind the Button library, which does not expose
simultaneous state as cheaply.

## Why the Waveshare board runs at 16kHz

The ES7210 and the ES8311 share BCLK and LRCK, so the microphone and the
speaker cannot run at different rates — there is one LRCK and it belongs to
both. Both chips derive their clocks from MCLK, the I2S driver emits MCLK at
256 × the sample rate, and 16kHz is the only voice rate for which both
coefficient tables have a 256 × fs entry: the ES7210 can only do 24kHz at
512 × fs.

This costs less than it looks like it should. Opus decodes to whatever rate it
is asked for, so the 24kHz stream the server sends decodes straight to 16kHz
inside libopus with no resampling of ours; the uplink is 16kHz either way,
which is what `ESP32_INPUT_SAMPLE_RATE` already defaults to, so **the server
needs no change**; and two thirds of the bytes move through the ring buffer and
the I2S DMA. What it costs is playback bandwidth above 8kHz.

One knock-on worth knowing: `AUDIO_PLAYBACK_PRIME_BYTES` is counted in bytes,
so the same 1024 that buys 21ms of jitter cushion at 24kHz buys 32ms at 16kHz.
That is 11ms of extra latency before the first sample of a turn. Override it at
build time (`-DAUDIO_PLAYBACK_PRIME_BYTES=768`) if that matters more than the
cushion.

## Bringing the Waveshare board up

1. **Check the pin map first.** The pins in `src/Config.cpp` came from the
   Waveshare wiki and two ESPHome ports of this board, not from the schematic.
   Download the schematic and confirm before trusting a first flash. If a
   signal is on a different pin, `src/Config.cpp` is the only file to change.

2. **Self-test before anything else.** This brings the radio down and drives
   the speaker from locally generated tones, so anything you hear is I2S, the
   ES8311 and the NS4150B and nothing upstream:

   ```
   pio run -e waveshare-s3-audio-audiotest -t upload
   ```

   Phase 1 should be silent, phase 2 a clean 440Hz, phase 3 a smooth sweep.

   The self-test runs at the board's own pipeline rate rather than its
   historical 24kHz, because a codec only accepts the rates its coefficient
   table lists at 256 x fs. Getting this wrong is quiet rather than loud: both
   chips stay unconfigured, every phase prints normally and the board makes no
   sound at all. If you see `Codec @ ...: ES8311 FAILED`, that is what has
   happened -- the rate, not the wiring.

3. **Then the real firmware:**

   ```
   pio run -e waveshare-s3-audio -t upload
   ```

   The boot log answers the three things most likely to be wrong, in order:

   ```
   Board: Waveshare ESP32-S3-AUDIO-Board
   TCA9555 at 0x20: ok
   I2C device at 0x18 / 0x20 / 0x40 / 0x51
   WS2812 ring on GPIO38: 7 pixels
   I2S out ok | heap ... | dma ...
   Codec @ 16000Hz/16bit: ES8311 ok, ES7210 ok
   Mic sharing I2S port 0 with the speaker at 16000Hz
   ```

   A missing chip at `0x18` or `0x40` means the I2C pins are wrong, not the
   codec sequence — check SDA=11 / SCL=10 before touching `Codec.cpp`.

## What has been verified on hardware

**Everything below predates a fix to the ES8311 clock setup (2026-09-30).**
`Codec.cpp` wrote the table's pre-multiplier straight into register 0x02, so
x1 became x2 and the chip ran at 512 x fs, and it skipped six registers
esp_codec_dev writes (0x0B/0x0C/0x10/0x11 references, 0x15, 0x1B, 0x44/0x45).
On the xmini-c3 fixing both took away most of an audible hiss. This board has
not been listened to since; do that before trusting the notes below.

Confirmed by the self-test on 2026-09-21, playback path only:

- **I2C bus and both codecs.** `Codec @ 16000Hz/16bit: ES8311 ok, ES7210 ok` —
  SDA=11 / SCL=10 are right, `0x18` and `0x40` are right, and both register
  sequences are ACKed end to end.
- **MCLK and `use_apll = true`.** The 440Hz phase came out at the correct
  pitch, so the ES8311's DLL locks to the 4.096MHz MCLK and the 256 x fs
  coefficient row is the right one.
- **`I2S_CHANNEL_FMT_ONLY_LEFT` on a full-duplex port.** Playback runs at the
  correct speed, so mono samples land in the left slot as intended rather than
  being spread across both.
- **The TCA9555 amplifier enable.** The NS4150B is off at reset, so audible
  output is itself the proof that `boardSetSpeakerAmp()` reaches P10.
- **No clicks between melody notes**, so gating the amplifier on the state
  transitions does not pop.

Confirmed again on the production firmware, from the four-second replay:

```
(replay) Board: Waveshare ESP32-S3-AUDIO-Board
(replay) TCA9555 0x20: ok | amp enable P10
(replay) Codec: ES8311 ok, ES7210 ok | 16000Hz/16bit, MCLK GPIO12
(replay) WS2812 ring GPIO38: ok, 7 pixels
(replay) I2S port 0 full duplex: out GPIO16, in GPIO15, BCLK 13, LRCK 14 | spk 16000Hz, mic 16000Hz
```

- **8MB octal PSRAM**, so `qio_opi` is right for the ESP32-S3R8: the banner
  reports `psram 8386295` and the 60KB opus scratch lands in it.
- **The whole voice loop**, over the deployed server:

  ```
  Mic open -- listening
  PTT: end_of_speech sent after 3050ms (1120ms voiced, avg 152, peak 2067)
  AUDIO.COMMITTED
  RESPONSE.CREATED -> transitioning to speaking
  ```

  That one exchange covers everything the self-test could not: the ES7210
  captures real signal, `I2S_CHANNEL_FMT_ONLY_LEFT` is right on the read side
  too (microphone 1 is on the left slot), micTask and audioStreamTask share one
  `I2SStream` on one full-duplex port without a mutex between them, and libopus
  decodes the server's 24kHz stream straight to 16kHz with no resampling of
  ours.
- **Volume key polarity.** KEY1 raises and KEY2 lowers, so the expander's
  active-low assumption holds.
- **The WS2812 ring lights**, so the RMT bit timings are within the WS2812B
  window.

Note the replay itself. Everything above is decided in `setup()`, whose output
does not survive USB CDC enumeration on this board — the lines print and never
reach the host. `boardReport()` exists so that a normal boot can be diagnosed
at all; it is called from `loop()` at four seconds alongside `audioMemoryReport()`,
which was already there for the same reason.

## What is still untested

The full duplex voice loop works end to end — see below — so what is left is
the gestures and the power states:

- **The reboot combination** (KEY1 + KEY2 for 2s) and **KEY3** (tap for a new
  conversation, hold to sleep) have not been pressed.
- **The volume limit flash.** The keys were exercised between 10 and 50, never
  to either limit, so `ledFlash()` has not actually been seen.
- **Deep sleep and wake** on this board. GPIO0 is RTC IO here as on the other
  board, but ext0 has not been tried, and the expander keys cannot wake it.
- **Battery operation.** The board has a battery header, a charge manager and a
  mechanical battery switch, and GPIO8 is a battery ADC that nothing reads yet.

Deep sleep still wakes on GPIO0 only. The other three keys are behind the
expander and cannot wake the chip, so the touch-pad-to-sleep gesture maps to
KEY3 but nothing on the ring or the expander can bring the device back.


## xiaozhi xmini-c3 (ESP32-C3)

Build env `xmini-c3` (also `-localws` and `-audiotest`). Pins come from
xiaozhi-esp32 v2.2.6 `main/boards/xmini-c3/config.h`, the firmware the board
shipped with.

| | |
|---|---|
| Chip / flash / PSRAM | ESP32-C3 single core 160MHz, 16MB, **none** |
| Codec | one ES8311 `0x18` does both directions (its own ADC is the mic) |
| I2S | port 0 full duplex, MCLK 10, BCLK 8, LRCK 6, DOUT 5, DIN 7 |
| Pipeline rate | 24kHz both ways; the mic is brought to 16kHz for the server (`Downsample.h`) |
| Amp enable | GPIO11 (needs the VDD_SPI_AS_GPIO efuse; xiaozhi already burnt it) |
| I2C | SDA 3 / SCL 4, shared with the SSD1306 128x64 at `0x3C` (u8g2 R0) |
| Status LED | none -- GPIO2 is the battery divider, not an LED |
| Battery | ADC1 ch2 (GPIO2), 12dB, raw 2450 = 0% .. 3080 = 100%; charging = GPIO12 high |
| Keys | BOOT (GPIO9) only: push to talk. No volume keys, no touch pad |

Things that differ from the S3 boards and are easy to trip over:

- **DIO flash.** The devkitm-1 board default is QIO, and the QIO Arduino
  bootloader boot-loops silently on this board (`rst:0x3 RTC_SW_SYS_RST` every
  ~30ms, nothing from the app). `board_build.flash_mode = dio` fixes it.
- **No PSRAM.** libopus' 60KB default scratch is sized for the encoder; the
  decoder's measured peak is 6.9KB, so this board hands it 16KB (see
  `kOpusScratchBytes` in `Audio.cpp`). That is what leaves room for TLS: about
  73KB free with WiFi up, largest block 54KB. The per-boot `opus scratch` line
  prints the on-device high-water mark; if it ever gets near 16384, raise it.
- **No idle sleep.** The env sets `IDLE_SLEEP_SECONDS=0`: the board and its
  screen stay on. If sleep is ever turned back on: GPIO9 cannot wake the C3
  from deep sleep and there is no ext0, so it is a *light* sleep woken by BOOT,
  followed by a restart, and esptool cannot reach it while asleep ("No serial
  data received") -- press BOOT or RST first.
- **WifiManager task stack is 8KB here**, not 4KB. The registration request's
  TLS handshake runs on it and overflowed 4KB on every connect (a boot loop
  the moment WiFi came up); measured headroom at 8KB is ~3KB.
- **Each battery sample is 64 ADC reads, trimmed.** Single reads spread
  about +-100 counts around a steady level, with spikes of several hundred
  when the speaker or mic switches, and the vendor table spends 5.3 counts
  per percent: one read per sample made the screen wander 27..37% in a
  minute on a constant voltage. A trimmed mean of 64 (top and bottom 16
  dropped), averaged over 6 samples, holds the level to about +-1%, and the
  screen only moves on a 2-point change. No samples while the toy talks.
- **The "charging" pin was found floating.** On USB with the cell at ~3.86V
  it read 1 with the internal pull-up and 0 with the pull-down, so nothing
  was driving it (2026-09-30); it is now pulled down. The vendor code reads
  1 as charging; that has not yet been seen on a board that was charging.
- **Battery wiring is not in any public xiaozhi source.** The open-source
  config calls GPIO2 the LED; on this board it is the battery sense divider,
  and the vendor firmware creates `SingleLed(GPIO_NUM_NC)`. The ADC channel,
  the charge pin, the 3-reading mean and the percentage table were read out of
  the vendor firmware by disassembly (details in `src/Battery.cpp`). GPIO12 is
  the flash's HD line, usable only because flash runs in DIO.
- **Upload** works with plain `pio run -e xmini-c3 -t upload`; the USB-Serial/JTAG
  reset sequence enters the bootloader on its own.
- Before the first flash, back up the stock firmware
  (`esptool.py read_flash 0 0x1000000 backup.bin`) and `erase_flash`: xiaozhi's
  otadata sits inside this firmware's NVS range.

- **One core, so networkTask cannot sit at the top priority.** The TLS
  handshake is ~1.3s of CPU inside `webSocket.loop()`, and it froze the boot
  sound for 1138ms. It runs level with the speaker task here (3), and
  `wsMutex` is a binary semaphore rather than a mutex: a system lock taken at
  the start of the handshake pushed networkTask to priority 23 by
  inheritance, and FreeRTOS does not hand that back while the task still
  holds *any* mutex -- which it did, for the whole handshake. Both are
  `CONFIG_FREERTOS_UNICORE` only; see `setup()` in main.cpp.

- **24kHz, not the Waveshare board's 16kHz.** Nothing on this bus needs
  16kHz -- that was the ES7210 -- so it plays the server's stream at the
  rate it was synthesised at. The mic shares the LRCK and so captures at
  24kHz too; a 3:2 polyphase FIR in `Downsample.h` (flat to 6.5kHz, -65dB
  from 8kHz, 48 multiply-adds per output) brings it to the 16kHz the server
  expects, so the server needs no change. Decode cost is the same at either
  rate (20.7% vs 20.6% of the core on the 40kbps stream), but RAM is not.
  The first 24kHz build left 14KB free while speaking, falling to 11.9KB
  (2KB largest block) over a few turns; long presses dropped the websocket
  and a reconnect failed with `SSL - Memory allocation failed`. The PCM ring
  is 12KB here instead of 20KB (`AUDIO_BUFFER_SIZE`), which put it at 27.6KB
  free, 7.6KB largest block (2026-09-30). Watch the `Speaking: heap` line.
- **Louder than xiaozhi at the same volume.** At volume 70 this puts -3.1dB
  on the DAC where xiaozhi's esp_codec_dev curve puts -11.4dB. -8dB of
  `BOARD_DAC_GAIN_DB` matched it and reduced some distortion, but was judged
  too quiet, so it is 0dB. That constant is the knob if the speaker distorts.

Verified on hardware 2026-09-23: boot, ES8311 DAC + ADC configured, OLED,
LED, I2S full duplex, boot chime path, SoftAP. 2026-09-30: the boot sound
plays through the TLS handshake with no gap, and a 13.5s greeting from the
deployed server decodes at 26.5% of the core (rtf 37%), glitches 0. **Not yet
verified:** mic level on a real turn and the light-sleep wake.


## Spotpear AI Toy (ESP32-C3)

Build env `spotpear-ai-toy` (also `-localws` and `-audiotest`), flag
`BOARD_SPOTPEAR_AI_TOY`. **The likely production board** (2026-10-05). The
board is not in the xiaozhi repository. It shipped with a vendor build of xiaozhi
2.1.0 (SKU `toy-ai-core-c3-1.54`), and every pin below was read out of that
image by disassembly, on 2026-10-05:

- the I2C, SPI and panel-IO config structs built in the board constructor and
  in `InitializeSt7789Display()`;
- the arguments to the `Es8311AudioCodec` and `SingleLed` constructors in
  `GetAudioCodec()` and `GetLed()`;
- the source text that `ESP_ERROR_CHECK` keeps as a string, which names each
  call, e.g. `esp_lcd_panel_invert_color(panel, true)`.

The full flash backup and the full pin list are in
`~/Desktop/小智備份/toy-ai-core-c3-1.54/` on the dev Mac.

| | |
|---|---|
| Chip / flash / PSRAM | ESP32-C3 rev v0.4, 16MB, **none** |
| Audio | identical to the xmini-c3: ES8311 `0x18`, MCLK 10, BCLK 8, LRCK 6, DOUT 5, DIN 7, amp GPIO11, I2C SDA 3 / SCL 4 |
| Amp enable | GPIO11; VDD_SPI_AS_GPIO already burnt (read with espefuse) |
| Status LED | one WS2812 on GPIO2, driven as a ring of one |
| Screen | ST7789 240x240 on SPI2: MOSI 21, SCLK 0, CS 20, DC 1, no reset pin, colours inverted. **Not driven**: this build has no screen |
| Backlight | no control in the vendor firmware; it appears hard-wired on |
| Battery | a cell is fitted, but nothing can measure it: see below |
| Keys | BOOT (GPIO9) only |

Everything in the xmini-c3 notes above applies, since the chip, flash mode
and audio path are the same; `Config.cpp` serves both from one block. The
partition table is not the same: this board ships with `partition_16m.csv`
(below). Two exceptions:

- **The mic threshold is borrowed.** `MIC_VOICE_LEVEL` is the xmini-c3's 450,
  which assumes the same codec at the same gains with a similar mic. It has
  not been measured on this board.
- **No battery sense on the board as sold.** The vendor firmware's
  `GetBatteryLevel()` is the base class's `return false`, and the hardware
  could not do better: the C3's ADC pins are GPIO0-5 only, and all six are
  taken (screen SCLK and DC, LED, I2C, I2S). `BOARD_HAS_BATTERY` is 0.
- **esptool cannot reset it out of the bootloader.** After a read or a write,
  `--after hard_reset` leaves it in download mode. Either unplug it and plug it
  back in, or open the port with pyserial and pulse RTS with DTR low:
  `dtr=False`, `rts=True`, wait 0.1s, then `rts=False`.

Verified on hardware on 2026-10-05, with the full flash backed up first and
then erased:

- it boots with the ES8311 configured, DAC and ADC both, at 24kHz;
- the display scan finds only `0x18` and the board runs headless;
- the boot chime plays from the speaker;
- the WS2812 shows magenta during SoftAP, so the GRB order is right;
- SoftAP `ELATO-DEVICE` comes up;
- internal RAM has 73KB free with WiFi up, and the largest block is 53KB.

The same day, the person testing it bound it in the app and held a
conversation with the server, so real speech clears the borrowed mic
threshold. **Not yet measured:** whether silence stays under it, and battery
sense (no hardware for it yet).

### Low-battery reminder without battery sense

Since 2026-10-06 the board warns of a flat battery without measuring it
(`BOARD_LOW_BATTERY_VIA_VDD`, `src/SupplyMonitor.cpp`). The cell feeds a
regulator that holds the chip at 3.3V until the cell gets near empty; after
that VDD sags. So VDD dropping is the "nearly empty" signal.

How VDD is read:

- GPIO0 is the undriven screen SCLK. With both internal pulls on, it sits at
  about 45% of VDD, which ADC1 channel 0 can read. Pulled up alone it reads a
  flat 4095.
- On USB it measured 2031..2039 counts, steady to a few counts. GPIO1 does the
  same at 2090.
- GPIO20, the screen's CS, is held high so the panel ignores the line.
- The first reading the board ever takes is stored in NVS as its reference.

How it warns:

- **Thresholds.** Below 95.5% of the reference (VDD about 3.15V) for a 30s
  window, the LED's idle green turns red. It clears above 97.5%.
- **Reminder.** A spoken Cantonese reminder plays then, and again every 10
  minutes while still low. The text is "電量不足，請充電。", from
  `assets/low-battery.wav` (2026-10-14; it used to ask 爸爸媽媽 to charge the
  toy, which does not suit the adult brands).
- **Timing.** The reminder waits for the device to be idle, so it never talks
  over the toy.
- **After a brownout.** A brownout reset gives one reminder on the next boot.
- **In the app (R-41).** The same low state goes to the voice server as
  `{"type":"power","low":...}` once per session after "auth" and on every
  change (`reportPower()` in `src/Audio.cpp`); the server writes it to
  `devices.battery_low`, and the app shows the last report with its time.

Verified 2026-10-06 with `SUPPLY_LOW_RATIO_OVERRIDE=1.05f`, which forces the
low state: the reminder played after the greeting turn ended, and the LED was
red. **Not yet verified:** that the reading tracks a real run-down, and how
long before shutdown it fires. Each boot prints a run log from NVS (`Supply
log:`): an entry every 2 minutes, written straight to NVS once the reading is
under 99%. A charge-then-drain run with that log is the test.

Power path, seen the same day: with a flat cell fitted, the chip reads 98-99%
of its USB-only reference **while on USB**, so it runs from the cell's node
rather than from USB. With the cell flat, the board took minutes to show up on
USB after being plugged in, and once dropped off USB halfway through a 1.6MB
flash write. Ask Spotpear whether the charger has load sharing (power path).
Without it, a toy that is plugged in with a dead cell may brown out repeatedly
before it can start.

### Battery sense for the production board

**On hold.** On 2026-10-06 the owner said a reminder when the battery is
nearly flat is enough; a percentage is not needed. So ask for this only if a
run-down shows the reminder above comes too late or not at all.

The board has no screen in this product, so GPIO0, the screen's SCLK and ADC1
channel 0, goes to a divider. This is what to ask Spotpear for:

| | |
|---|---|
| Pin | GPIO0 (ADC1 ch0). GPIO1 (ADC1 ch1) works the same if it routes better; tell us which |
| Divider | cell + -> 100k -> GPIO0 -> 100k -> GND, 1% resistors, so 4.2V reads 2.1V |
| Filter | 100nF from GPIO0 to GND, next to the pin |
| Node | the cell itself, after the protection IC, **not** the charger's system output |
| Screen | not fitted, or at least GPIO0 not routed to it |

Why these values:

- **Range.** Halving the cell keeps a full charge (4.2V, up to ~4.35V
  while charging) inside the C3's 12dB ADC range, which runs to about 2.5V.
- **Drain.** The divider costs 21uA, about 0.5mAh a day.
- **Filter.** The 100nF lets the ADC sample a 50k source cleanly.
- **Node.** Measured on the system rail instead, it would read the USB
  supply whenever the toy is plugged in.

A charge-status output is worth asking for too: the charger's CHRG pin to
GPIO12 or GPIO13. Those are the two free pins, and the xmini-c3 uses GPIO12
for this. Both are the flash's HD and WP lines, so Spotpear has to confirm
they are not wired to the flash on this board.

Firmware that follows the hardware: a reading path keyed to millivolts
rather than the xmini-c3's raw table, battery polling that does not depend
on the display task (which exits on a headless board), and somewhere for
the number to go, because nothing in the server or the app carries a
battery level today.

**Partition table (P2-12, fixed 2026-10-14).** `partition_16m.csv`, which the
factory image freezes for good -- OTA can replace the app, never the table:

| Partition | Offset | Size | What |
|---|---|---|---|
| nvs, otadata | 0x9000, 0xe000 | 20K, 8K | where `partition.csv` had them, so a USB move keeps Wi-Fi and the device secret |
| app0, app1 | 0x10000, 0x410000 | 4MB each | the app is ~1.6MB, ~2.2MB with BLE provisioning (R-21) |
| assets | 0x810000 | 2MB | brand sounds: `tools/build_assets.py` packs them, `src/Assets.cpp` plays them in place |
| nvs_keys | 0xa10000 | 4K | for NVS encryption once flash encryption is on (P0-14) |
| coredump | 0xa20000 | 64K | the core writes a crash dump here (a test abort left 14.8KB) |
| media | 0xa30000 | 5.8MB | offline songs and stories (R-14) |

The assets pack is per brand and is not part of the app upload: flash it with
`esptool.py write_flash 0x810000`. A missing or corrupt pack is reported at
boot (`Assets: none (...)`) and the board falls back to its built-in boot and
low-battery sounds; the Wi-Fi prompts exist only in the pack. Do not embed
sounds in the app instead: on 2026-10-14 seven prompts pushed the image to
2,147,728 bytes on the old 2MB slot and the board boot-looped silently, while
pio still printed "Flash 99%" and SUCCESS. `release_firmware.py` now refuses
an image larger than the build's app slot.

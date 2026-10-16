#include "OTA.h"

#include <HTTPClient.h>
#include <Update.h>
#include <WiFiClientSecure.h>

#include "esp_ota_ops.h"
#include "mbedtls/sha256.h"

/*
 * Firmware updates, and getting back from a bad one (P0-13).
 *
 * Every boot, the request that trades the device secret for a device token
 * (/api/generate_auth_token) also tells the backend what this board runs, and
 * the answer says whether the current release for its board is a different
 * version. If so, the board downloads it (/api/ota/firmware/<id>, device token
 * in the header), checks the SHA-256 the backend gave it, and restarts into
 * it. Riding on the token request keeps a boot at one TLS handshake.
 * The download happens before the voice websocket opens, so the C3's heap only
 * ever holds one TLS session.
 *
 * The new image boots on probation. The Arduino core would normally declare
 * every image good the moment it starts; verifyRollbackLater() below stops
 * that. The image is only marked valid once the voice server has answered AND
 * it has then stayed up for OTA_STABLE_MS. Until then any reset -- a crash, a
 * watchdog, a brownout, a power cut -- makes the bootloader go back to the
 * previous image, and so does running OTA_PROBATION_MS on WiFi without
 * reaching the server.
 *
 * Reaching the server alone is not enough: the board connects about a second
 * after boot, and an image that crashed three seconds in was confirmed first
 * and then crash-looped with nothing left to roll back to (device test,
 * 2026-10-08). The stable window covers the greeting being decoded and played,
 * which is where a broken audio path shows up. The rollback relies on
 * CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE, which the Arduino 2.0.17 bootloader
 * for both the C3 and the S3 has.
 *
 * The version that was installed is kept in NVS ("ota"/"target") until the
 * image is confirmed. Booting with a different version than that target means
 * the board rolled back. Whether that counts against the image depends on the
 * reset that caused it, which the old image can still read: a crash or a
 * watchdog is the image's fault, and the next check reports it as failed so
 * the backend never offers it to this board again. A power cut, a brownout or
 * an external reset is not -- this board loses power on its own now and then
 * (R-17) -- so the image is tried again, up to OTA_MAX_TRIES installs.
 *
 * Probation only covers the first minutes. An image that is confirmed and
 * starts crash-looping later would otherwise need a USB cable to recover, and
 * boards in the field have none. So every boot counts consecutive crash resets
 * in RTC memory (kept across resets, cleared by a power cut or by staying up
 * OTA_HEALTHY_MS); OTA_CRASH_LOOP in a row switch the board back to the other
 * slot, once, and that version is reported as failed like a rollback.
 */

// Long enough for a slow DHCP and the device-token round trip, short enough
// that a broken image does not keep a child waiting for long.
static const uint32_t OTA_PROBATION_MS = 10UL * 60UL * 1000UL;
static const uint32_t OTA_STABLE_MS = 2UL * 60UL * 1000UL;
static const uint32_t OTA_STALL_MS = 20000;
// Installs of one version before a non-crash rollback counts as a failure: a
// second power cut in the same probation window is no longer bad luck.
static const uint8_t OTA_MAX_TRIES = 2;
// Crash resets in a row that make a confirmed image give way to the other slot.
static const uint32_t OTA_CRASH_LOOP = 3;
// Uptime after which the crash streak is forgotten. A crash loop resets within
// seconds; an image that has run this long is not in one.
static const uint32_t OTA_HEALTHY_MS = 5UL * 60UL * 1000UL;

static bool onProbation = false;
static bool checkedThisBoot = false;
static String failedVersion;
// Each start time comes with its own flag. Marking "set" by forcing the low
// bit (millis() | 1) put the time up to 1ms in the future, so the next poll's
// unsigned millis() - t wrapped to ~49 days: 1.1.1 rolled itself back the
// instant WiFi came up (device test, 2026-10-08).
static bool wifiUp = false;
static uint32_t wifiUpAt = 0;
static bool serverReached = false;
static uint32_t serverReachedAt = 0;
static bool healthy = false;

// Survive panic, watchdog and software resets; garbage after a power cut,
// hence the magic.
static const uint32_t CRASH_MAGIC = 0x0A7A11ED;
RTC_NOINIT_ATTR static uint32_t crashMagic;
RTC_NOINIT_ATTR static uint32_t crashStreak;
RTC_NOINIT_ATTR static uint32_t fellBackThisStreak;

static bool isCrashReset(esp_reset_reason_t reason) {
    return reason == ESP_RST_PANIC || reason == ESP_RST_INT_WDT || reason == ESP_RST_TASK_WDT ||
           reason == ESP_RST_WDT;
}

// Weak in the Arduino core (esp32-hal-misc.c, C linkage). Returning true
// leaves the image's rollback state alone at startup; otaPoll() settles it.
extern "C" bool verifyRollbackLater() { return true; }

static String nvsTarget() {
    Preferences p;
    // Read-write so a board that never updated does not log NOT_FOUND each boot.
    p.begin("ota", false);
    String target = p.getString("target", "");
    p.end();
    return target;
}

// Clearing the target also clears what hangs off it: the install count and the
// crash-loop verdict.
static void setNvsTarget(const String &version, uint8_t tries = 0, bool crashed = false) {
    Preferences p;
    p.begin("ota", false);
    if (version.isEmpty()) {
        p.remove("target");
        p.remove("tries");
        p.remove("crashed");
    } else {
        p.putString("target", version);
        p.putUChar("tries", tries);
        p.putBool("crashed", crashed);
    }
    p.end();
}

static uint8_t nvsTries() {
    Preferences p;
    p.begin("ota", false);
    const uint8_t tries = p.getUChar("tries", 0);
    p.end();
    return tries;
}

static bool nvsCrashed() {
    Preferences p;
    p.begin("ota", false);
    const bool crashed = p.getBool("crashed", false);
    p.end();
    return crashed;
}

// The other OTA slot, if it holds an app the bootloader has not given up on.
static const esp_partition_t *usableOtherSlot() {
    const esp_partition_t *other = esp_ota_get_next_update_partition(NULL);
    esp_app_desc_t desc;
    if (!other || esp_ota_get_partition_description(other, &desc) != ESP_OK) {
        return NULL;  // empty: a board that was only ever flashed over USB
    }
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(other, &state) == ESP_OK &&
        (state == ESP_OTA_IMG_INVALID || state == ESP_OTA_IMG_ABORTED)) {
        return NULL;
    }
    return other;
}

// What this image is, for the admin console's firmware upload (P2-20): it
// reads the board and version from here instead of asking for them, and only
// takes a release build. A build pointed at a LAN machine, or the speaker
// self-test, is a dev build -- the same ones tools/release_firmware.py refuses.
// Printed at boot, which also keeps the linker from dropping it.
#if defined(DEV_MODE) || defined(LOCAL_WS_HOST) || defined(LOCAL_BACKEND_HOST) || defined(AUDIO_SELFTEST)
#define OTA_BUILD_KIND "dev"
#else
#define OTA_BUILD_KIND "release"
#endif
static const char BUILD_INFO[] =
    "aibuddy-build;kind=" OTA_BUILD_KIND ";board=" BOARD_ID ";version=" FIRMWARE_VERSION ";";

void otaBootCheck() {
    Serial.printf("[OTA] %s\n", BUILD_INFO);

    esp_ota_img_states_t state;
    const esp_partition_t *running = esp_ota_get_running_partition();
    onProbation = esp_ota_get_state_partition(running, &state) == ESP_OK &&
                  state == ESP_OTA_IMG_PENDING_VERIFY;

    const esp_reset_reason_t reason = esp_reset_reason();
    const bool crashed = isCrashReset(reason);
    if (crashMagic != CRASH_MAGIC) {
        crashMagic = CRASH_MAGIC;
        crashStreak = 0;
        fellBackThisStreak = 0;
    }
    crashStreak = crashed ? crashStreak + 1 : 0;

    Serial.printf("[OTA] Firmware %s for %s on %s%s\n", FIRMWARE_VERSION, BOARD_ID,
                  running ? running->label : "?", onProbation ? ", on probation" : "");

    // Rolled back (or fell back) from another version: was it that image's fault?
    const String target = nvsTarget();
    if (!target.isEmpty() && target != FIRMWARE_VERSION) {
        const uint8_t tries = nvsTries();
        const bool fellBack = nvsCrashed();
        if (fellBack && onProbation) {
            // We switched back here from a crash-looping image, and switching
            // slots puts the target on probation again. This image was
            // confirmed before; a power cut in a fresh probation would send the
            // bootloader straight back to the image that crash-loops, with the
            // one fall-back of this streak already spent.
            if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
                onProbation = false;
                Serial.printf("[OTA] Firmware %s confirmed again after the fall-back\n", FIRMWARE_VERSION);
            }
        }
        if (fellBack || crashed || tries >= OTA_MAX_TRIES) {
            failedVersion = target;
            Serial.printf("[OTA] Back from %s (reset reason %d, install %u): reporting it as failed\n",
                          target.c_str(), (int)reason, (unsigned)tries);
        } else {
            // Not its fault: keep target and count so the next install is try 2.
            Serial.printf("[OTA] Back from %s after a non-crash reset (reason %d); will try it again\n",
                          target.c_str(), (int)reason);
        }
    }

    // A confirmed image that keeps crashing: give way to the other slot, once.
    if (!onProbation && crashStreak >= OTA_CRASH_LOOP && !fellBackThisStreak) {
        const esp_partition_t *other = usableOtherSlot();
        if (other && esp_ota_set_boot_partition(other) == ESP_OK) {
            fellBackThisStreak = 1;
            setNvsTarget(FIRMWARE_VERSION, nvsTries(), true);
            Serial.printf("[OTA] %u crashes in a row: switching back to %s\n", (unsigned)crashStreak, other->label);
            delay(100);
            esp_restart();
        }
        Serial.printf("[OTA] %u crashes in a row and no other image to go back to\n", (unsigned)crashStreak);
    }
}

static String hex(const uint8_t *bytes, size_t len) {
    static const char digits[] = "0123456789abcdef";
    String out;
    out.reserve(len * 2);
    for (size_t i = 0; i < len; i++) {
        out += digits[bytes[i] >> 4];
        out += digits[bytes[i] & 0x0f];
    }
    return out;
}

// Stream the image into the idle OTA slot, hashing as it goes. Leaves the slot
// set as the next boot partition only if every byte arrived and the hash and
// the image header both check out.
static bool installImage(const String &path, size_t size, const String &sha256) {
    const esp_partition_t *slot = esp_ota_get_next_update_partition(NULL);
    if (!slot || size > slot->size) {
        Serial.printf("[OTA] Image of %u bytes does not fit the %u-byte slot\n", (unsigned)size,
                      slot ? (unsigned)slot->size : 0);
        return false;
    }

    HTTPClient http;
    WiFiClientSecure client;
    beginBackendRequest(http, client, path);
    http.addHeader("Authorization", "Bearer " + authTokenGlobal);
    http.setTimeout(OTA_STALL_MS);
    const int code = http.GET();
    if (code != HTTP_CODE_OK || http.getSize() != (int)size) {
        Serial.printf("[OTA] Download refused: HTTP %d, %d bytes\n", code, http.getSize());
        http.end();
        return false;
    }
    if (!Update.begin(size, U_FLASH)) {
        Serial.printf("[OTA] Cannot start the update: %s\n", Update.errorString());
        http.end();
        return false;
    }

    mbedtls_sha256_context sha;
    mbedtls_sha256_init(&sha);
    mbedtls_sha256_starts_ret(&sha, 0);

    // Off the task stack: wifiTask has little to spare.
    static uint8_t buf[2048];
    WiFiClient *stream = http.getStreamPtr();
    size_t done = 0;
    uint32_t lastByteAt = millis();
    unsigned lastTenth = 0;
    bool ok = true;
    while (done < size) {
        const size_t available = stream->available();
        if (available == 0) {
            if (!http.connected() || millis() - lastByteAt > OTA_STALL_MS) {
                Serial.printf("[OTA] Download stalled at %u/%u bytes\n", (unsigned)done, (unsigned)size);
                ok = false;
                break;
            }
            delay(5);
            continue;
        }
        const int n = stream->readBytes(buf, min(available, min(sizeof(buf), size - done)));
        if (n <= 0) {
            continue;
        }
        mbedtls_sha256_update_ret(&sha, buf, n);
        if (Update.write(buf, n) != (size_t)n) {
            Serial.printf("[OTA] Flash write failed: %s\n", Update.errorString());
            ok = false;
            break;
        }
        done += n;
        lastByteAt = millis();
        const unsigned tenth = done * 10 / size;
        if (tenth != lastTenth) {
            lastTenth = tenth;
            Serial.printf("[OTA] %u%%\n", tenth * 10);
        }
        // The audio tasks and the idle task's watchdog both need the CPU back.
        delay(1);
    }
    http.end();

    uint8_t digest[32];
    mbedtls_sha256_finish_ret(&sha, digest);
    mbedtls_sha256_free(&sha);

    if (ok && hex(digest, sizeof(digest)) != sha256) {
        Serial.printf("[OTA] SHA-256 mismatch: got %s\n", hex(digest, sizeof(digest)).c_str());
        ok = false;
    }
    if (!ok) {
        Update.abort();
        return false;
    }
    // Checks the image header and sets the slot as the next boot partition.
    if (!Update.end(true)) {
        Serial.printf("[OTA] Image rejected: %s\n", Update.errorString());
        return false;
    }
    return true;
}

// The release the token answer offered this boot, if any.
static struct {
    bool offered = false;
    String version;
    String path;
    String sha256;
    size_t size = 0;
} offer;

void otaAddReport(JsonDocument &request) {
    JsonObject firmware = request["firmware"].to<JsonObject>();
    firmware["board"] = BOARD_ID;
    firmware["version"] = FIRMWARE_VERSION;
    if (!failedVersion.isEmpty()) {
        firmware["failed_version"] = failedVersion;
    }
}

void otaTakeAnswer(JsonVariantConst ota) {
    // Absent when the backend predates OTA or its release lookup failed. The
    // report did not land then, so keep the failure to send next time.
    if (ota.isNull()) {
        return;
    }
    checkedThisBoot = true;

    // The backend has the failure on record now; stop carrying it.
    if (!failedVersion.isEmpty()) {
        failedVersion = "";
        setNvsTarget("");
    }

    offer.offered = ota["update"] | false;
    if (offer.offered) {
        offer.version = ota["version"] | "";
        offer.path = ota["url"] | "";
        offer.sha256 = ota["sha256"] | "";
        offer.size = ota["size"] | 0;
    }
}

// The spoken "updating" prompt. Only audioStreamTask may play through the
// output port, so the install asks for it here and waits for that task.
static volatile bool updatePromptWanted = false;
static volatile bool updatePromptDone = false;
// The boot chime (~2.8s) can still be playing when the token answer arrives,
// and the prompt queues behind it. Past this the download starts regardless:
// a board that cannot speak must still update.
static const uint32_t OTA_PROMPT_WAIT_MS = 7000;

bool otaTakeUpdatePrompt() {
    if (!updatePromptWanted) return false;
    updatePromptWanted = false;
    return true;
}

void otaUpdatePromptDone() { updatePromptDone = true; }

static void speakUpdatePrompt() {
    updatePromptDone = false;
    updatePromptWanted = true;
    const uint32_t start = millis();
    while (!updatePromptDone && millis() - start < OTA_PROMPT_WAIT_MS) {
        delay(20);
    }
    if (!updatePromptDone) {
        updatePromptWanted = false;
        Serial.println("[OTA] Update prompt not played in time, installing anyway");
    }
}

void otaCheckAndUpdate() {
    if (!offer.offered) {
        Serial.println(checkedThisBoot ? "[OTA] Up to date" : "[OTA] No update answer this boot");
        return;
    }
    if (onProbation) {
        // One unconfirmed image at a time: finish proving this one first.
        Serial.printf("[OTA] %s is available; installing after this image is confirmed\n", offer.version.c_str());
        return;
    }
    if (offer.version.isEmpty() || !offer.path.startsWith("/api/ota/firmware/") || offer.sha256.length() != 64 ||
        offer.size == 0) {
        Serial.println("[OTA] Update offer incomplete, ignoring it");
        return;
    }

    Serial.printf("[OTA] Installing %s (%u bytes)\n", offer.version.c_str(), (unsigned)offer.size);
    const DeviceState before = deviceState;
    deviceState = OTA;
    // Before the download, not over it: the C3 is single-core, and the TLS
    // handshake and the flash writes are what the install must not starve.
    speakUpdatePrompt();
    if (!installImage(offer.path, offer.size, offer.sha256)) {
        deviceState = before;
        return;
    }
    const uint8_t tries = nvsTarget() == offer.version ? nvsTries() + 1 : 1;
    setNvsTarget(offer.version, tries);
    Serial.printf("[OTA] %s installed (try %u), restarting into it\n", offer.version.c_str(), (unsigned)tries);
    delay(200);
    ESP.restart();
}

bool otaCheckedThisBoot() { return checkedThisBoot; }

bool otaOnProbation() { return onProbation; }

void otaServerReached() {
    if (onProbation && !serverReached) {
        serverReached = true;
        serverReachedAt = millis();
        Serial.printf("[OTA] Voice server reached; confirming %s if it stays up %us\n", FIRMWARE_VERSION,
                      (unsigned)(OTA_STABLE_MS / 1000));
    }
}

static void confirmImage() {
    const esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
    if (err != ESP_OK) {
        Serial.printf("[OTA] Could not confirm this image: %s\n", esp_err_to_name(err));
        serverReachedAt = millis();  // try again after another stable window
        return;
    }
    onProbation = false;
    setNvsTarget("");
    Serial.printf("[OTA] Firmware %s confirmed\n", FIRMWARE_VERSION);
}

void otaPoll() {
    if (!healthy && millis() > OTA_HEALTHY_MS) {
        healthy = true;
        crashStreak = 0;
        fellBackThisStreak = 0;
    }
    if (!onProbation) {
        return;
    }
    if (serverReached) {
        if (millis() - serverReachedAt >= OTA_STABLE_MS) {
            confirmImage();
        }
        return;
    }
    if (!wifiUp) {
        if (WiFi.status() == WL_CONNECTED) {
            wifiUp = true;
            wifiUpAt = millis();
        }
        return;
    }
    if (millis() - wifiUpAt > OTA_PROBATION_MS) {
        Serial.printf("[OTA] Firmware %s never reached the voice server, rolling back\n", FIRMWARE_VERSION);
        delay(100);
        esp_ota_mark_app_invalid_rollback_and_reboot();
    }
}

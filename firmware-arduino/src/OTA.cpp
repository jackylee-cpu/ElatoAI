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
 * the board rolled back; the next check reports it as failed, and the backend
 * does not offer that version to this board again.
 */

// Long enough for a slow DHCP and the device-token round trip, short enough
// that a broken image does not keep a child waiting for long.
static const uint32_t OTA_PROBATION_MS = 10UL * 60UL * 1000UL;
static const uint32_t OTA_STABLE_MS = 2UL * 60UL * 1000UL;
static const uint32_t OTA_STALL_MS = 20000;

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

static void setNvsTarget(const String &version) {
    Preferences p;
    p.begin("ota", false);
    if (version.isEmpty()) {
        p.remove("target");
    } else {
        p.putString("target", version);
    }
    p.end();
}

void otaBootCheck() {
    esp_ota_img_states_t state;
    const esp_partition_t *running = esp_ota_get_running_partition();
    onProbation = esp_ota_get_state_partition(running, &state) == ESP_OK &&
                  state == ESP_OTA_IMG_PENDING_VERIFY;

    const String target = nvsTarget();
    if (!target.isEmpty() && target != FIRMWARE_VERSION) {
        failedVersion = target;
    }
    Serial.printf("[OTA] Firmware %s for %s on %s%s%s\n", FIRMWARE_VERSION, BOARD_ID,
                  running ? running->label : "?", onProbation ? ", on probation" : "",
                  failedVersion.isEmpty() ? "" : (", rolled back from " + failedVersion).c_str());
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
    if (!installImage(offer.path, offer.size, offer.sha256)) {
        deviceState = before;
        return;
    }
    setNvsTarget(offer.version);
    Serial.printf("[OTA] %s installed, restarting into it\n", offer.version.c_str());
    delay(200);
    ESP.restart();
}

bool otaCheckedThisBoot() { return checkedThisBoot; }

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

import crypto from "node:crypto";

/**
 * Checking a firmware image uploaded in the admin console (P2-20), before it
 * becomes a release.
 *
 * The same refusals as firmware-arduino/tools/release_firmware.py, worked out
 * from the image alone, since an upload comes without the build directory:
 *
 *   - it is an ESP32 app image for the board's chip, and not cut short (the
 *     image carries a SHA-256 of itself at the end);
 *   - it says which board and version it is, and that it is a release build
 *     (the BUILD_INFO string in firmware-arduino/src/OTA.cpp). A build pointed
 *     at a LAN machine, or the speaker self-test, says kind=dev;
 *   - it fits the board's OTA app slot.
 *
 * Images built before BUILD_INFO existed are refused: those go out with the
 * release script, as before.
 *
 * Pure, and it imports nothing of ours, so `node --test` can run it directly.
 */

// esp_image_header_t chip_id values.
const ESP32_C3 = 5;
const ESP32_S3 = 9;

/**
 * The boards that ship, by BOARD_ID (firmware-arduino/src/BoardConfig.h), with
 * the app slot of the partition table their release env builds with
 * (firmware-arduino/platformio.ini). OTA can never change a board's partition
 * table, so the slot of boards flashed with an older table is kept too.
 */
export const FIRMWARE_BOARDS: Record<string, { label: string; chipId: number; appSlot: number; legacyAppSlot?: number }> = {
    // partition_16m.csv since P2-12; the boards flashed before it have 2MB.
    "spotpear-ai-toy": { label: "Spotpear AI Toy", chipId: ESP32_C3, appSlot: 0x400000, legacyAppSlot: 0x200000 },
    "xmini-c3": { label: "XMini C3", chipId: ESP32_C3, appSlot: 0x200000 },
    "waveshare-s3-audio": { label: "Waveshare S3 Audio", chipId: ESP32_S3, appSlot: 0x200000 },
    "elato-breadboard": { label: "ESP32-S3 DevKitC breadboard", chipId: ESP32_S3, appSlot: 0x200000 },
};

const IMAGE_MAGIC = 0xe9;
const APP_DESC_MAGIC = 0xabcd5432;
// esp_image_header_t (24 bytes) + the first segment's header (8 bytes).
const APP_DESC_OFFSET = 32;
const BUILD_INFO = /aibuddy-build;kind=([a-z]+);board=([a-z0-9][a-z0-9-]{0,62});version=([0-9A-Za-z][0-9A-Za-z.+-]{0,31});/;

export type FirmwareImage = {
    board: string;
    version: string;
    sha256: string;
    size: number;
    appSlot: number;
    /** Set when the image is too big for boards still on an older partition table. */
    warning: string | null;
};

export class FirmwareImageError extends Error {}

export const checkFirmwareImage = (image: Buffer): FirmwareImage => {
    if (image.length < APP_DESC_OFFSET + 4 + 32 || image[0] !== IMAGE_MAGIC
        || image.readUInt32LE(APP_DESC_OFFSET) !== APP_DESC_MAGIC) {
        throw new FirmwareImageError("This is not an ESP32 firmware image (firmware.bin from a pio build).");
    }
    // hash_appended: the last 32 bytes are the SHA-256 of everything before them.
    if (image[23] !== 1) {
        throw new FirmwareImageError("The image carries no checksum, so it cannot be checked for damage.");
    }
    const body = image.subarray(0, image.length - 32);
    if (!crypto.createHash("sha256").update(body).digest().equals(image.subarray(image.length - 32))) {
        throw new FirmwareImageError("The image is damaged or cut short: its own checksum does not match.");
    }

    const info = BUILD_INFO.exec(image.toString("latin1"));
    if (!info) {
        throw new FirmwareImageError(
            "The image does not say which board and version it is. It was built before the admin upload "
            + "existed: publish it with tools/release_firmware.py, or rebuild it.");
    }
    const [, kind, board, version] = info;
    if (kind !== "release") {
        throw new FirmwareImageError(
            `This is a ${kind} build of ${board} ${version} (pointed at a LAN machine, or the speaker self-test). `
            + "Only release builds can be published.");
    }
    const spec = FIRMWARE_BOARDS[board];
    if (!spec) {
        throw new FirmwareImageError(`${board} is not a board that ships.`);
    }
    if (image.readUInt16LE(12) !== spec.chipId) {
        throw new FirmwareImageError(`The image is for a different chip than ${spec.label}.`);
    }
    if (image.length > spec.appSlot) {
        throw new FirmwareImageError(
            `The image is ${image.length.toLocaleString("en")} bytes but the ${spec.label} app slot is `
            + `${spec.appSlot.toLocaleString("en")}: boards could not boot it.`);
    }

    return {
        board,
        version,
        sha256: crypto.createHash("sha256").update(image).digest("hex"),
        size: image.length,
        appSlot: spec.appSlot,
        warning: spec.legacyAppSlot && image.length > spec.legacyAppSlot
            ? `Over the ${spec.legacyAppSlot.toLocaleString("en")}-byte app slot of boards flashed before the `
              + "new partition table: those boards cannot install it."
            : null,
    };
};

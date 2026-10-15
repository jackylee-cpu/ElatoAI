// node --experimental-strip-types --test lib/firmwareImage.test.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { checkFirmwareImage, FirmwareImageError } from "./firmwareImage.ts";

/** A minimal app image: header, segment header, app descriptor, BUILD_INFO, padding, SHA-256. */
const image = ({ chipId = 5, kind = "release", board = "spotpear-ai-toy", version = "1.0.2", size = 4096, info = true } = {}) => {
    const body = Buffer.alloc(size - 32);
    body[0] = 0xe9;
    body.writeUInt16LE(chipId, 12);
    body[23] = 1;
    body.writeUInt32LE(0xabcd5432, 32);
    if (info) {
        body.write(`aibuddy-build;kind=${kind};board=${board};version=${version};\0`, 256, "latin1");
    }
    return Buffer.concat([body, crypto.createHash("sha256").update(body).digest()]);
};

const refused = (buf, pattern) =>
    assert.throws(() => checkFirmwareImage(buf), (e) => e instanceof FirmwareImageError && pattern.test(e.message));

test("a release build is read: board, version, size and SHA-256 of the whole file", () => {
    const buf = image();
    const got = checkFirmwareImage(buf);
    assert.equal(got.board, "spotpear-ai-toy");
    assert.equal(got.version, "1.0.2");
    assert.equal(got.size, buf.length);
    assert.equal(got.sha256, crypto.createHash("sha256").update(buf).digest("hex"));
    assert.equal(got.warning, null);
});

test("a dev build is refused", () => refused(image({ kind: "dev" }), /dev build/));
test("an image without BUILD_INFO is refused", () => refused(image({ info: false }), /release_firmware\.py/));
test("an unknown board is refused", () => refused(image({ board: "breadboard-x" }), /not a board that ships/));
test("an S3 image labelled as the C3 Spotpear is refused", () => refused(image({ chipId: 9 }), /different chip/));
test("something that is not an image is refused", () => refused(Buffer.from("PK\x03\x04 a zip file".repeat(10)), /not an ESP32/));

test("a cut-short or damaged image is refused", () => {
    const buf = image();
    refused(buf.subarray(0, buf.length - 100), /damaged or cut short/);
    const flipped = Buffer.from(buf);
    flipped[1000] ^= 0xff;
    refused(flipped, /damaged or cut short/);
});

test("too big for the app slot is refused; over the old 2MB slot only warns", () => {
    refused(image({ size: 0x400000 + 16 }), /could not boot it/);
    assert.match(checkFirmwareImage(image({ size: 0x200000 + 16 })).warning, /flashed before/);
    refused(image({ board: "xmini-c3", size: 0x200000 + 16 }), /could not boot it/);
});

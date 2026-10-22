// node --experimental-strip-types --test lib/deviceBattery.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { batteryState, hasBattery } from "./deviceBattery.ts";

const at = "2026-10-16T08:00:00Z";
const none = { battery_low: null, battery_percent: null, battery_charging: null, battery_full: null, battery_at: null };

test("a board that never reported has no battery", () => {
    assert.equal(hasBattery(none), false);
    assert.equal(hasBattery({ ...none, battery_at: at }), false);
    assert.equal(hasBattery({ ...none, battery_low: false, battery_at: at }), true);
});

test("the Spotpear board is only ever low or ok", () => {
    // It senses only "low"; charging and full stay unknown (null).
    assert.equal(batteryState({ ...none, battery_low: true, battery_at: at }), "low");
    assert.equal(batteryState({ ...none, battery_low: false, battery_at: at }), "ok");
});

test("charging wins over low and full", () => {
    const charging = { ...none, battery_low: true, battery_charging: true, battery_full: true, battery_at: at };
    assert.equal(batteryState(charging), "charging");
});

test("low wins over a stale full", () => {
    assert.equal(batteryState({ ...none, battery_low: true, battery_full: true, battery_at: at }), "low");
});

test("full from a board that senses it", () => {
    const full = { ...none, battery_low: false, battery_percent: 98, battery_charging: false, battery_full: true, battery_at: at };
    assert.equal(batteryState(full), "full");
    assert.equal(batteryState({ ...full, battery_full: false, battery_percent: 70 }), "ok");
});

test("a report from firmware without the full field is ok, not full", () => {
    const old = { ...none, battery_low: false, battery_percent: 100, battery_charging: false, battery_at: at };
    assert.equal(batteryState(old), "ok");
});

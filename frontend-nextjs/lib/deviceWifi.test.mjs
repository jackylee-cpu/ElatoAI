// node --experimental-strip-types --test lib/deviceWifi.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { firmwareLacksWifi, mergeWifiState } from "./deviceWifi.ts";

test("only 1.0.1 and older lack Wi-Fi reporting", () => {
    for (const version of ["1.0.1", "1.0.0", "0.9.9"]) {
        assert.equal(firmwareLacksWifi(version), true, version);
    }
    for (const version of ["1.0.2", "1.1.0", "1.8.2", "2.0.0", null, undefined, "", "dev"]) {
        assert.equal(firmwareLacksWifi(version), false, String(version));
    }
});

const list = {
    current: { ssid: "Home", rssi: -50 },
    saved: [{ ssid: "Home", joined: true }],
    max: 8,
};

test("an answer without a list keeps the list but takes online and reports_wifi", () => {
    const prev = { online: true, status: list, status_at: 1, ok: true, reports_wifi: null };
    const next = { online: true, status: null, status_at: null, ok: false, error: "unsupported", reports_wifi: false };
    const merged = mergeWifiState(prev, next);
    assert.equal(merged.status, list);
    assert.equal(merged.reports_wifi, false);
    assert.equal(merged.online, true);
});

test("an answer with a list replaces the state, and the first answer is taken whole", () => {
    const prev = { online: false, status: null, status_at: null, ok: true };
    const next = { online: true, status: list, status_at: 2, ok: true, reports_wifi: true };
    assert.equal(mergeWifiState(prev, next), next);
    assert.equal(mergeWifiState(null, prev), prev);
});

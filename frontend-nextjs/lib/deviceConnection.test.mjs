// node --experimental-strip-types --test lib/deviceConnection.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionState, RESTART_GRACE_MS } from "./deviceConnection.ts";

const connected = "2026-10-16T08:00:00Z";
const gone = "2026-10-16T09:00:00Z";
const goneMs = new Date(gone).getTime();
const base = { connected_at: connected, disconnected_at: gone, disconnect_reason: null, battery_low: null };

test("nothing for a board that never connected since connections were recorded", () => {
    assert.equal(connectionState({ ...base, connected_at: null, disconnected_at: null }), null);
});

test("online while the session is open", () => {
    assert.deepEqual(connectionState({ ...base, disconnected_at: null }), { state: "online", since: connected });
});

test("every sleep the board announces is asleep", () => {
    for (const reason of ["sleep_idle", "sleep_button", "sleep_session_end"]) {
        assert.deepEqual(connectionState({ ...base, disconnect_reason: reason }), { state: "asleep", since: gone });
    }
});

test("asleep even when the battery was low: it said goodbye", () => {
    assert.equal(connectionState({ ...base, disconnect_reason: "sleep_idle", battery_low: true }).state, "asleep");
});

test("lost after a low battery report is probably out of battery", () => {
    assert.equal(connectionState({ ...base, disconnect_reason: "lost", battery_low: true }).state, "out_of_battery");
    assert.equal(connectionState({ ...base, disconnect_reason: "lost", battery_low: false }).state, "offline");
    assert.equal(connectionState({ ...base, disconnect_reason: "lost" }).state, "offline");
});

test("old firmware and server restarts are offline, never a battery guess", () => {
    for (const reason of ["unknown", "server_restart", null]) {
        assert.equal(connectionState({ ...base, disconnect_reason: reason, battery_low: true }).state, "offline");
    }
});

test("a restart is restarting for a while, then offline", () => {
    const restart = { ...base, disconnect_reason: "restart" };
    assert.equal(connectionState(restart, goneMs + 30_000).state, "restarting");
    assert.equal(connectionState(restart, goneMs + RESTART_GRACE_MS + 1).state, "offline");
});

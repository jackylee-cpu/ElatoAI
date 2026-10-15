// node --experimental-strip-types --test lib/deviceServerUrls.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBackendUrl, parseVoiceUrl } from "./deviceServerUrls.ts";

test("the production voice URL passes through", () => {
    assert.equal(
        parseVoiceUrl("wss://elatoai.hkqft.com/fastapi/ws/esp32", true),
        "wss://elatoai.hkqft.com/fastapi/ws/esp32",
    );
    assert.equal(parseVoiceUrl("  wss://voice.example.com:8443/ws/esp32  ", true),
        "wss://voice.example.com:8443/ws/esp32");
});

test("plaintext is for dev servers only", () => {
    assert.equal(parseVoiceUrl("ws://10.6.1.26:7860/ws/esp32", false), "ws://10.6.1.26:7860/ws/esp32");
    assert.equal(parseVoiceUrl("ws://10.6.1.26:7860/ws/esp32", true), null);
    assert.equal(parseBackendUrl("http://10.6.1.26:3000", false), "http://10.6.1.26:3000");
    assert.equal(parseBackendUrl("http://10.6.1.26:3000", true), null);
    // Not even in dev: a board cannot resolve a name only this machine knows.
    assert.equal(parseVoiceUrl("ws://fastapi:7860/ws/esp32", false), null);
    assert.equal(parseBackendUrl("http://localhost:3000", false), null);
});

test("voice URLs that would send boards nowhere are refused", () => {
    for (const bad of [
        undefined,
        "",
        "   ",
        "elatoai.hkqft.com/fastapi/ws/esp32", // no scheme
        "https://elatoai.hkqft.com/fastapi/ws/esp32", // not a websocket
        "wss://elatoai.hkqft.com", // no path
        "wss://elatoai.hkqft.com/", // no path
        "wss://elatoai.hkqft.com/ws/esp32?x=1",
        "wss://elatoai.hkqft.com/ws/esp32#x",
        "wss://user:pass@elatoai.hkqft.com/ws/esp32",
        "wss:///ws/esp32", // parses as host "ws"
        "ws://fastapi:7860/ws/esp32", // a compose service name
        "ws://localhost:7860/ws/esp32",
    ]) {
        assert.equal(parseVoiceUrl(bad, true), null, String(bad));
    }
});

test("the backend is an origin, with or without a trailing slash", () => {
    assert.equal(parseBackendUrl("https://elatoai.hkqft.com", true), "https://elatoai.hkqft.com");
    assert.equal(parseBackendUrl("https://elatoai.hkqft.com/", true), "https://elatoai.hkqft.com");
    assert.equal(parseBackendUrl("https://api.example.com:8443", true), "https://api.example.com:8443");
    // The default port is dropped, so boards compare like with like.
    assert.equal(parseBackendUrl("https://elatoai.hkqft.com:443", true), "https://elatoai.hkqft.com");
});

test("backend URLs the firmware could not use are refused", () => {
    for (const bad of [
        undefined,
        "",
        "elatoai.hkqft.com",
        "wss://elatoai.hkqft.com",
        "https://elatoai.hkqft.com/supabase-api", // a path would be dropped
        "https://elatoai.hkqft.com/?x=1",
        "https://user:pass@elatoai.hkqft.com",
        "not a url",
    ]) {
        assert.equal(parseBackendUrl(bad, true), null, String(bad));
    }
});

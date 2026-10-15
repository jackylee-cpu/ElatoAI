// node --experimental-strip-types --test lib/otaRollout.test.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { inRollout, rolloutBucket } from "./otaRollout.ts";

const randomMac = () =>
    Array.from(crypto.randomBytes(6), (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");

const macs = Array.from({ length: 10_000 }, randomMac);
const release = (percent, whitelist = []) => ({
    release_id: "4f1c2a8e-5d0b-4a3e-9c7f-1b2d3e4f5a6b",
    rollout_percent: percent,
    rollout_macs: whitelist,
});
const share = (percent) => macs.filter((mac) => inRollout(release(percent), mac)).length / macs.length;

test("10% and 50% reach about that share of boards", () => {
    assert.ok(Math.abs(share(10) - 0.10) < 0.01, `10% stage reached ${share(10)}`);
    assert.ok(Math.abs(share(50) - 0.50) < 0.01, `50% stage reached ${share(50)}`);
});

test("0% reaches nobody off the whitelist, 100% reaches everybody", () => {
    assert.equal(share(0), 0);
    assert.equal(share(100), 1);
});

test("the same board gets the same answer every time, whatever case its MAC is in", () => {
    for (const mac of macs.slice(0, 500)) {
        const id = release(10).release_id;
        assert.equal(rolloutBucket(id, mac), rolloutBucket(id, mac));
        assert.equal(rolloutBucket(id, mac), rolloutBucket(id, ` ${mac.toLowerCase()} `));
    }
});

test("moving to a later stage only adds boards", () => {
    for (const mac of macs) {
        if (inRollout(release(10), mac)) {
            assert.ok(inRollout(release(50), mac));
        }
        if (inRollout(release(50), mac)) {
            assert.ok(inRollout(release(100), mac));
        }
    }
});

test("whitelisted boards are in at every stage", () => {
    const outside = macs.find((mac) => !inRollout(release(50), mac));
    for (const percent of [0, 10, 50, 100]) {
        assert.ok(inRollout(release(percent, [outside]), outside));
        assert.ok(inRollout(release(percent, [outside]), outside.toLowerCase()));
    }
});

test("each release picks a different first 10%", () => {
    const other = { ...release(10), release_id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" };
    const first = macs.filter((mac) => inRollout(release(10), mac));
    const both = first.filter((mac) => inRollout(other, mac)).length;
    // Independent picks overlap on about 10% of the first group.
    assert.ok(both / first.length < 0.2, `overlap ${both}/${first.length}`);
});

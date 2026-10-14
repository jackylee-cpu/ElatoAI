import crypto from "node:crypto";

/**
 * Which boards a staged release may go to (P2-18).
 *
 * A release is offered to the boards on its whitelist at any stage, and to
 * `rollout_percent` percent of the rest. Each board falls in a bucket from 0 to
 * 99, taken from a hash of the release id and its MAC, and a board is in when
 * its bucket is below the percentage. So:
 *
 *   - the same board gets the same answer on every boot;
 *   - moving a release from 10% to 50% only adds boards, never drops one;
 *   - each release picks a different first 10%, so the same few families are
 *     not always the ones to find a bad build.
 *
 * Pure, and it imports nothing of ours, so `node --test lib/otaRollout.test.mjs`
 * can run it directly.
 */

export type StagedRelease = {
    release_id: string;
    rollout_percent: number;
    rollout_macs: string[];
};

/** 0..99, stable for one board and one release. */
export const rolloutBucket = (releaseId: string, mac: string): number =>
    crypto.createHash("sha256")
        .update(`${releaseId}:${mac.trim().toUpperCase()}`)
        .digest()
        .readUInt32BE(0) % 100;

export const inRollout = (release: StagedRelease, mac: string): boolean => {
    const board = mac.trim().toUpperCase();
    return release.rollout_macs.includes(board)
        || rolloutBucket(release.release_id, board) < release.rollout_percent;
};

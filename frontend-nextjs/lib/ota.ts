import type { SupabaseClient } from "@supabase/supabase-js";
import { inRollout } from "./otaRollout";

/** The token in an `Authorization: Bearer <token>` header, or null. */
export const bearerToken = (req: Request): string | null => {
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    return match ? match[1] : null;
};

// Same shapes as the firmware_releases CHECK constraints.
const BOARD = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
// Same as the firmware_rollout_devices CHECK constraints (20261022120000).
const FAILED_REASONS = ["crash", "crash_loop", "lost_installs"] as const;
const RESET = /^[a-z_]{1,16}$/;

export type FailedReason = (typeof FAILED_REASONS)[number];

export type FirmwareReport = {
    board: string;
    version: string;
    failedVersion: string | null;
    failedReason: FailedReason | null;
    failedReset: string | null;
};

export type OtaAnswer =
    | { update: false }
    | { update: true; version: string; url: string; sha256: string; size: number };

/**
 * What a board says it runs, as it sends it with its token request:
 *
 *   "firmware": { "board": "spotpear-ai-toy", "version": "1.2.0", "failed_version": "1.3.0",
 *                 "failed_reason": "lost_installs", "failed_reset": "poweron" }
 *
 * `failed_version` only follows a rollback from that image. Null for anything
 * malformed or missing -- older firmware sends nothing.
 *
 * `failed_reason` says why (firmware-arduino/src/OTA.cpp): a crash on
 * probation, a crash loop after it, or installs lost to resets that were not
 * crashes -- a flat battery, as a rule. `failed_reset` is the reset that
 * decided it. Firmware before 2026-10-22 sends neither, and a reason that does
 * not parse is dropped rather than the report: the rollback still counts.
 */
export const parseFirmwareReport = (value: unknown): FirmwareReport | null => {
    if (!value || typeof value !== "object") {
        return null;
    }
    const {
        board,
        version,
        failed_version: failed,
        failed_reason: reason,
        failed_reset: reset,
    } = value as Record<string, unknown>;
    if (typeof board !== "string" || !BOARD.test(board) ||
        typeof version !== "string" || !VERSION.test(version) ||
        (failed != null && (typeof failed !== "string" || !VERSION.test(failed)))) {
        return null;
    }
    const failedVersion = (failed as string | undefined) ?? null;
    return {
        board,
        version,
        failedVersion,
        failedReason: failedVersion && FAILED_REASONS.includes(reason as FailedReason)
            ? reason as FailedReason
            : null,
        failedReset: failedVersion && typeof reset === "string" && RESET.test(reset) ? reset : null,
    };
};

/**
 * Record what the board reported, and say whether it should install the
 * current release for its board.
 *
 * It should not when there is no current release, it already runs it, it
 * rolled back from that very version once (otherwise it would download, roll
 * back and download again on every boot), the release is paused, or the
 * release has not reached this board yet (lib/otaRollout.ts).
 *
 * The report goes on the devices row and against the releases this board was
 * offered (firmware_rollout_devices); every offer is counted there too. An
 * offer that cannot be counted is not made: the counts are what a staged
 * rollout is judged on.
 */
export const recordReportAndDecide = async (
    supabase: SupabaseClient,
    deviceId: string,
    report: FirmwareReport,
): Promise<OtaAnswer> => {
    const now = new Date().toISOString();
    const update: Record<string, unknown> = {
        firmware_board: report.board,
        firmware_version: report.version,
        firmware_reported_at: now,
        // A board that reported has been told whatever there is to tell it,
        // so the manual "update now" flag has done its job.
        is_ota: false,
    };
    if (report.failedVersion) {
        update.ota_failed_version = report.failedVersion;
        update.ota_failed_at = now;
    }
    const { data: row, error: reportError } = await supabase
        .from("devices")
        .update(update)
        .eq("device_id", deviceId)
        .select("mac_address, ota_failed_version")
        .maybeSingle();
    if (reportError) {
        throw new Error(reportError.message);
    }

    const { error: noteError } = await supabase.rpc("ota_note_report", {
        p_device_id: deviceId,
        p_board: report.board,
        p_version: report.version,
        p_failed_version: report.failedVersion,
        // Only when there is one: a database without 20261022120000 has the
        // four-parameter function, and boards that send no reason keep working.
        ...(report.failedReason ? { p_failed_reason: report.failedReason } : {}),
        ...(report.failedReset ? { p_failed_reset: report.failedReset } : {}),
    });
    if (noteError) {
        throw new Error(noteError.message);
    }

    const { data: release, error } = await supabase
        .from("firmware_releases")
        .select("release_id, version, sha256, size_bytes, rollout_percent, rollout_macs, paused_at")
        .eq("board", report.board)
        .eq("is_current", true)
        .maybeSingle();
    if (error) {
        throw new Error(error.message);
    }
    if (!release || !row
        || release.version === report.version
        || release.version === row.ota_failed_version
        || release.paused_at
        || !inRollout(release, row.mac_address)) {
        return { update: false };
    }

    const { error: offerError } = await supabase.rpc("ota_note_offer", {
        p_release_id: release.release_id,
        p_device_id: deviceId,
    });
    if (offerError) {
        throw new Error(offerError.message);
    }
    return {
        update: true,
        version: release.version,
        url: `/api/ota/firmware/${release.release_id}`,
        sha256: release.sha256,
        size: release.size_bytes,
    };
};

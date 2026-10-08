import type { SupabaseClient } from "@supabase/supabase-js";

/** The token in an `Authorization: Bearer <token>` header, or null. */
export const bearerToken = (req: Request): string | null => {
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    return match ? match[1] : null;
};

// Same shapes as the firmware_releases CHECK constraints.
const BOARD = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;

export type FirmwareReport = { board: string; version: string; failedVersion: string | null };

export type OtaAnswer =
    | { update: false }
    | { update: true; version: string; url: string; sha256: string; size: number };

/**
 * What a board says it runs, as it sends it with its token request:
 *
 *   "firmware": { "board": "spotpear-ai-toy", "version": "1.2.0", "failed_version": "1.3.0" }
 *
 * `failed_version` only follows a rollback from that image. Null for anything
 * malformed or missing -- older firmware sends nothing.
 */
export const parseFirmwareReport = (value: unknown): FirmwareReport | null => {
    if (!value || typeof value !== "object") {
        return null;
    }
    const { board, version, failed_version: failed } = value as Record<string, unknown>;
    if (typeof board !== "string" || !BOARD.test(board) ||
        typeof version !== "string" || !VERSION.test(version) ||
        (failed != null && (typeof failed !== "string" || !VERSION.test(failed)))) {
        return null;
    }
    return { board, version, failedVersion: (failed as string | undefined) ?? null };
};

/**
 * Record what the board reported on its devices row, and say whether it should
 * install the current release for its board.
 *
 * It should not when there is no current release, it already runs it, or it
 * rolled back from that very version once -- otherwise it would download,
 * roll back and download again on every boot.
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
        .select("ota_failed_version")
        .maybeSingle();
    if (reportError) {
        throw new Error(reportError.message);
    }

    const { data: release, error } = await supabase
        .from("firmware_releases")
        .select("release_id, version, sha256, size_bytes")
        .eq("board", report.board)
        .eq("is_current", true)
        .maybeSingle();
    if (error) {
        throw new Error(error.message);
    }
    if (!release || release.version === report.version || release.version === row?.ota_failed_version) {
        return { update: false };
    }
    return {
        update: true,
        version: release.version,
        url: `/api/ota/firmware/${release.release_id}`,
        sha256: release.sha256,
        size: release.size_bytes,
    };
};

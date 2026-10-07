import { NextResponse } from "next/server";
import { createServiceClient } from "@/utils/supabase/service";
import { verifyDeviceToken } from "@/lib/deviceAuth";
import { bearerToken } from "@/lib/ota";

// Same shapes as the firmware_releases CHECK constraints.
const BOARD = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;

/**
 * Asked by every board on every boot (firmware-arduino/src/OTA.cpp), with its
 * device token in the Authorization header:
 *
 *   { "board": "spotpear-ai-toy", "version": "1.2.0", "failed_version": "1.3.0" }
 *
 * `failed_version` is only sent after the board rolled back from that image.
 * The answer is either { "update": false } or the release to install:
 *
 *   { "update": true, "version": "1.3.1", "url": "/api/ota/firmware/<id>",
 *     "sha256": "<hex>", "size": 1634512 }
 *
 * What the board reports is recorded on its devices row either way -- this is
 * where the fleet's firmware versions come from.
 */
export async function POST(req: Request) {
    const device = verifyDeviceToken(bearerToken(req));
    if (!device) {
        return NextResponse.json({ error: "Invalid or expired device token" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const board = body?.board;
    const version = body?.version;
    const failed = body?.failed_version;
    if (typeof board !== "string" || !BOARD.test(board) ||
        typeof version !== "string" || !VERSION.test(version) ||
        (failed != null && (typeof failed !== "string" || !VERSION.test(failed)))) {
        return NextResponse.json({ error: "board and version are required" }, { status: 400 });
    }

    const supabase = createServiceClient();
    const now = new Date().toISOString();
    const report: Record<string, unknown> = {
        firmware_board: board,
        firmware_version: version,
        firmware_reported_at: now,
        // A board that asked has been told whatever there is to tell it, so
        // the manual "update now" flag has done its job.
        is_ota: false,
    };
    if (failed) {
        report.ota_failed_version = failed;
        report.ota_failed_at = now;
    }
    const { data: row, error: reportError } = await supabase
        .from("devices")
        .update(report)
        .eq("device_id", device.deviceId)
        .select("ota_failed_version")
        .maybeSingle();
    if (reportError) {
        console.error("ota/check could not record the report", reportError);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    const { data: release, error } = await supabase
        .from("firmware_releases")
        .select("release_id, version, sha256, size_bytes")
        .eq("board", board)
        .eq("is_current", true)
        .maybeSingle();
    if (error) {
        console.error("ota/check could not read releases", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    // Nothing current, already on it, or this board already rolled back from
    // it once: stay put.
    if (!release || release.version === version || release.version === row?.ota_failed_version) {
        return NextResponse.json({ update: false });
    }

    return NextResponse.json({
        update: true,
        version: release.version,
        url: `/api/ota/firmware/${release.release_id}`,
        sha256: release.sha256,
        size: release.size_bytes,
    });
}

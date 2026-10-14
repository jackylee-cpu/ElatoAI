import { NextResponse } from "next/server";
import { createServiceClient } from "@/utils/supabase/service";
import { verifyDeviceToken } from "@/lib/deviceAuth";
import { bearerToken } from "@/lib/ota";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The firmware image for a release, to a board with a live device token.
 *
 * Served from here rather than as a storage URL: the bucket stays private,
 * the board talks to one host with one CA bundle, and its token travels in a
 * header instead of a query string. Only the current release of a board is
 * served -- an old image is not something a board should be talked into --
 * and not while it is paused, so a board offered it just before the pause
 * stays where it is.
 */
export async function GET(req: Request, { params }: { params: Promise<{ releaseId: string }> }) {
    if (!verifyDeviceToken(bearerToken(req))) {
        return NextResponse.json({ error: "Invalid or expired device token" }, { status: 401 });
    }

    const { releaseId } = await params;
    if (!UUID.test(releaseId)) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const supabase = createServiceClient();
    const { data: release } = await supabase
        .from("firmware_releases")
        .select("storage_path, size_bytes")
        .eq("release_id", releaseId)
        .eq("is_current", true)
        .is("paused_at", null)
        .maybeSingle();
    if (!release) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { data: image, error } = await supabase.storage.from("firmware").download(release.storage_path);
    if (error || !image) {
        console.error("ota/firmware could not read the image", release.storage_path, error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
    if (image.size !== release.size_bytes) {
        // A half-uploaded or replaced object. The board checks the hash too,
        // but there is no point sending it 1.6MB it will throw away.
        console.error("ota/firmware size mismatch", release.storage_path, image.size, release.size_bytes);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    return new Response(image.stream(), {
        headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(image.size),
            "Cache-Control": "no-store",
        },
    });
}

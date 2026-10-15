import { NextResponse } from "next/server";
import { adminSessionOrNull } from "@/lib/admin";
import { checkFirmwareImage, FirmwareImageError } from "@/lib/firmwareImage";
import { createServiceClient } from "@/utils/supabase/service";

const BUCKET = "firmware";
// Twice the largest app slot (4MB): anything bigger is not an image for us,
// and is turned away before it is read into memory.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Publish a firmware build from the admin console (P2-20): POST multipart
 * { file, notes? }, super admins only.
 *
 * The board and version come from the image itself, and it is refused unless
 * it is a release build that fits its board (lib/firmwareImage.ts). The image
 * goes to the private `firmware` bucket -- only the service role can write
 * there -- and the release is recorded with the admin's own key, so the audit
 * log names them. It starts as a draft: no board is offered it until it is made
 * current, and then only the whitelist.
 *
 *   201  { release_id, board, version, size, sha256, warning }
 *   403  not a super admin
 *   409  that board and version is already published
 *   413  too big to be an image
 *   422  not a usable image; `error` says why
 */
export async function POST(req: Request) {
    const session = await adminSessionOrNull("super_admin");
    if (!session) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_UPLOAD_BYTES + 64 * 1024) {
        return NextResponse.json({ error: "That file is too big to be a firmware image." }, { status: 413 });
    }
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
        return NextResponse.json({ error: "Choose a firmware.bin to upload." }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json({ error: "That file is too big to be a firmware image." }, { status: 413 });
    }
    const notes = typeof form?.get("notes") === "string" ? (form.get("notes") as string).slice(0, 2000) : "";

    let image;
    const bytes = Buffer.from(await file.arrayBuffer());
    try {
        image = checkFirmwareImage(bytes);
    } catch (error) {
        if (error instanceof FirmwareImageError) {
            return NextResponse.json({ error: error.message }, { status: 422 });
        }
        throw error;
    }

    const { data: existing, error: readError } = await session.supabase
        .from("firmware_releases")
        .select("release_id")
        .eq("board", image.board)
        .eq("version", image.version)
        .maybeSingle();
    if (readError) {
        console.error("admin/firmware: could not read releases", readError);
        return NextResponse.json({ error: "Could not check existing releases." }, { status: 500 });
    }
    if (existing) {
        return NextResponse.json(
            { error: `${image.board} ${image.version} is already published. Bump FIRMWARE_VERSION and rebuild.` },
            { status: 409 },
        );
    }

    // Never overwrites: a leftover object at this path is left alone.
    const path = `${image.board}/${image.version}.bin`;
    const storage = createServiceClient().storage.from(BUCKET);
    const { error: uploadError } = await storage.upload(path, bytes, {
        contentType: "application/octet-stream",
        upsert: false,
    });
    if (uploadError) {
        console.error("admin/firmware: upload failed", path, uploadError);
        return NextResponse.json({ error: `Could not store the image at ${path}.` }, { status: 500 });
    }

    const { data: releaseId, error: createError } = await session.supabase.rpc("admin_create_firmware_release", {
        p_board: image.board,
        p_version: image.version,
        p_storage_path: path,
        p_sha256: image.sha256,
        p_size_bytes: image.size,
        p_notes: notes,
    });
    if (createError) {
        // The object above is ours: the upload refuses to overwrite.
        await storage.remove([path]);
        if (createError.code === "23505") {
            return NextResponse.json({ error: `${image.board} ${image.version} is already published.` }, { status: 409 });
        }
        console.error("admin/firmware: could not record the release", createError);
        return NextResponse.json({ error: "Could not record the release." }, { status: 500 });
    }

    return NextResponse.json(
        {
            release_id: releaseId,
            board: image.board,
            version: image.version,
            size: image.size,
            sha256: image.sha256,
            warning: image.warning,
        },
        { status: 201 },
    );
}

/**
 * Delete a draft: DELETE ?release_id=<uuid>, super admins only. A release that
 * has ever been current stays, with its image (409).
 */
export async function DELETE(req: Request) {
    const session = await adminSessionOrNull("super_admin");
    if (!session) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const releaseId = new URL(req.url).searchParams.get("release_id") ?? "";
    if (!UUID.test(releaseId)) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { data: path, error } = await session.supabase.rpc("admin_delete_firmware_release", {
        p_release_id: releaseId,
    });
    if (error) {
        const status = error.code === "55000" ? 409 : error.code === "P0002" ? 404 : error.code === "42501" ? 403 : 500;
        if (status === 500) {
            console.error("admin/firmware: delete failed", releaseId, error);
        }
        return NextResponse.json({ error: status === 500 ? "Could not delete the release." : error.message }, { status });
    }

    const { error: removeError } = await createServiceClient().storage.from(BUCKET).remove([path as string]);
    if (removeError) {
        // The release is gone either way; a stray object only takes space.
        console.error("admin/firmware: release deleted but its image was not", path, removeError);
    }
    return NextResponse.json({ deleted: releaseId });
}

-- Firmware releases from the admin console instead of the Mac (P2-20, part of
-- P2-16).
--
-- POST /api/admin/firmware checks the image (frontend-nextjs/lib/firmwareImage.ts),
-- puts it in the private `firmware` bucket with the service role -- nobody else
-- can write there -- and then records it with admin_create_firmware_release(),
-- run with the super admin's own key. That is what puts their name on the audit
-- record (audit_admin_change on firmware_releases, 20261014190000); a service
-- role insert would have none.
--
-- A new release is a draft: not current, and at the whitelist stage
-- (rollout_percent 0), so making it current offers it to the whitelist only.
-- Nothing is offered to any board until then. A draft can be deleted; a
-- release that has ever been current cannot, since boards may run it and its
-- results are the rollout's record.
--
-- tools/release_firmware.py keeps working as before, with the service role.
--
-- Re-runnable: CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION public.admin_create_firmware_release(
    p_board        text,
    p_version      text,
    p_storage_path text,
    p_sha256       text,
    p_size_bytes   integer,
    p_notes        text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    new_id uuid;
BEGIN
    IF NOT public.has_role('super_admin') THEN
        RAISE EXCEPTION 'only a super admin can publish firmware'
            USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.firmware_releases AS f
                WHERE f.board = p_board AND f.version = p_version) THEN
        -- A board that rolled back from a version is never offered it again,
        -- so a re-used number would silently skip those boards.
        RAISE EXCEPTION '% % is already published', p_board, p_version
            USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.firmware_releases
        (board, version, storage_path, sha256, size_bytes, notes, is_current, rollout_percent)
    VALUES
        (p_board, p_version, p_storage_path, p_sha256, p_size_bytes,
         nullif(btrim(p_notes), ''), false, 0)
    RETURNING release_id INTO new_id;
    RETURN new_id;
END;
$$;

-- Returns the storage path, for the caller to remove the image.
CREATE OR REPLACE FUNCTION public.admin_delete_firmware_release(p_release_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    path text;
BEGIN
    IF NOT public.has_role('super_admin') THEN
        RAISE EXCEPTION 'only a super admin can delete firmware'
            USING ERRCODE = '42501';
    END IF;

    DELETE FROM public.firmware_releases AS f
     WHERE f.release_id = p_release_id
       AND NOT f.is_current
       AND f.stage_changed_at IS NULL
    RETURNING f.storage_path INTO path;
    IF path IS NULL THEN
        IF EXISTS (SELECT 1 FROM public.firmware_releases AS f WHERE f.release_id = p_release_id) THEN
            RAISE EXCEPTION 'release % has been rolled out; only a draft can be deleted', p_release_id
                USING ERRCODE = '55000';
        END IF;
        RAISE EXCEPTION 'no release %', p_release_id
            USING ERRCODE = 'P0002';
    END IF;
    RETURN path;
END;
$$;

-- Supabase grants EXECUTE on new functions in `public` to anon by default.
REVOKE ALL ON FUNCTION public.admin_create_firmware_release(text, text, text, text, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_delete_firmware_release(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_firmware_release(text, text, text, text, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_firmware_release(uuid) TO authenticated;

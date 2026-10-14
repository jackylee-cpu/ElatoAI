-- Pause a staged rollout on its own when too many boards roll back from it
-- (P2-19, part of P2-16).
--
-- A release is paused, and offered to nobody, once more than 5% of the boards
-- it was offered to have reported it as failed. In a small stage that is the
-- first rollback: 1 of 2 whitelisted boards is 50%.
--
-- A rollback is the only per-board failure counted, because it is the only one
-- the board itself confirms. The firmware turns every way of losing a new image
-- into one (firmware-arduino/src/OTA.cpp): a crash or watchdog on probation
-- fails it at once, and after OTA_MAX_TRIES (2) installs lost to resets it fails
-- it too. Nothing the server sees on its own is a usable signal: a board is
-- offered the release on every boot until it takes it, so a flaky connection
-- looks like a bad build, and the image passes through nginx and Cloudflare,
-- which take the whole of it from us whether or not the board gets it all.
--
-- The rule is checked when a rollback is reported, not on every boot. So once a
-- super admin resumes a paused release, it stays resumed until another board
-- fails it.
--
-- A pause by the server leaves paused_by NULL and starts its reason with
-- "Auto-paused". Its audit record (audit_admin_change, 20261014190000) has no
-- actor, like any other service-role write. Boards already running the release
-- keep it.
--
-- Re-runnable: CREATE OR REPLACE.

-- Check one release, and pause it if too many of its boards rolled back.
-- Returns whether this call paused it.
CREATE OR REPLACE FUNCTION public.ota_maybe_pause(p_release_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    offered integer;
    failed  integer;
BEGIN
    -- Lock the release, so two boards reporting at once pause it only once.
    PERFORM 1
       FROM public.firmware_releases AS f
      WHERE f.release_id = p_release_id
        AND f.is_current
        AND f.paused_at IS NULL
        FOR UPDATE;
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    SELECT count(*), count(*) FILTER (WHERE r.failed_at IS NOT NULL)
      INTO offered, failed
      FROM public.firmware_rollout_devices AS r
     WHERE r.release_id = p_release_id;

    IF failed * 100 <= offered * 5 THEN
        RETURN false;
    END IF;

    UPDATE public.firmware_releases
       SET paused_at = now(),
           paused_reason = format('Auto-paused: %s of %s boards rolled back (%s%%)',
                                  failed, offered, round(failed * 100.0 / offered)),
           paused_by = NULL
     WHERE release_id = p_release_id;
    RETURN true;
END;
$$;

-- As in 20261014190000, plus: a newly reported rollback checks that release.
-- (plpgsql now, to act on the rows it changed; same signature and result.)
CREATE OR REPLACE FUNCTION public.ota_note_report(
    p_device_id      uuid,
    p_board          text,
    p_version        text,
    p_failed_version text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    newly_failed uuid;
BEGIN
    FOR newly_failed IN
        UPDATE public.firmware_rollout_devices AS r
           SET running_at = coalesce(r.running_at, CASE WHEN f.version = p_version THEN now() END),
               failed_at  = coalesce(r.failed_at,  CASE WHEN f.version = p_failed_version THEN now() END)
          FROM public.firmware_releases AS f
         WHERE r.release_id = f.release_id
           AND r.device_id = p_device_id
           AND f.board = p_board
           AND f.version IN (p_version, p_failed_version)
           AND ((f.version = p_version AND r.running_at IS NULL)
             OR (f.version = p_failed_version AND r.failed_at IS NULL))
        RETURNING CASE WHEN f.version = p_failed_version THEN r.release_id END
    LOOP
        IF newly_failed IS NOT NULL THEN
            PERFORM public.ota_maybe_pause(newly_failed);
        END IF;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.ota_maybe_pause(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ota_note_report(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ota_maybe_pause(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ota_note_report(uuid, text, text, text) TO service_role;

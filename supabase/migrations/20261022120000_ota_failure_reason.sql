-- Why a board rolled back, and auto-pause counting only the rollbacks that
-- point at the build.
--
-- On 2026-10-16 prod's 1.1.0 auto-paused at the whitelist stage because its one
-- board (AIBuddy-16C0) reported it as failed. The board's flash showed why: its
-- cell was dying, and both installs were lost to power-on resets within a
-- minute, so 1.0.1 hit OTA_MAX_TRIES and reported the release failed, as
-- designed. 1.1.0 itself runs fine. One flat toy should not pause a release.
--
-- Firmware from this change on says why along with failed_version
-- (firmware-arduino/src/OTA.cpp), and the token route passes it here:
--
--   failed_reason  crash          a panic or watchdog while on probation
--                  crash_loop     a confirmed image crashed OTA_CRASH_LOOP
--                                 times in a row and gave way to the other slot
--                  lost_installs  OTA_MAX_TRIES installs lost to resets that
--                                 were not crashes: power-on, brownout, an
--                                 external reset -- in practice a battery
--                  NULL           not reported: firmware before this change
--                                 (1.0.1, 1.1.0), so it could be either
--   failed_reset   the reset that decided it, as the firmware spells it
--                  (poweron, brownout, panic, task_wdt, ...).
--
-- ota_maybe_pause (20261014200000) now leaves lost_installs out of the count. A
-- rollback with no reason still counts: the boards in the field today send
-- none, and a crash must still stop a rollout. The admin OTA page lists the
-- power losses apart.
--
-- Re-runnable: IF NOT EXISTS, DROP ... IF EXISTS, CREATE OR REPLACE.

ALTER TABLE public.firmware_rollout_devices
    ADD COLUMN IF NOT EXISTS failed_reason text,
    ADD COLUMN IF NOT EXISTS failed_reset  text;

ALTER TABLE public.firmware_rollout_devices
    DROP CONSTRAINT IF EXISTS firmware_rollout_devices_failed_reason_check,
    DROP CONSTRAINT IF EXISTS firmware_rollout_devices_failed_reset_check;

ALTER TABLE public.firmware_rollout_devices
    ADD CONSTRAINT firmware_rollout_devices_failed_reason_check
        CHECK (failed_reason IS NULL
               OR (failed_reason IN ('crash', 'crash_loop', 'lost_installs') AND failed_at IS NOT NULL)),
    -- Same shape lib/ota.ts accepts.
    ADD CONSTRAINT firmware_rollout_devices_failed_reset_check
        CHECK (failed_reset IS NULL
               OR (failed_reset ~ '^[a-z_]{1,16}$' AND failed_at IS NOT NULL));

-- As in 20261014200000, but a board that lost its installs to power does not
-- count towards the 5%.
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

    SELECT count(*),
           count(*) FILTER (WHERE r.failed_at IS NOT NULL
                              AND r.failed_reason IS DISTINCT FROM 'lost_installs')
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

-- As in 20261014200000, plus the reason. The two new parameters default to
-- NULL, so the web app from before this change, which names only the first
-- four, keeps working once this is applied; the old signature is dropped so
-- that a call by those four names has one function to resolve to.
DROP FUNCTION IF EXISTS public.ota_note_report(uuid, text, text, text);

CREATE OR REPLACE FUNCTION public.ota_note_report(
    p_device_id      uuid,
    p_board          text,
    p_version        text,
    p_failed_version text,
    p_failed_reason  text DEFAULT NULL,
    p_failed_reset   text DEFAULT NULL
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
           SET running_at    = coalesce(r.running_at, CASE WHEN f.version = p_version THEN now() END),
               failed_at     = coalesce(r.failed_at,  CASE WHEN f.version = p_failed_version THEN now() END),
               failed_reason = CASE WHEN f.version = p_failed_version AND r.failed_at IS NULL
                                    THEN p_failed_reason ELSE r.failed_reason END,
               failed_reset  = CASE WHEN f.version = p_failed_version AND r.failed_at IS NULL
                                    THEN p_failed_reset ELSE r.failed_reset END
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
REVOKE ALL ON FUNCTION public.ota_note_report(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ota_maybe_pause(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ota_note_report(uuid, text, text, text, text, text) TO service_role;

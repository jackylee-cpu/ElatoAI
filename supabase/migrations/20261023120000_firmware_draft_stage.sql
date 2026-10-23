-- A draft's stage is only where it will start, so choosing it must not stamp
-- stage_changed_at.
--
-- The stamp trigger (20261014190000) set stage_changed_at on any
-- rollout_percent change, current or not. The admin OTA page reads "not
-- current, stamped" as an old release, and admin_delete_firmware_release()
-- only deletes unstamped drafts. So a draft whose starting stage was picked
-- before "Make current" showed as Old, looked rolled out, and could no longer
-- be deleted, although no board had been offered it (2026-10-23, 1.1.1).
--
-- Now a stage change stamps only a current release; promotion still stamps.
-- Drafts stamped by the old trigger are cleared when the audit log holds
-- their whole history and it shows they were never current, no board was
-- offered them and none runs them. Re-runnable.

CREATE OR REPLACE FUNCTION public.firmware_releases_stamp_stage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.is_current THEN
            NEW.stage_changed_at := now();
        END IF;
    ELSIF (NEW.is_current AND NOT OLD.is_current)
       OR (NEW.is_current AND NEW.rollout_percent IS DISTINCT FROM OLD.rollout_percent) THEN
        NEW.stage_changed_at := now();
    END IF;
    RETURN NEW;
END;
$$;

UPDATE public.firmware_releases AS f
   SET stage_changed_at = NULL
 WHERE NOT f.is_current
   AND f.stage_changed_at IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.admin_audit_log AS a
                WHERE a.target_table = 'firmware_releases'
                  AND a.target_id = f.release_id::text
                  AND a.action = 'insert')
   AND NOT EXISTS (SELECT 1 FROM public.admin_audit_log AS a
                    WHERE a.target_table = 'firmware_releases'
                      AND a.target_id = f.release_id::text
                      AND (a.after ->> 'is_current')::boolean)
   AND NOT EXISTS (SELECT 1 FROM public.firmware_rollout_devices AS r
                    WHERE r.release_id = f.release_id)
   AND NOT EXISTS (SELECT 1 FROM public.devices AS d
                    WHERE d.firmware_board = f.board AND d.firmware_version = f.version);

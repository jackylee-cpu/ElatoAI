-- Running a staged rollout from the admin console (P2-21, part of P2-16).
--
-- The OTA page reads firmware_releases and firmware_rollout_devices through
-- their super admin SELECT policies (20261008100000, 20261014190000), and the
-- boards' MACs through admin_list_devices() (20261014140000). Every change
-- goes through admin_change_firmware_rollout(), run with the super admin's own
-- key, so audit_admin_change on firmware_releases names them:
--
--   current    make this release the one its board installs; the board's
--              previous current release stops being offered. It starts at the
--              stage it already has -- the whitelist, for an uploaded draft.
--   stage      set rollout_percent: 0 (whitelist only), 10, 50 or 100. Moving
--              back narrows who is offered it; boards that took it keep it.
--   whitelist  replace rollout_macs.
--   pause      stop offering it, with a reason (the release must be current).
--   resume     offer it again (P2-19 only pauses again on a new rollback).
--   withdraw   stop it being current. Boards that took it keep it; no board of
--              that kind is offered anything until another release is made
--              current.
--
-- tools/release_firmware.py promote still works, with the service role.
--
-- Re-runnable: CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION public.admin_change_firmware_rollout(
    p_release_id uuid,
    p_action     text,
    p_percent    smallint DEFAULT NULL,
    p_macs       text[] DEFAULT NULL,
    p_reason     text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    rel public.firmware_releases;
BEGIN
    IF NOT public.has_role('super_admin') THEN
        RAISE EXCEPTION 'only a super admin can change a rollout'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO rel
      FROM public.firmware_releases AS f
     WHERE f.release_id = p_release_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no release %', p_release_id
            USING ERRCODE = 'P0002';
    END IF;

    CASE p_action
    WHEN 'current' THEN
        IF rel.is_current THEN
            RETURN;
        END IF;
        -- One current release per board (a partial unique index): clear first.
        UPDATE public.firmware_releases
           SET is_current = false
         WHERE board = rel.board AND is_current;
        UPDATE public.firmware_releases
           SET is_current = true
         WHERE release_id = p_release_id;

    WHEN 'stage' THEN
        IF p_percent IS NULL OR p_percent NOT IN (0, 10, 50, 100) THEN
            RAISE EXCEPTION 'a stage is 0, 10, 50 or 100 percent'
                USING ERRCODE = '22023';
        END IF;
        UPDATE public.firmware_releases
           SET rollout_percent = p_percent
         WHERE release_id = p_release_id;

    WHEN 'whitelist' THEN
        -- Same form as devices.mac_address; the table's CHECK refuses the rest.
        UPDATE public.firmware_releases
           SET rollout_macs = coalesce(
                   (SELECT array_agg(DISTINCT upper(btrim(m)) ORDER BY upper(btrim(m)))
                      FROM unnest(p_macs) AS m
                     WHERE btrim(coalesce(m, '')) <> ''),
                   '{}')
         WHERE release_id = p_release_id;

    WHEN 'pause' THEN
        IF NOT rel.is_current THEN
            RAISE EXCEPTION 'only the current release can be paused'
                USING ERRCODE = '55000';
        END IF;
        IF coalesce(btrim(p_reason), '') = '' THEN
            RAISE EXCEPTION 'a reason is required'
                USING ERRCODE = '22023';
        END IF;
        UPDATE public.firmware_releases
           SET paused_at = now(), paused_reason = btrim(p_reason), paused_by = auth.uid()
         WHERE release_id = p_release_id;

    WHEN 'resume' THEN
        UPDATE public.firmware_releases
           SET paused_at = NULL, paused_reason = NULL, paused_by = NULL
         WHERE release_id = p_release_id;

    WHEN 'withdraw' THEN
        UPDATE public.firmware_releases
           SET is_current = false
         WHERE release_id = p_release_id;

    ELSE
        RAISE EXCEPTION 'unknown rollout change %', p_action
            USING ERRCODE = '22023';
    END CASE;
END;
$$;

-- Supabase grants EXECUTE on new functions in `public` to anon by default.
REVOKE ALL ON FUNCTION public.admin_change_firmware_rollout(uuid, text, smallint, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_change_firmware_rollout(uuid, text, smallint, text[], text) TO authenticated;

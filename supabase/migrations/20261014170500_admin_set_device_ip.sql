-- Set a board's toy IP from the admin Devices page (see 20261014170000).
--
-- Super admin only, with a reason, audited in the same transaction like the
-- other device actions (20261014140000). admin_list_devices() gains the
-- board's ip_key so the page can show it.
--
-- Re-runnable.

-- The Devices page shows and edits the board's IP. The return type changes,
-- which CREATE OR REPLACE cannot do.
DROP FUNCTION IF EXISTS public.admin_list_devices();

CREATE FUNCTION public.admin_list_devices()
RETURNS TABLE (
    device_id            uuid,
    mac_address          text,
    created_at           timestamptz,
    last_seen_at         timestamptz,
    claimed_at           timestamptz,
    owner_id             uuid,
    owner_email          text,
    firmware_board       text,
    firmware_version     text,
    firmware_reported_at timestamptz,
    ota_failed_version   text,
    ota_failed_at        timestamptz,
    key_issued_at        timestamptz,
    ip_key               text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT public.has_role('super_admin') THEN
        RAISE EXCEPTION 'only a super admin can list devices'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT d.device_id,
           d.mac_address,
           d.created_at,
           d.last_seen_at,
           d.claimed_at,
           d.user_id,
           -- auth.users is the login; users.email can be blank on old rows.
           coalesce(au.email::text, nullif(u.email, '')),
           d.firmware_board,
           d.firmware_version,
           d.firmware_reported_at,
           d.ota_failed_version,
           d.ota_failed_at,
           s.issued_at,
           d.ip_key
      FROM public.devices AS d
      LEFT JOIN public.users AS u ON u.user_id = d.user_id
      LEFT JOIN auth.users AS au ON au.id = d.user_id
      LEFT JOIN public.device_secrets AS s ON s.device_id = d.device_id
     ORDER BY d.last_seen_at DESC NULLS LAST, d.created_at DESC;
END;
$$;

-- Returns the MAC, so the web app can drop the board's live session and it
-- reconnects as its new character.
CREATE OR REPLACE FUNCTION public.admin_set_device_ip(
    p_device_id uuid,
    p_ip_key    text,
    p_reason    text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    mac    text;
    before text;
    wanted text := nullif(btrim(p_ip_key), '');
BEGIN
    IF NOT public.has_role('super_admin') THEN
        RAISE EXCEPTION 'only a super admin can set a device''s IP'
            USING ERRCODE = '42501';
    END IF;
    IF coalesce(btrim(p_reason), '') = '' THEN
        RAISE EXCEPTION 'a reason is required'
            USING ERRCODE = '22023';
    END IF;
    IF wanted IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.ips AS i WHERE i.ip_key = wanted) THEN
        RAISE EXCEPTION 'no IP %', wanted
            USING ERRCODE = 'P0002';
    END IF;

    SELECT d.mac_address, d.ip_key INTO mac, before
      FROM public.devices AS d
     WHERE d.device_id = p_device_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no device %', p_device_id
            USING ERRCODE = 'P0002';
    END IF;
    IF before IS NOT DISTINCT FROM wanted THEN
        RETURN mac;
    END IF;

    UPDATE public.devices
       SET ip_key = wanted
     WHERE device_id = p_device_id;

    INSERT INTO public.admin_audit_log
        (actor_id, actor_email, action, target_table, target_id, target_label,
         reason, before, after)
    VALUES
        (auth.uid(), auth.jwt() ->> 'email', 'device.set_ip', 'devices',
         p_device_id::text, public.admin_device_label(mac), btrim(p_reason),
         jsonb_build_object('ip_key', before),
         jsonb_build_object('ip_key', wanted));

    RETURN mac;
END;
$$;

-- Supabase grants EXECUTE on new functions in `public` to anon by default.
REVOKE ALL ON FUNCTION public.admin_list_devices() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_device_ip(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_devices() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_device_ip(uuid, text, text) TO authenticated;

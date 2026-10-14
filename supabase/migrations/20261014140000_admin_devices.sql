-- Admin devices page (P2-14).
--
-- Three functions, all super admin only, all run with the admin's own key:
--
--   admin_list_devices()            every board, with its firmware, last call,
--                                   owner's email and when its key was issued.
--   admin_reset_device_secret(...)  delete a board's device_secrets row, so a
--                                   board whose NVS was wiped can be issued a
--                                   new secret on its next call.
--   admin_unbind_device(...)        release a board from its owner.
--
-- Why functions and not wider RLS: a policy letting super admins read
-- `devices` would also hand them `user_code`, and reading the owner's email
-- would need one on `users`, which holds the child's name, age and persona
-- (Q7). The function returns only the columns the page shows. device_secrets
-- stays service-role only; the page sees when a key was issued, never a hash.
--
-- Both actions need a reason and write their audit record (P1-10) in the same
-- transaction as the change: if the record cannot be written, nothing changes.
-- `devices` itself carries no audit trigger -- the token route updates
-- last_seen_at on every boot -- so the records go in by hand here.
--
-- Unbinding leaves the board's memory where it is. Memory is keyed by
-- (user_id, device_id, ip_key), so it stays with the old owner and the next
-- account to claim the board starts empty (see 20261009140000).
--
-- Re-runnable, including after 20261014170500, which adds a column to
-- admin_list_devices(): CREATE OR REPLACE cannot change a return type, so the
-- function is dropped first. Run 20261014170500 again afterwards.

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
    key_issued_at        timestamptz
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
           s.issued_at
      FROM public.devices AS d
      LEFT JOIN public.users AS u ON u.user_id = d.user_id
      LEFT JOIN auth.users AS au ON au.id = d.user_id
      LEFT JOIN public.device_secrets AS s ON s.device_id = d.device_id
     ORDER BY d.last_seen_at DESC NULLS LAST, d.created_at DESC;
END;
$$;

-- What the audit log calls a board: its hotspot name and MAC.
CREATE OR REPLACE FUNCTION public.admin_device_label(p_mac text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT CASE
        WHEN p_mac IS NULL THEN NULL
        ELSE 'AIBuddy-' || right(replace(upper(p_mac), ':', ''), 4) || ' (' || p_mac || ')'
    END;
$$;

CREATE OR REPLACE FUNCTION public.admin_reset_device_secret(
    p_device_id uuid,
    p_reason    text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    mac    text;
    issued timestamptz;
BEGIN
    IF NOT public.has_role('super_admin') THEN
        RAISE EXCEPTION 'only a super admin can reset a device key'
            USING ERRCODE = '42501';
    END IF;
    IF coalesce(btrim(p_reason), '') = '' THEN
        RAISE EXCEPTION 'a reason is required'
            USING ERRCODE = '22023';
    END IF;

    SELECT d.mac_address INTO mac
      FROM public.devices AS d
     WHERE d.device_id = p_device_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no device %', p_device_id
            USING ERRCODE = 'P0002';
    END IF;

    DELETE FROM public.device_secrets AS s
     WHERE s.device_id = p_device_id
    RETURNING s.issued_at INTO issued;
    IF issued IS NULL THEN
        RAISE EXCEPTION 'device % has no key to reset', p_device_id
            USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO public.admin_audit_log
        (actor_id, actor_email, action, target_table, target_id, target_label,
         reason, before, after)
    VALUES
        (auth.uid(), auth.jwt() ->> 'email', 'device.reset_key', 'devices',
         p_device_id::text, public.admin_device_label(mac), btrim(p_reason),
         jsonb_build_object('key_issued_at', issued),
         jsonb_build_object('key_issued_at', NULL));
END;
$$;

-- Returns the MAC, which the web app needs to drop the board's live session so
-- it reconnects and finds itself unclaimed.
CREATE OR REPLACE FUNCTION public.admin_unbind_device(
    p_device_id uuid,
    p_reason    text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    mac         text;
    owner       uuid;
    owner_email text;
    claimed     timestamptz;
BEGIN
    IF NOT public.has_role('super_admin') THEN
        RAISE EXCEPTION 'only a super admin can unbind a device'
            USING ERRCODE = '42501';
    END IF;
    IF coalesce(btrim(p_reason), '') = '' THEN
        RAISE EXCEPTION 'a reason is required'
            USING ERRCODE = '22023';
    END IF;

    SELECT d.mac_address, d.user_id, d.claimed_at
      INTO mac, owner, claimed
      FROM public.devices AS d
     WHERE d.device_id = p_device_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no device %', p_device_id
            USING ERRCODE = 'P0002';
    END IF;
    IF owner IS NULL THEN
        RAISE EXCEPTION 'device % is not bound', p_device_id
            USING ERRCODE = 'P0002';
    END IF;

    SELECT au.email::text INTO owner_email FROM auth.users AS au WHERE au.id = owner;

    UPDATE public.devices
       SET user_id = NULL, claimed_at = NULL
     WHERE device_id = p_device_id;

    INSERT INTO public.admin_audit_log
        (actor_id, actor_email, action, target_table, target_id, target_label,
         reason, before, after)
    VALUES
        (auth.uid(), auth.jwt() ->> 'email', 'device.unbind', 'devices',
         p_device_id::text, public.admin_device_label(mac), btrim(p_reason),
         jsonb_build_object('user_id', owner, 'owner_email', owner_email, 'claimed_at', claimed),
         jsonb_build_object('user_id', NULL, 'claimed_at', NULL));

    RETURN mac;
END;
$$;

-- Supabase grants EXECUTE on new functions in `public` to anon by default.
REVOKE ALL ON FUNCTION public.admin_list_devices() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_reset_device_secret(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_unbind_device(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_devices() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reset_device_secret(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_unbind_device(uuid, text) TO authenticated;

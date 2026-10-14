-- Delete a login from the Accounts page.
--
-- GoTrue's admin API can delete auth.users, but the family's rows live in
-- public and several of them have no ON DELETE, so a bare auth delete would
-- leave the profile, the toys still bound, and the conversations behind.
-- This does the whole removal in one transaction, with the audit record:
-- if the record cannot be written, nothing is deleted.
--
-- What goes:
--   the login (auth.users; roles, sessions and identities follow)
--   the profile (public.users)
--   that account's conversations, memories and characters it created
--   the binding on its toys (devices.user_id is set null; the board stays)
--
-- What is never selected, so it cannot land in the audit log: anything a
-- child said, their name, or a memory. Other families who talked to a
-- character this account created keep those rows; the character link is
-- cleared first, because conversations.personality_key is ON DELETE CASCADE
-- and would otherwise take their history with the character.
--
-- The signed-in admin cannot delete their own login, and the last super
-- admin cannot be deleted from here. Both would lock the console.
--
-- Returns the MAC of each toy that was bound, so the caller can drop its
-- live voice session after the commit. A toy that is asleep finds out it
-- is unbound the next time it calls.
--
-- Re-runnable.

CREATE OR REPLACE FUNCTION public.admin_delete_account(p_user_id uuid, p_reason text)
RETURNS TABLE (mac_address text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    addr text;
    why  text;
    macs text[];
BEGIN
    IF NOT public.has_role('super_admin') THEN
        RAISE EXCEPTION 'only a super admin can delete an account'
            USING ERRCODE = '42501';
    END IF;

    why := btrim(p_reason);
    IF why IS NULL OR why = '' OR char_length(why) > 500 THEN
        RAISE EXCEPTION 'give a reason, up to 500 characters'
            USING ERRCODE = '22023';
    END IF;

    IF p_user_id = auth.uid() THEN
        RAISE EXCEPTION 'cannot delete your own account'
            USING ERRCODE = '42501';
    END IF;

    SELECT u.email::text INTO addr
      FROM auth.users AS u
     WHERE u.id = p_user_id;
    IF addr IS NULL THEN
        RAISE EXCEPTION 'no such account'
            USING ERRCODE = 'P0002';
    END IF;

    -- Counted before the delete. super_admin implies the console still has
    -- someone who can grant the role back.
    IF EXISTS (
        SELECT 1 FROM public.admin_roles AS r
         WHERE r.user_id = p_user_id AND r.role = 'super_admin'
    ) AND (
        SELECT count(*) FROM public.admin_roles AS r WHERE r.role = 'super_admin'
    ) <= 1 THEN
        RAISE EXCEPTION 'cannot delete the last super admin'
            USING ERRCODE = '42501';
    END IF;

    SELECT coalesce(array_agg(d.mac_address), ARRAY[]::text[])
      INTO macs
      FROM public.devices AS d
     WHERE d.user_id = p_user_id
       AND d.mac_address IS NOT NULL;

    INSERT INTO public.admin_audit_log
        (actor_id, actor_email, action, target_table, target_id, target_label,
         reason, before)
    VALUES (
        auth.uid(),
        auth.jwt() ->> 'email',
        'account.delete',
        'auth.users',
        p_user_id::text,
        addr,
        why,
        jsonb_build_object(
            'email', addr,
            'roles', (
                SELECT coalesce(jsonb_agg(r.role ORDER BY r.role), '[]'::jsonb)
                  FROM public.admin_roles AS r
                 WHERE r.user_id = p_user_id
            )
        )
    );

    -- Keep other families' conversation rows when this account's characters go.
    UPDATE public.conversations AS c
       SET personality_key = NULL
     WHERE c.user_id <> p_user_id
       AND c.personality_key IN (
           SELECT p.key FROM public.personalities AS p WHERE p.creator_id = p_user_id
       );

    DELETE FROM public.conversations AS c WHERE c.user_id = p_user_id;
    -- Cascades memories and characters this account created. Toys unbind
    -- (devices.user_id ON DELETE SET NULL). An account that never signed in
    -- has no public.users row; that delete then changes nothing.
    DELETE FROM public.users AS u WHERE u.user_id = p_user_id;
    DELETE FROM auth.users AS u WHERE u.id = p_user_id;

    RETURN QUERY SELECT t.mac FROM unnest(macs) AS t(mac);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_account(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_account(uuid, text) TO authenticated;

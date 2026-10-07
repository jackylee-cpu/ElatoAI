-- Admin roles in the database, checked by the database.
--
-- Until now "admin" was an email allowlist in the web app (ADMIN_EMAILS), and
-- an unset allowlist made every signed-in account an admin. The admin page then
-- used the service role, so the database never knew who was asking: anyone the
-- web app let through could change the model every session runs on, rewrite
-- characters spoken to every child, and -- through that same key -- read any
-- table at all.
--
-- After this:
--   admin_roles     who holds which role, who granted it and when. Two roles in
--                   v1 (Q9): super_admin and content_admin.
--   has_role(r)     true only for a session that holds role r (super_admin
--                   counts as content_admin too) AND has passed TOTP (aal2).
--                   A stolen password alone is not an admin session.
--   personalities   content admins create and edit built-in characters
--   ips, ip_modes,  (creator_id IS NULL) and IPs. Characters a parent made
--   ip_styles       are not theirs to touch.
--   app_settings    super admins only, read and write.
--   turn_metrics    super admins only, read. Written by the voice server.
--   admin_roles     each account sees its own roles; super admins grant and
--                   revoke through admin_grant_role / admin_revoke_role and
--                   list through admin_list_roles.
--   conversations,  no admin policy at all (Q7). Owner-only, as before, so an
--   memory_*        admin's key reads exactly their own family's rows.
--
-- The web app now runs admin reads and writes with the admin's own key, so
-- every statement above is what actually decides; the checks in the app are a
-- second line, not the only one.
--
-- First super admin: there is nobody yet who could grant the role, so it is
-- inserted by hand on the database host --
--
--   INSERT INTO public.admin_roles (user_id, role)
--   SELECT id, 'super_admin' FROM auth.users WHERE email = 'someone@example.com';
--
-- -- and that account then enrols TOTP at /admin/mfa on first visit.
--
-- Re-runnable: policies are dropped before they are created, functions are
-- CREATE OR REPLACE, REVOKE/GRANT are idempotent.

-- ── admin_roles ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.admin_roles (
    user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role       text NOT NULL CHECK (role IN ('super_admin', 'content_admin')),
    granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    granted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, role)
);

ALTER TABLE public.admin_roles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.admin_roles FROM anon, authenticated;
GRANT ALL ON TABLE public.admin_roles TO service_role;
-- Read only. Granting and revoking go through the functions below, which
-- resolve an email to an account without handing anyone SELECT on auth.users.
GRANT SELECT ON TABLE public.admin_roles TO authenticated;

-- ── has_role ─────────────────────────────────────────────────────────────────
-- SECURITY DEFINER so policies on other tables can consult admin_roles
-- whatever the caller may read of it. The aal claim is set by GoTrue and
-- signed with the JWT, so it cannot be claimed without a verified TOTP code.

CREATE OR REPLACE FUNCTION public.has_role(required_role text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
       AND EXISTS (
           SELECT 1
           FROM public.admin_roles
           WHERE user_id = auth.uid()
             AND (role = required_role OR role = 'super_admin')
       );
$$;

REVOKE ALL ON FUNCTION public.has_role(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(text) TO authenticated, service_role;

DROP POLICY IF EXISTS "Accounts can see their own roles" ON public.admin_roles;
CREATE POLICY "Accounts can see their own roles" ON public.admin_roles
    FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Super admins can see every role" ON public.admin_roles;
CREATE POLICY "Super admins can see every role" ON public.admin_roles
    FOR SELECT TO authenticated
    USING ((SELECT public.has_role('super_admin')));

-- ── managing roles ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_list_roles()
RETURNS TABLE (
    user_id          uuid,
    email            text,
    role             text,
    granted_by_email text,
    granted_at       timestamptz,
    has_totp         boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT public.has_role('super_admin') THEN
        RAISE EXCEPTION 'super admin only' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT r.user_id,
           u.email::text,
           r.role,
           g.email::text,
           r.granted_at,
           EXISTS (
               SELECT 1 FROM auth.mfa_factors f
               WHERE f.user_id = r.user_id
                 AND f.factor_type = 'totp'
                 AND f.status = 'verified'
           )
    FROM public.admin_roles r
    JOIN auth.users u ON u.id = r.user_id
    LEFT JOIN auth.users g ON g.id = r.granted_by
    ORDER BY u.email, r.role;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_grant_role(target_email text, new_role text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    target uuid;
BEGIN
    IF NOT public.has_role('super_admin') THEN
        RAISE EXCEPTION 'super admin only' USING ERRCODE = '42501';
    END IF;

    SELECT id INTO target
    FROM auth.users
    WHERE lower(email) = lower(trim(target_email));

    IF target IS NULL THEN
        RAISE EXCEPTION 'no account with that email' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO public.admin_roles (user_id, role, granted_by)
    VALUES (target, new_role, auth.uid())
    ON CONFLICT (user_id, role) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_revoke_role(target_user uuid, old_role text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT public.has_role('super_admin') THEN
        RAISE EXCEPTION 'super admin only' USING ERRCODE = '42501';
    END IF;

    -- Nobody can take away their own super_admin, so the last one standing
    -- cannot lock everyone out from the web page. The database host still can.
    IF target_user = auth.uid() AND old_role = 'super_admin' THEN
        RAISE EXCEPTION 'cannot revoke your own super admin role' USING ERRCODE = '42501';
    END IF;

    DELETE FROM public.admin_roles
    WHERE user_id = target_user AND role = old_role;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_roles() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_grant_role(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_revoke_role(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_roles() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_grant_role(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revoke_role(uuid, text) TO authenticated;

-- ── personalities ────────────────────────────────────────────────────────────
-- 20261007140000 left browsers read-only here. Content admins get INSERT and
-- UPDATE back, for built-in rows only. No DELETE: users.personality_id is
-- ON DELETE SET DEFAULT, so retiring is is_hidden, not a delete.

DROP POLICY IF EXISTS "only insert if you're auth'd" ON public.personalities;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.personalities FROM anon, authenticated;
GRANT INSERT, UPDATE ON TABLE public.personalities TO authenticated;

DROP POLICY IF EXISTS "Content admins can add built-in characters" ON public.personalities;
CREATE POLICY "Content admins can add built-in characters" ON public.personalities
    FOR INSERT TO authenticated
    WITH CHECK ((SELECT public.has_role('content_admin')) AND creator_id IS NULL);

DROP POLICY IF EXISTS "Content admins can edit built-in characters" ON public.personalities;
CREATE POLICY "Content admins can edit built-in characters" ON public.personalities
    FOR UPDATE TO authenticated
    USING ((SELECT public.has_role('content_admin')) AND creator_id IS NULL)
    WITH CHECK ((SELECT public.has_role('content_admin')) AND creator_id IS NULL);

-- ── ips, ip_modes, ip_styles ─────────────────────────────────────────────────
-- Saving an IP rewrites its ip_modes / ip_styles rows whole, hence DELETE.

REVOKE ALL ON TABLE public.ips, public.ip_modes, public.ip_styles FROM anon, authenticated;
GRANT SELECT ON TABLE public.ips, public.ip_modes, public.ip_styles TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ips, public.ip_modes, public.ip_styles
    TO authenticated;

DROP POLICY IF EXISTS "Content admins can write IPs" ON public.ips;
CREATE POLICY "Content admins can write IPs" ON public.ips
    FOR ALL TO authenticated
    USING ((SELECT public.has_role('content_admin')))
    WITH CHECK ((SELECT public.has_role('content_admin')));

DROP POLICY IF EXISTS "Content admins can write IP modes" ON public.ip_modes;
CREATE POLICY "Content admins can write IP modes" ON public.ip_modes
    FOR ALL TO authenticated
    USING ((SELECT public.has_role('content_admin')))
    WITH CHECK ((SELECT public.has_role('content_admin')));

DROP POLICY IF EXISTS "Content admins can write IP styles" ON public.ip_styles;
CREATE POLICY "Content admins can write IP styles" ON public.ip_styles
    FOR ALL TO authenticated
    USING ((SELECT public.has_role('content_admin')))
    WITH CHECK ((SELECT public.has_role('content_admin')));

-- modes and styles are seeded by migrations and have no editor.
REVOKE ALL ON TABLE public.modes, public.styles FROM anon, authenticated;
GRANT SELECT ON TABLE public.modes, public.styles TO anon, authenticated;

-- ── app_settings ─────────────────────────────────────────────────────────────
-- The voice server reads it as service_role; nothing else needs to.

REVOKE ALL ON TABLE public.app_settings FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.app_settings TO authenticated;

DROP POLICY IF EXISTS "Signed-in users can read app settings" ON public.app_settings;
DROP POLICY IF EXISTS "Super admins can manage app settings" ON public.app_settings;
CREATE POLICY "Super admins can manage app settings" ON public.app_settings
    FOR ALL TO authenticated
    USING ((SELECT public.has_role('super_admin')))
    WITH CHECK ((SELECT public.has_role('super_admin')));

-- ── turn_metrics ─────────────────────────────────────────────────────────────
-- Timings and token counts, no text -- but keyed by user_id and chat_group_id,
-- so not for every signed-in parent either.

REVOKE ALL ON TABLE public.turn_metrics FROM anon, authenticated;
GRANT SELECT ON TABLE public.turn_metrics TO authenticated;

DROP POLICY IF EXISTS "Signed-in users can read turn metrics" ON public.turn_metrics;
DROP POLICY IF EXISTS "Super admins can read turn metrics" ON public.turn_metrics;
CREATE POLICY "Super admins can read turn metrics" ON public.turn_metrics
    FOR SELECT TO authenticated
    USING ((SELECT public.has_role('super_admin')));

-- ── conversations and memory ─────────────────────────────────────────────────
-- Q7: no admin reads a child's conversations or memory, on the page or in the
-- database. Their policies are owner-only and stay that way; this only takes
-- away the default grants anon still held on the memory tables, so no future
-- policy can open them to the public key by accident.

REVOKE ALL ON TABLE public.memory_facts, public.memory_segments, public.memories
    FROM anon, authenticated;
GRANT SELECT, DELETE ON TABLE public.memory_facts, public.memory_segments, public.memories
    TO authenticated;

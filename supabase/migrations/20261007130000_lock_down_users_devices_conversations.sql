-- Lock users, devices and conversations to their owners.
--
-- The base schema let anyone holding the public anon key -- it ships inside the
-- web app -- read every child's conversations, rewrite or delete them, read and
-- edit every account, and set `devices.user_id` to bind somebody else's toy to
-- their own account. Every table also granted anon and authenticated the full
-- set of privileges, TRUNCATE included, so one wrong policy would have been
-- enough to lose a table.
--
-- After this:
--   conversations  owner may read and delete. Only the voice server writes, as
--                  service_role (server/fastapi/memory/store.py).
--   users          owner may read their row, create it once on first sign-in
--                  (with their own id and their own email -- the admin
--                  allowlist in lib/admin.ts is keyed on email), and edit the
--                  child's profile. Nothing else: not is_premium, not email,
--                  not device_id.
--   devices        owner may read their devices and change volume and the two
--                  flags the device clears itself after a reset or an update.
--                  Registering a board, claiming it and unbinding it go
--                  through the server, as service_role.
--   anon           no access to any of the three.
--
-- Column-level grants are what stop an owner from editing fields of their own
-- row they should not: RLS decides which rows, the grant decides which
-- columns. A write naming a column outside the grant fails as a whole.
--
-- `users.user_info` stays writable only because onboarding and settings still
-- store the "doctor" user type there; it goes when that identity does (P0-16).
--
-- Re-runnable: every policy is dropped before it is created, and REVOKE/GRANT
-- are idempotent.

-- ── grants ───────────────────────────────────────────────────────────────────

REVOKE ALL ON TABLE public.users, public.devices, public.conversations
    FROM anon, authenticated;

GRANT ALL ON TABLE public.users, public.devices, public.conversations
    TO service_role;

GRANT SELECT ON TABLE public.users TO authenticated;
GRANT INSERT (
    user_id,
    email,
    supervisor_name,
    supervisee_name,
    supervisee_age,
    supervisee_persona,
    personality_id,
    avatar_url
) ON TABLE public.users TO authenticated;
GRANT UPDATE (
    supervisee_name,
    supervisee_age,
    supervisee_persona,
    language_code,
    region_code,
    personality_id,
    user_info
) ON TABLE public.users TO authenticated;

GRANT SELECT ON TABLE public.devices TO authenticated;
GRANT UPDATE (volume, is_reset, is_ota) ON TABLE public.devices TO authenticated;

GRANT SELECT, DELETE ON TABLE public.conversations TO authenticated;

-- ── conversations ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "PUBLIC conversations" ON public.conversations;

DROP POLICY IF EXISTS "Users can view their own conversations" ON public.conversations;
CREATE POLICY "Users can view their own conversations" ON public.conversations
    FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete their own conversations" ON public.conversations;
CREATE POLICY "Users can delete their own conversations" ON public.conversations
    FOR DELETE TO authenticated
    USING ((SELECT auth.uid()) = user_id);

-- ── users ────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Enable read access for all users" ON public.users;
DROP POLICY IF EXISTS "Update user table" ON public.users;
DROP POLICY IF EXISTS "Enable update for users based on email" ON public.users;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.users;

DROP POLICY IF EXISTS "Users can view their own row" ON public.users;
CREATE POLICY "Users can view their own row" ON public.users
    FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can create their own row" ON public.users;
CREATE POLICY "Users can create their own row" ON public.users
    FOR INSERT TO authenticated
    WITH CHECK (
        (SELECT auth.uid()) = user_id
        AND email = (SELECT auth.jwt() ->> 'email')
    );

DROP POLICY IF EXISTS "Users can update their own row" ON public.users;
CREATE POLICY "Users can update their own row" ON public.users
    FOR UPDATE TO authenticated
    USING ((SELECT auth.uid()) = user_id)
    WITH CHECK ((SELECT auth.uid()) = user_id);

-- ── devices ──────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Enable read access for all users" ON public.devices;
DROP POLICY IF EXISTS "esp users can update devices" ON public.devices;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.devices;

DROP POLICY IF EXISTS "Owners can view their devices" ON public.devices;
CREATE POLICY "Owners can view their devices" ON public.devices
    FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Owners can update their devices" ON public.devices;
CREATE POLICY "Owners can update their devices" ON public.devices
    FOR UPDATE TO authenticated
    USING ((SELECT auth.uid()) = user_id)
    WITH CHECK ((SELECT auth.uid()) = user_id);

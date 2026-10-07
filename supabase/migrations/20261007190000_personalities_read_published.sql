-- Who may read a character.
--
-- The base schema's SELECT policy was USING (true) for every role, so the
-- public anon key -- it ships inside the web app -- could read a retired
-- character's prompt, and any signed-in parent could read a character another
-- family made. The writes were already taken away (20261007140000,
-- 20261007180000). This is the read.
--
-- After this a browser can see:
--   published built-ins   creator_id IS NULL and is_hidden = false. The
--                         playground, anon included.
--   its own characters    creator_id = auth.uid(), hidden or not. Existing
--                         parent-made characters stay usable; nothing here
--                         changes their rows.
--   every built-in        content admins (has_role), hidden ones included,
--                         for the admin list.
--                         Not characters a parent made: those stay with the
--                         family.
--
-- The voice server reads characters as service_role, which bypasses RLS, so a
-- child whose account still points at a retired built-in keeps that voice.
-- 20261007170000 already moved those accounts onto 波波熊.

DROP POLICY IF EXISTS "Enable read access for all users" ON public.personalities;

DROP POLICY IF EXISTS "Anyone can read published built-in characters" ON public.personalities;
CREATE POLICY "Anyone can read published built-in characters" ON public.personalities
    FOR SELECT TO anon, authenticated
    USING (creator_id IS NULL AND is_hidden = false);

DROP POLICY IF EXISTS "Owners can read their own characters" ON public.personalities;
CREATE POLICY "Owners can read their own characters" ON public.personalities
    FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = creator_id);

DROP POLICY IF EXISTS "Content admins can read built-in characters" ON public.personalities;
CREATE POLICY "Content admins can read built-in characters" ON public.personalities
    FOR SELECT TO authenticated
    USING ((SELECT public.has_role('content_admin')) AND creator_id IS NULL);

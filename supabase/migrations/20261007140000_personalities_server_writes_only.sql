-- Characters are written by the server only; browsers can read them.
--
-- The base schema let any signed-in account insert any row:
--
--     CREATE POLICY "only insert if you're auth'd" ... FOR INSERT
--         TO authenticated WITH CHECK (true);
--
-- WITH CHECK (true) checks nothing, so an account could insert a row with
-- creator_id NULL -- which is exactly what makes a character built-in, listed
-- on every family's playground -- with whatever character_prompt it liked,
-- spoken to every child who picked it.
--
-- The only browser writer was the parents' /home/create page, which is retired
-- for phase 1: characters are made on the admin page, whose server actions use
-- the service role and bypass RLS. So the policy goes, and with it the write
-- grants Supabase hands anon and authenticated by default. UPDATE and DELETE
-- were already refused by RLS (no policy allows them), but TRUNCATE is not
-- subject to RLS at all, and nothing outside the server should hold any of
-- them.
--
-- SELECT stays: the playground, the landing page and the browser voice route
-- all read characters with the user's own key.

DROP POLICY IF EXISTS "only insert if you're auth'd" ON public.personalities;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.personalities FROM anon, authenticated;

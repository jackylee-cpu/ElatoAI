-- Admin access is the role on the account, not a second factor.
--
-- 20261007180000 made has_role() true only for an aal2 session, so an admin
-- had to enrol an authenticator app before the database would allow anything.
-- That check is dropped. Holding super_admin or content_admin is enough.

CREATE OR REPLACE FUNCTION public.has_role(required_role text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.admin_roles
        WHERE user_id = auth.uid()
          AND (role = required_role OR role = 'super_admin')
    );
$$;

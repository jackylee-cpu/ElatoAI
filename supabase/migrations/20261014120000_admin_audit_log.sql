-- Admin audit log (P1-10).
--
-- Who changed what in the admin console, when, and what it was before and
-- after. Two ways in:
--
--   audit_admin_change()  an AFTER trigger on every table an admin writes
--                         (app_settings, personalities, ips, ip_modes,
--                         ip_styles, admin_roles). It runs in the same
--                         transaction as the change, so no admin write can
--                         land without its record -- whichever page, script or
--                         SQL session made it. The actor is auth.uid(): the
--                         admin's own key for console writes, NULL for the
--                         service role, a migration or psql.
--   admin_audit_record()  for admin actions with no table of ours to hang a
--                         trigger on, such as creating a login (GoTrue writes
--                         auth.users with the service role). Callable by any
--                         admin; the actor is still auth.uid(), never an
--                         argument.
--
-- The log is append-only for everyone, super admins and the service role
-- included: nobody is granted UPDATE, DELETE or TRUNCATE, and a trigger refuses
-- them anyway. Only a database superuser could get round that (by dropping the
-- trigger), which is the direct-access problem P1-11 is about.
--
-- Nothing a child said is ever written here (Q7): the audited tables hold
-- settings, characters, IPs and roles, and the rows are copied as they are.
--
-- Re-runnable: IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS first.

-- ── table ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
    audit_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at   timestamptz NOT NULL DEFAULT now(),
    -- No foreign key: the record has to outlive the account that made it.
    actor_id     uuid,
    actor_email  text,
    -- insert / update / delete for a table change, or a verb such as
    -- 'account.create' for admin_audit_record().
    action       text NOT NULL,
    target_table text,
    -- The row's primary key, ':'-joined for a composite key.
    target_id    text,
    -- Something a person recognises: a character's title, an IP's name, the
    -- email a role was granted to.
    target_label text,
    reason       text,
    -- Whole rows for insert and delete; only the changed columns for update.
    before       jsonb,
    after        jsonb
);

CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx
    ON public.admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_log_actor_idx
    ON public.admin_audit_log (actor_id, created_at DESC);

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.admin_audit_log FROM anon, authenticated, service_role;
GRANT SELECT ON TABLE public.admin_audit_log TO authenticated;
-- The service role may read and append (a future server-side job), never
-- change what is there.
GRANT SELECT, INSERT ON TABLE public.admin_audit_log TO service_role;
GRANT USAGE ON SEQUENCE public.admin_audit_log_audit_id_seq TO service_role;

DROP POLICY IF EXISTS "Super admins read the audit log" ON public.admin_audit_log;
CREATE POLICY "Super admins read the audit log"
    ON public.admin_audit_log FOR SELECT TO authenticated
    USING (public.has_role('super_admin'));

-- ── append-only ──────────────────────────────────────────────────────────────
-- Grants already refuse UPDATE and DELETE; this also stops the table owner and
-- anything that holds broader privileges than the grants above.

CREATE OR REPLACE FUNCTION public.admin_audit_log_refuse_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION 'admin_audit_log is append-only'
        USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS admin_audit_log_no_update_delete ON public.admin_audit_log;
CREATE TRIGGER admin_audit_log_no_update_delete
    BEFORE UPDATE OR DELETE ON public.admin_audit_log
    FOR EACH ROW EXECUTE FUNCTION public.admin_audit_log_refuse_change();

DROP TRIGGER IF EXISTS admin_audit_log_no_truncate ON public.admin_audit_log;
CREATE TRIGGER admin_audit_log_no_truncate
    BEFORE TRUNCATE ON public.admin_audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION public.admin_audit_log_refuse_change();

-- ── table trigger ────────────────────────────────────────────────────────────
-- TG_ARGV names the primary key columns. SECURITY DEFINER because nobody
-- writing these tables may insert into the log directly.

CREATE OR REPLACE FUNCTION public.audit_admin_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    old_row   jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
    new_row   jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
    some_row  jsonb := coalesce(to_jsonb(NEW), to_jsonb(OLD));
    before_v  jsonb := old_row;
    after_v   jsonb := new_row;
    key_text  text;
    label     text;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Keep only what changed. Bookkeeping columns are left out of the
        -- comparison, so saving a form without touching it records nothing.
        SELECT jsonb_object_agg(o.key, o.value), jsonb_object_agg(o.key, new_row -> o.key)
          INTO before_v, after_v
          FROM jsonb_each(old_row) AS o
         WHERE o.key NOT IN ('updated_at', 'updated_by')
           AND (new_row -> o.key) IS DISTINCT FROM o.value;
        IF before_v IS NULL THEN
            RETURN NULL;
        END IF;
    END IF;

    SELECT string_agg(some_row ->> column_name, ':')
      INTO key_text
      FROM unnest(TG_ARGV) AS column_name;

    IF TG_TABLE_NAME = 'admin_roles' THEN
        SELECT u.email INTO label
          FROM auth.users AS u
         WHERE u.id = (some_row ->> 'user_id')::uuid;
    ELSE
        label := coalesce(some_row ->> 'title', some_row ->> 'name', some_row ->> 'key');
    END IF;

    INSERT INTO public.admin_audit_log
        (actor_id, actor_email, action, target_table, target_id, target_label, before, after)
    VALUES
        (auth.uid(), auth.jwt() ->> 'email', lower(TG_OP), TG_TABLE_NAME,
         key_text, label, before_v, after_v);
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_admin_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS audit_admin_change ON public.app_settings;
CREATE TRIGGER audit_admin_change
    AFTER INSERT OR UPDATE OR DELETE ON public.app_settings
    FOR EACH ROW EXECUTE FUNCTION public.audit_admin_change('key');

DROP TRIGGER IF EXISTS audit_admin_change ON public.personalities;
CREATE TRIGGER audit_admin_change
    AFTER INSERT OR UPDATE OR DELETE ON public.personalities
    FOR EACH ROW EXECUTE FUNCTION public.audit_admin_change('personality_id');

DROP TRIGGER IF EXISTS audit_admin_change ON public.ips;
CREATE TRIGGER audit_admin_change
    AFTER INSERT OR UPDATE OR DELETE ON public.ips
    FOR EACH ROW EXECUTE FUNCTION public.audit_admin_change('ip_key');

DROP TRIGGER IF EXISTS audit_admin_change ON public.ip_modes;
CREATE TRIGGER audit_admin_change
    AFTER INSERT OR UPDATE OR DELETE ON public.ip_modes
    FOR EACH ROW EXECUTE FUNCTION public.audit_admin_change('ip_key', 'mode_key');

DROP TRIGGER IF EXISTS audit_admin_change ON public.ip_styles;
CREATE TRIGGER audit_admin_change
    AFTER INSERT OR UPDATE OR DELETE ON public.ip_styles
    FOR EACH ROW EXECUTE FUNCTION public.audit_admin_change('ip_key', 'style_key');

DROP TRIGGER IF EXISTS audit_admin_change ON public.admin_roles;
CREATE TRIGGER audit_admin_change
    AFTER INSERT OR UPDATE OR DELETE ON public.admin_roles
    FOR EACH ROW EXECUTE FUNCTION public.audit_admin_change('user_id', 'role');

-- ── explicit records ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_audit_record(
    p_action       text,
    p_target_table text DEFAULT NULL,
    p_target_id    text DEFAULT NULL,
    p_target_label text DEFAULT NULL,
    p_reason       text DEFAULT NULL,
    p_before       jsonb DEFAULT NULL,
    p_after        jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- content_admin is the lowest role; super_admin passes too.
    IF NOT public.has_role('content_admin') THEN
        RAISE EXCEPTION 'only an admin can write to the audit log'
            USING ERRCODE = '42501';
    END IF;
    IF coalesce(btrim(p_action), '') = '' THEN
        RAISE EXCEPTION 'an audit record needs an action'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.admin_audit_log
        (actor_id, actor_email, action, target_table, target_id, target_label,
         reason, before, after)
    VALUES
        (auth.uid(), auth.jwt() ->> 'email', p_action, p_target_table, p_target_id,
         p_target_label, nullif(btrim(p_reason), ''), p_before, p_after);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_audit_record(text, text, text, text, text, jsonb, jsonb)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_audit_record(text, text, text, text, text, jsonb, jsonb)
    TO authenticated;

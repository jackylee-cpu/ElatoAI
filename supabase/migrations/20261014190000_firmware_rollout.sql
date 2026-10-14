-- Staged OTA rollout: how far each release has gone, and what each board did
-- with it (P2-17, part of P2-16).
--
-- Until now marking a release current offered it to every board of its kind
-- at once. A release now also carries:
--
--   rollout_percent  0, 10, 50 or 100. Which share of the boards may take it,
--                    chosen by a stable hash of the MAC (frontend-nextjs/lib/ota.ts).
--                    0 means the whitelist only. Defaults to 100, so a release
--                    published and promoted with release_firmware.py behaves
--                    exactly as before.
--   rollout_macs     the whitelist: these boards may take it at any stage.
--   paused_at/_reason/_by
--                    a paused release is offered to nobody; boards that already
--                    took it keep it. paused_by is NULL when the server paused
--                    it on its own (too many rollbacks, P2-19).
--   stage_changed_at when it was last promoted or moved to another stage;
--                    NULL for a release that has never been current (a draft).
--
-- firmware_rollout_devices keeps one row per (release, board) once the server
-- has offered that release to that board:
--
--   offer_count   how many times it was offered. A board that keeps being
--                 offered the same release is installing it and losing it
--                 before it can report back (P2-19 pauses at 3).
--   running_at    the board first reported running that version. It is then
--                 still on probation (firmware-arduino/src/OTA.cpp confirms it
--                 120 s after auth and does not tell the server), so this is
--                 "updated", not "confirmed": a later failed_at overrides it.
--   failed_at     the board reported that version as failed, after a rollback.
--
-- Only the service role writes either table: the release script, and the token
-- route through ota_note_offer() and ota_note_report(). Super admins read them
-- for the OTA page. Changes to firmware_releases are audited (P1-10); the
-- per-board rows are not -- the token route writes them on every boot.
--
-- Re-runnable: IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS first.

-- ── releases ─────────────────────────────────────────────────────────────────

ALTER TABLE public.firmware_releases
    ADD COLUMN IF NOT EXISTS rollout_percent  smallint NOT NULL DEFAULT 100,
    ADD COLUMN IF NOT EXISTS rollout_macs     text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS paused_at        timestamptz,
    ADD COLUMN IF NOT EXISTS paused_reason    text,
    ADD COLUMN IF NOT EXISTS paused_by        uuid;

-- Releases from before this migration may have been current, and boards may
-- run them, so they must not count as never-rolled-out drafts (which the admin
-- console can delete, 20261014210000). Backfilled once, when the column is
-- added: a re-run leaves real drafts alone.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'firmware_releases'
                      AND column_name = 'stage_changed_at') THEN
        ALTER TABLE public.firmware_releases ADD COLUMN stage_changed_at timestamptz;
        UPDATE public.firmware_releases SET stage_changed_at = created_at;
    END IF;
END
$$;

ALTER TABLE public.firmware_releases
    DROP CONSTRAINT IF EXISTS firmware_releases_rollout_percent_check,
    DROP CONSTRAINT IF EXISTS firmware_releases_rollout_macs_check,
    DROP CONSTRAINT IF EXISTS firmware_releases_paused_check;

ALTER TABLE public.firmware_releases
    ADD CONSTRAINT firmware_releases_rollout_percent_check
        CHECK (rollout_percent IN (0, 10, 50, 100)),
    -- Same form as devices.mac_address: upper case, colon separated. The
    -- whole array as one string, so a single bad or empty entry fails the
    -- check; array_to_string skips NULLs, so those are refused separately.
    ADD CONSTRAINT firmware_releases_rollout_macs_check
        CHECK (array_position(rollout_macs, NULL) IS NULL
               AND array_to_string(rollout_macs, ',')
                   ~ '^([0-9A-F]{2}(:[0-9A-F]{2}){5}(,[0-9A-F]{2}(:[0-9A-F]{2}){5})*)?$'),
    -- A pause always says why; an unpaused release has no leftover reason.
    ADD CONSTRAINT firmware_releases_paused_check
        CHECK ((paused_at IS NULL) = (coalesce(btrim(paused_reason), '') = '')
               AND (paused_at IS NOT NULL OR paused_by IS NULL));

-- Stamp stage_changed_at whenever a release is promoted or its share changes,
-- whoever does it: the console, the release script or psql.
CREATE OR REPLACE FUNCTION public.firmware_releases_stamp_stage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.is_current THEN
            NEW.stage_changed_at := now();
        END IF;
    ELSIF (NEW.is_current AND NOT OLD.is_current)
       OR NEW.rollout_percent IS DISTINCT FROM OLD.rollout_percent THEN
        NEW.stage_changed_at := now();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS firmware_releases_stamp_stage ON public.firmware_releases;
CREATE TRIGGER firmware_releases_stamp_stage
    BEFORE INSERT OR UPDATE ON public.firmware_releases
    FOR EACH ROW EXECUTE FUNCTION public.firmware_releases_stamp_stage();

-- ── per-board results ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.firmware_rollout_devices (
    release_id       uuid NOT NULL REFERENCES public.firmware_releases (release_id) ON DELETE CASCADE,
    device_id        uuid NOT NULL REFERENCES public.devices (device_id) ON DELETE CASCADE,
    first_offered_at timestamptz NOT NULL DEFAULT now(),
    last_offered_at  timestamptz NOT NULL DEFAULT now(),
    offer_count      integer NOT NULL DEFAULT 1 CHECK (offer_count > 0),
    running_at       timestamptz,
    failed_at        timestamptz,
    PRIMARY KEY (release_id, device_id)
);

CREATE INDEX IF NOT EXISTS firmware_rollout_devices_device_idx
    ON public.firmware_rollout_devices (device_id);

ALTER TABLE public.firmware_rollout_devices ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.firmware_rollout_devices FROM anon, authenticated;
GRANT SELECT ON TABLE public.firmware_rollout_devices TO authenticated;
GRANT ALL ON TABLE public.firmware_rollout_devices TO service_role;

DROP POLICY IF EXISTS "Super admins read rollout results" ON public.firmware_rollout_devices;
CREATE POLICY "Super admins read rollout results"
    ON public.firmware_rollout_devices FOR SELECT TO authenticated
    USING (public.has_role('super_admin'));

-- ── token route helpers (service role only) ──────────────────────────────────

-- The server is about to offer this release to this board. Returns how many
-- times it has now been offered, the first time included.
CREATE OR REPLACE FUNCTION public.ota_note_offer(p_release_id uuid, p_device_id uuid)
RETURNS integer
LANGUAGE sql
SET search_path = ''
AS $$
    INSERT INTO public.firmware_rollout_devices AS r (release_id, device_id)
    VALUES (p_release_id, p_device_id)
    ON CONFLICT (release_id, device_id) DO UPDATE
       SET offer_count = r.offer_count + 1,
           last_offered_at = now()
    RETURNING r.offer_count;
$$;

-- What a board reported, against the releases it was offered: the version it
-- runs is "running", the version it rolled back from is "failed". Only rows
-- for releases this server offered are touched, so a board flashed over USB
-- counts for nothing.
CREATE OR REPLACE FUNCTION public.ota_note_report(
    p_device_id      uuid,
    p_board          text,
    p_version        text,
    p_failed_version text
)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
    UPDATE public.firmware_rollout_devices AS r
       SET running_at = coalesce(r.running_at, CASE WHEN f.version = p_version THEN now() END),
           failed_at  = coalesce(r.failed_at,  CASE WHEN f.version = p_failed_version THEN now() END)
      FROM public.firmware_releases AS f
     WHERE r.release_id = f.release_id
       AND r.device_id = p_device_id
       AND f.board = p_board
       AND f.version IN (p_version, p_failed_version)
       AND ((f.version = p_version AND r.running_at IS NULL)
         OR (f.version = p_failed_version AND r.failed_at IS NULL));
$$;

-- Supabase grants EXECUTE on new functions in `public` to anon by default.
REVOKE ALL ON FUNCTION public.ota_note_offer(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ota_note_report(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ota_note_offer(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ota_note_report(uuid, text, text, text) TO service_role;

-- ── audit ────────────────────────────────────────────────────────────────────
-- Every change to a release -- publish, promote, stage, whitelist, pause -- is
-- recorded with audit_admin_change() (20261014120000). That function labels a
-- row by title, name or key; a release has none, so it is redefined here with
-- one more case. Keep the two copies in step: re-running 20261014120000 on its
-- own puts the old version back, and release records then go unlabelled.

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
         WHERE o.key NOT IN ('updated_at', 'updated_by', 'stage_changed_at')
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
    ELSIF TG_TABLE_NAME = 'firmware_releases' THEN
        label := (some_row ->> 'board') || ' ' || (some_row ->> 'version');
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

DROP TRIGGER IF EXISTS audit_admin_change ON public.firmware_releases;
CREATE TRIGGER audit_admin_change
    AFTER INSERT OR UPDATE OR DELETE ON public.firmware_releases
    FOR EACH ROW EXECUTE FUNCTION public.audit_admin_change('release_id');

-- Memory per device, and unbinding and clearing it as single transactions that
-- a live session cannot undo (P1-12).
--
-- Memory belongs to a device on an account: (user_id, device_id, ip_key). An
-- account can own several boards (20261009130000) -- typically one per child --
-- so each board remembers its own child. user_id stays in the key so that
-- another account claiming a board never sees what it heard before: its rows
-- are still under the old owner.
--
-- Unbinding keeps the board's memory by default. The same account claiming it
-- again picks up where it left off; a replacement board starts empty. Clearing
-- is the parent's choice, while unbinding or from the memory section of the
-- settings page, and touches only that board. The web app's voice playground
-- has no board and runs without memory.
--
-- What makes a clear stick is `devices.memories_revision`, how many times that
-- board's memory has been cleared. The voice server stamps every conversation
-- turn, segment and fact it writes with the revision its session started
-- under, and the trigger below refuses a stamp older than the board's.
-- Without it, a session that was talking when the parent pressed clear -- or
-- the consolidation that runs after it ends -- writes what it heard straight
-- back. Per board, so clearing one never refuses another's writes.
-- `users.memories_revision` (from the removed VoiceMem store) is left unused.
--
-- A row without a stamp or a device is not checked: nothing but the voice
-- server writes these tables, and a server older than this migration must
-- keep working until it is redeployed.
--
-- `turn_metrics` is not cleared: it holds timings and character counts, no
-- words, and keeps its rows when the account goes (ON DELETE SET NULL).
--
-- Comes after 20261009130000, which drops `users.device_id`: `devices.user_id`
-- is the only record of ownership. Re-runnable.

ALTER TABLE public.devices
    ADD COLUMN IF NOT EXISTS memories_revision integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.devices.memories_revision IS
    'Bumped every time this device''s memory is cleared; the voice server''s writes from before that are refused';

ALTER TABLE public.conversations
    ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES public.devices (device_id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS memories_revision integer;
ALTER TABLE public.memory_facts
    ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES public.devices (device_id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS memories_revision integer;
ALTER TABLE public.memory_segments
    ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES public.devices (device_id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS memories_revision integer;

COMMENT ON COLUMN public.conversations.device_id IS
    'The board this was said to; NULL for rows from before memory was per device and from accounts that had no board';
COMMENT ON COLUMN public.conversations.memories_revision IS
    'devices.memories_revision when the writing session started; older than the device''s means its memory was cleared since, and the insert is refused';
COMMENT ON COLUMN public.memory_facts.memories_revision IS
    'See conversations.memories_revision';
COMMENT ON COLUMN public.memory_segments.memories_revision IS
    'See conversations.memories_revision';

-- ── existing rows go to the account's first board ───────────────────────────

-- Until now an account had one board, so its memory is that board's. Where an
-- account somehow owns several, the earliest claimed (the order the settings
-- page lists them in) takes it. Rows of an account with no board keep a NULL
-- device: nothing reads them, and retention (P1-03) clears them.
WITH first_device AS (
    SELECT DISTINCT ON (user_id) user_id, device_id
    FROM public.devices
    WHERE user_id IS NOT NULL
    ORDER BY user_id, claimed_at ASC NULLS FIRST, created_at ASC
)
UPDATE public.memory_facts AS t SET device_id = f.device_id
FROM first_device AS f
WHERE t.user_id = f.user_id AND t.device_id IS NULL;

WITH first_device AS (
    SELECT DISTINCT ON (user_id) user_id, device_id
    FROM public.devices
    WHERE user_id IS NOT NULL
    ORDER BY user_id, claimed_at ASC NULLS FIRST, created_at ASC
)
UPDATE public.memory_segments AS t SET device_id = f.device_id
FROM first_device AS f
WHERE t.user_id = f.user_id AND t.device_id IS NULL;

WITH first_device AS (
    SELECT DISTINCT ON (user_id) user_id, device_id
    FROM public.devices
    WHERE user_id IS NOT NULL
    ORDER BY user_id, claimed_at ASC NULLS FIRST, created_at ASC
)
UPDATE public.conversations AS t SET device_id = f.device_id
FROM first_device AS f
WHERE t.user_id = f.user_id AND t.device_id IS NULL;

-- What the voice server reads at connect, per board and IP.
CREATE INDEX IF NOT EXISTS memory_facts_device_idx
    ON public.memory_facts (user_id, device_id, ip_key, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_segments_device_idx
    ON public.memory_segments (user_id, device_id, ip_key, created_at DESC);
CREATE INDEX IF NOT EXISTS conversations_device_idx
    ON public.conversations (device_id);

-- ── refuse writes from before the last clear ────────────────────────────────

CREATE OR REPLACE FUNCTION public.refuse_memory_from_before_clear()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    current_revision integer;
BEGIN
    IF NEW.memories_revision IS NULL OR NEW.device_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- FOR SHARE waits for a clear that is bumping the revision right now, and
    -- holds that clear off until this insert commits. Either the insert lands
    -- first and the clear's DELETE removes it, or the clear lands first and
    -- this sees the new revision. A plain read could pass the check, then
    -- commit after the DELETE had already run.
    SELECT d.memories_revision INTO current_revision
    FROM public.devices AS d
    WHERE d.device_id = NEW.device_id
    FOR SHARE;

    IF current_revision IS NOT NULL AND NEW.memories_revision < current_revision THEN
        RAISE EXCEPTION 'memory of device % was cleared after this session started (revision % < %)',
            NEW.device_id, NEW.memories_revision, current_revision
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.refuse_memory_from_before_clear() FROM PUBLIC;

DROP TRIGGER IF EXISTS conversations_refuse_from_before_clear ON public.conversations;
CREATE TRIGGER conversations_refuse_from_before_clear
    BEFORE INSERT ON public.conversations
    FOR EACH ROW EXECUTE FUNCTION public.refuse_memory_from_before_clear();

DROP TRIGGER IF EXISTS memory_facts_refuse_from_before_clear ON public.memory_facts;
CREATE TRIGGER memory_facts_refuse_from_before_clear
    BEFORE INSERT ON public.memory_facts
    FOR EACH ROW EXECUTE FUNCTION public.refuse_memory_from_before_clear();

DROP TRIGGER IF EXISTS memory_segments_refuse_from_before_clear ON public.memory_segments;
CREATE TRIGGER memory_segments_refuse_from_before_clear
    BEFORE INSERT ON public.memory_segments
    FOR EACH ROW EXECUTE FUNCTION public.refuse_memory_from_before_clear();

-- ── clear ───────────────────────────────────────────────────────────────────

-- Everything one board knows or heard about its child, across every IP. The
-- revision goes up first, so a session writing while this runs is refused from
-- here on (see the trigger above). Only the owner's: a board this account does
-- not own is an error, and nothing is deleted.
--
-- The old VoiceMem lines (`memories`) predate devices and nothing reads them;
-- any clear on the account removes them, so a clear never leaves words behind.
CREATE OR REPLACE FUNCTION public.clear_device_memory(p_user_id uuid, p_device_id uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    new_revision integer;
BEGIN
    UPDATE public.devices
    SET memories_revision = memories_revision + 1
    WHERE device_id = p_device_id AND user_id = p_user_id
    RETURNING memories_revision INTO new_revision;

    IF new_revision IS NULL THEN
        RAISE EXCEPTION 'device % is not owned by %', p_device_id, p_user_id
            USING ERRCODE = 'P0002';
    END IF;

    DELETE FROM public.memory_facts WHERE user_id = p_user_id AND device_id = p_device_id;
    DELETE FROM public.memory_segments WHERE user_id = p_user_id AND device_id = p_device_id;
    DELETE FROM public.conversations WHERE user_id = p_user_id AND device_id = p_device_id;
    DELETE FROM public.memories WHERE user_id = p_user_id;

    RETURN new_revision;
END;
$$;

-- ── unbind ──────────────────────────────────────────────────────────────────

-- Release a board from its owner, clearing its memory first when asked. One
-- transaction: a failed clear leaves the board bound, so a parent is never
-- told "unbound" with the memory still there.
--
-- Returns the board's MAC, which the web app needs to drop its live voice
-- session, or NULL when this account does not own this board -- in which case
-- nothing at all has changed.
CREATE OR REPLACE FUNCTION public.unbind_device(
    p_device_id uuid,
    p_user_id uuid,
    p_clear_memory boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    mac text;
BEGIN
    SELECT mac_address INTO mac
    FROM public.devices
    WHERE device_id = p_device_id AND user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- Before the owner goes: the clear checks ownership.
    IF p_clear_memory THEN
        PERFORM public.clear_device_memory(p_user_id, p_device_id);
    END IF;

    UPDATE public.devices
    SET user_id = NULL, claimed_at = NULL
    WHERE device_id = p_device_id;

    RETURN mac;
END;
$$;

-- Both take the account as a parameter, so only the web app's server -- which
-- takes it from the signed-in session -- may call them. Supabase grants EXECUTE
-- on new functions in `public` to anon and authenticated by default.
REVOKE ALL ON FUNCTION public.clear_device_memory(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unbind_device(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_device_memory(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.unbind_device(uuid, uuid, boolean) TO service_role;

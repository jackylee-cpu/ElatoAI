-- Unbinding a device, and clearing a child's memory, as single transactions
-- that a live session cannot undo (P1-12).
--
-- Memory belongs to the account (user_id + ip_key), not to the device. So
-- unbinding keeps it by default -- the same account claiming this board again,
-- or a replacement, picks up where it left off -- and another account that
-- claims the board never sees it, because its user_id is different. Clearing
-- is a separate choice the parent makes, either while unbinding or from the
-- memory section of the settings page. An account can own several boards
-- (20261009130000) and they share one memory, so clearing while unbinding one
-- clears it for the others too; the web app says so before it asks.
--
-- Comes after 20261009130000, which drops `users.device_id`: `devices.user_id`
-- is the only record of ownership, and the only thing unbinding changes.
--
-- What makes a clear stick is `users.memories_revision`. It was added for the
-- removed VoiceMem store and has been read at session start, and ignored,
-- since; it now means "how many times this child's memory has been cleared".
-- The voice server stamps every conversation turn, segment and fact it writes
-- with the revision its session started under, and the trigger below refuses
-- a stamp older than the account's. Without it, a session that was talking
-- when the parent pressed clear -- or the consolidation that runs after it
-- ends -- writes what it heard straight back.
--
-- An unstamped row (NULL) is not checked: nothing but the voice server writes
-- these tables, and a server older than this migration must keep working
-- until it is redeployed.
--
-- `turn_metrics` is not cleared: it holds timings and character counts, no
-- words, and keeps its rows when the account goes (ON DELETE SET NULL).

ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS memories_revision integer;
ALTER TABLE public.memory_facts ADD COLUMN IF NOT EXISTS memories_revision integer;
ALTER TABLE public.memory_segments ADD COLUMN IF NOT EXISTS memories_revision integer;

COMMENT ON COLUMN public.conversations.memories_revision IS
    'users.memories_revision when the writing session started; older than the account''s means the memory was cleared since, and the insert is refused';
COMMENT ON COLUMN public.memory_facts.memories_revision IS
    'users.memories_revision when the writing session started; see conversations.memories_revision';
COMMENT ON COLUMN public.memory_segments.memories_revision IS
    'users.memories_revision when the writing session started; see conversations.memories_revision';

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
    IF NEW.memories_revision IS NULL THEN
        RETURN NEW;
    END IF;

    -- FOR SHARE waits for a clear that is bumping the revision right now, and
    -- holds that clear off until this insert commits. Either the insert lands
    -- first and the clear's DELETE removes it, or the clear lands first and
    -- this sees the new revision. A plain read could pass the check, then
    -- commit after the DELETE had already run.
    SELECT u.memories_revision INTO current_revision
    FROM public.users AS u
    WHERE u.user_id = NEW.user_id
    FOR SHARE;

    IF current_revision IS NOT NULL AND NEW.memories_revision < current_revision THEN
        RAISE EXCEPTION 'memory for % was cleared after this session started (revision % < %)',
            NEW.user_id, NEW.memories_revision, current_revision
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

-- Everything the toy knows or heard about this child, across every IP, and the
-- old VoiceMem lines. The revision goes up first, so a session writing while
-- this runs is refused from here on (see the trigger above).
CREATE OR REPLACE FUNCTION public.clear_child_memory(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    new_revision integer;
BEGIN
    UPDATE public.users
    SET memories_revision = memories_revision + 1
    WHERE user_id = p_user_id
    RETURNING memories_revision INTO new_revision;

    IF new_revision IS NULL THEN
        RAISE EXCEPTION 'no user %', p_user_id USING ERRCODE = 'P0002';
    END IF;

    -- Facts first: their delete trigger drops segments by conversation, which
    -- is moot here but cheaper with the segments still to go.
    DELETE FROM public.memory_facts WHERE user_id = p_user_id;
    DELETE FROM public.memory_segments WHERE user_id = p_user_id;
    DELETE FROM public.conversations WHERE user_id = p_user_id;
    DELETE FROM public.memories WHERE user_id = p_user_id;

    RETURN new_revision;
END;
$$;

-- ── unbind ──────────────────────────────────────────────────────────────────

-- Release a device from its owner, and clear the child's memory too when asked.
-- One transaction: a failed clear leaves the device bound, so a parent is never
-- told "unbound" with the memory still there.
--
-- Returns the device's MAC, which the web app needs to drop the board's live
-- voice session, or NULL when this account does not own this device -- in
-- which case nothing at all has changed.
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
    UPDATE public.devices
    SET user_id = NULL, claimed_at = NULL
    WHERE device_id = p_device_id AND user_id = p_user_id
    RETURNING mac_address INTO mac;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF p_clear_memory THEN
        PERFORM public.clear_child_memory(p_user_id);
    END IF;

    RETURN mac;
END;
$$;

-- Both take the account as a parameter, so only the web app's server -- which
-- takes it from the signed-in session -- may call them. Supabase grants EXECUTE
-- on new functions in `public` to anon and authenticated by default.
REVOKE ALL ON FUNCTION public.clear_child_memory(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unbind_device(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_child_memory(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.unbind_device(uuid, uuid, boolean) TO service_role;

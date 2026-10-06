-- The facts layer of long-term memory: who this child is, not what was said.
--
-- `memory_segments` answers "what did we talk about last time", and only the
-- last couple of segments reach the next session. That is the wrong shape for a
-- name, a pet or a food they hate. A child says those once, and two short
-- sessions later the segment that held them has aged out of the brief.
-- Measured on the dev data: most sessions are one or two turns, so "the last
-- two segments" is routinely two sessions that only asked the time.
--
-- So each consolidation (every few turns, and at session end -- the same LLM
-- call that writes a segment) also returns facts, and they live here, one per
-- row, until something replaces them. The whole active list goes into the
-- system prompt at connect. Nothing is retrieved per turn.
--
-- Three properties are load-bearing:
--
--   * Extracted from RAW turns, with the current list alongside only so the
--     model can see what is already known. The list is never rewritten as a
--     whole. A model that silently drops half of it on one bad run is exactly
--     how a rolling-summary memory loses things for good.
--   * Replacing a fact does not delete it. `superseded_at` retires it and
--     `superseded_by` says what took its place, so a bad replacement can be
--     traced and undone. `superseded_at` is what decides "active"; the link
--     is provenance only, which is why deleting the newer fact does not
--     resurrect the older one.
--   * One row per fact, so a parent deletes exactly the thing that is wrong.

CREATE TABLE IF NOT EXISTS public.memory_facts (
    fact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    -- One short sentence about the child, in the language they spoke.
    content text NOT NULL,
    -- The conversation it was learned in, for tracing a fact back to the
    -- transcript and for clearing that conversation's segments when it goes.
    chat_group_id uuid,
    superseded_at timestamptz,
    superseded_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memory_facts_content_check CHECK (length(btrim(content)) > 0)
);

ALTER TABLE ONLY public.memory_facts
    DROP CONSTRAINT IF EXISTS memory_facts_user_id_fkey;
ALTER TABLE ONLY public.memory_facts
    ADD CONSTRAINT memory_facts_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.memory_facts
    DROP CONSTRAINT IF EXISTS memory_facts_superseded_by_fkey;
ALTER TABLE ONLY public.memory_facts
    ADD CONSTRAINT memory_facts_superseded_by_fkey
    FOREIGN KEY (superseded_by) REFERENCES public.memory_facts(fact_id) ON DELETE SET NULL;

-- Every read is "this child's active facts, newest first".
CREATE INDEX IF NOT EXISTS memory_facts_user_active_idx
    ON public.memory_facts (user_id, created_at DESC)
    WHERE superseded_at IS NULL;

ALTER TABLE public.memory_facts ENABLE ROW LEVEL SECURITY;

-- Same owner-scoped shape as `memories` and `memory_segments`.
DROP POLICY IF EXISTS "Users can view their own memory facts" ON public.memory_facts;
CREATE POLICY "Users can view their own memory facts" ON public.memory_facts
    FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete their own memory facts" ON public.memory_facts;
CREATE POLICY "Users can delete their own memory facts" ON public.memory_facts
    FOR DELETE TO authenticated
    USING ((SELECT auth.uid()) = user_id);

GRANT SELECT, DELETE ON TABLE public.memory_facts TO authenticated;
GRANT ALL ON TABLE public.memory_facts TO service_role;

-- A deleted fact must not come back through a segment written in the same
-- conversation. Segments are summaries of those same turns, so one that
-- mentions the dog is still in the next opening brief after the parent deletes
-- "has a dog called 豆豆". They are derived data: dropping that conversation's
-- segments costs a little continuity, and keeping them would leak exactly
-- what was deleted. Only the conversations the deleted facts came from.
CREATE OR REPLACE FUNCTION public.forget_segments_for_deleted_facts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM public.memory_segments AS s
    USING (
        SELECT DISTINCT d.user_id, d.chat_group_id
        FROM deleted_facts AS d
        -- Retired facts were already out of the prompt; deleting one is
        -- tidying up, not a correction.
        WHERE d.chat_group_id IS NOT NULL AND d.superseded_at IS NULL
    ) AS gone
    WHERE s.user_id = gone.user_id
      AND s.chat_group_id = gone.chat_group_id;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.forget_segments_for_deleted_facts() FROM PUBLIC;

DROP TRIGGER IF EXISTS memory_facts_forget_segments_on_delete ON public.memory_facts;
CREATE TRIGGER memory_facts_forget_segments_on_delete
    AFTER DELETE ON public.memory_facts
    REFERENCING OLD TABLE AS deleted_facts
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.forget_segments_for_deleted_facts();

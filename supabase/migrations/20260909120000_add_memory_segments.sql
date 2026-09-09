-- Session summaries, so a child picking the toy up tomorrow gets continuity
-- without paying for a retrieval on the first sentence.
--
-- `memories` already holds every utterance, but reading it back is not what a
-- greeting needs: replaying rows costs one fact-extraction call each, and a
-- vector search costs ~850ms the reply cannot wait for. What a new session
-- actually needs is one short paragraph -- "last time you talked about X" --
-- that is already on disk before the first frame arrives.
--
-- So every few turns the server compresses the raw turns since the last
-- summary into one row here, and the next session reads the last couple of
-- rows straight into the system prompt. Two properties are worth stating
-- because they are easy to lose in a later edit:
--
--   * A segment is derived from the RAW turns, never from another summary.
--     Summarising a summary compounds its errors -- after a few dozen sessions
--     the toy is confidently wrong about things nobody said. Depth stays at
--     exactly 2: utterance -> segment.
--   * `from_turn`/`to_turn` are indices within one chat_group_id, so a
--     reconnect that reuses the group id can pick up where it stopped instead
--     of compressing the same turns twice.
--
-- Deleting a memory does not delete a segment that already mentions it, and
-- that is the known hole. `users.memories_revision` clears segments at the
-- same moment it discards the local VoiceMem store (memory/session.py), which
-- covers a parent deleting something while a session is live or while a
-- mounted store survives a restart -- but not a delete made while the server
-- was down and holding nothing. Closing it properly needs a revision column on
-- this table; until then a segment can outlive the utterance it came from by
-- one session.

CREATE TABLE IF NOT EXISTS public.memory_segments (
    segment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    -- The conversation this segment came out of. Matches
    -- conversations.chat_group_id, so a segment can be traced back to the
    -- transcript a parent sees.
    chat_group_id uuid,
    from_turn integer NOT NULL DEFAULT 0,
    to_turn integer NOT NULL DEFAULT 0,
    summary text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ONLY public.memory_segments
    ADD CONSTRAINT memory_segments_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;

-- Every read is "this child's most recent segments", either across sessions
-- (the opening brief) or within one (the running summary).
CREATE INDEX IF NOT EXISTS memory_segments_user_created_idx
    ON public.memory_segments (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS memory_segments_group_idx
    ON public.memory_segments (user_id, chat_group_id, to_turn);

ALTER TABLE public.memory_segments ENABLE ROW LEVEL SECURITY;

-- Same owner-scoped shape as `memories`: a summary of what a child said is
-- every bit as personal as the utterances it was made from.
CREATE POLICY "Users can view their own memory segments" ON public.memory_segments
    FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete their own memory segments" ON public.memory_segments
    FOR DELETE TO authenticated
    USING ((SELECT auth.uid()) = user_id);

GRANT SELECT, DELETE ON TABLE public.memory_segments TO authenticated;
GRANT ALL ON TABLE public.memory_segments TO service_role;

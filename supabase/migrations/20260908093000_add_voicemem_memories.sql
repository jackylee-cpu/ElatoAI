-- Long-term memory for the FastAPI voice pipeline (VoiceMem).
--
-- VoiceMem keeps its working store on the container's local disk (one sqlite +
-- a directory per memory space). That disk is ephemeral -- Pipecat Cloud agents
-- and `docker compose up` both start clean -- so Supabase is the source of
-- truth and the local space is a cache rebuilt from here.
--
-- Two things live here:
--   * `memories`  -- one row per utterance that was fed into memory, and the
--                    ONLY thing a rebuild replays. A parent deleting a row
--                    therefore really does erase it: if a rebuild replayed the
--                    raw `conversations` transcript instead, every deleted
--                    memory would come straight back. `conversations` stays a
--                    transcript for the web app to display, never a memory
--                    source.
--   * `users.memories_revision` -- bumped whenever a parent deletes something.
--                    The server compares it at session start and throws away
--                    the local space when it differs. Without this a parent
--                    could delete a memory and the toy would still remember it.
--
-- Memory is deliberately NOT scoped per personality: whichever character the
-- child talks to, it is the same child, so the same memories apply.
-- `source_personality_key` records where a memory came from for display only.

CREATE TABLE IF NOT EXISTS public.memories (
    memory_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    kind text NOT NULL DEFAULT 'fact',
    -- What the child actually said. Replaying this through VoiceMem's ingest()
    -- is exactly what produced the memory in the first place, so a rebuild is
    -- faithful and a delete is final.
    content text NOT NULL,
    -- What the toy answered. VoiceMem's left brain uses it to disambiguate the
    -- child's line and the right brain uses it for emotion attribution, so a
    -- replay without it would not reproduce the same memory.
    agent_reply text,
    source_personality_key text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memories_kind_check CHECK (kind IN ('fact', 'affect'))
);

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_source_personality_key_fkey
    FOREIGN KEY (source_personality_key) REFERENCES public.personalities(key) ON DELETE SET NULL;

-- Every read is "this child's memories, newest first".
CREATE INDEX IF NOT EXISTS memories_user_created_idx
    ON public.memories (user_id, created_at DESC);

-- The server re-syncs the mirror by content, so the same fact must not pile up.
CREATE UNIQUE INDEX IF NOT EXISTS memories_user_content_idx
    ON public.memories (user_id, md5(content));

ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;

-- Owner-scoped, following the api_keys policies in the base schema. Note this
-- is deliberately stricter than the wide-open "PUBLIC conversations" policy:
-- these rows are a child's personal facts.
CREATE POLICY "Users can view their own memories" ON public.memories
    FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete their own memories" ON public.memories
    FOR DELETE TO authenticated
    USING ((SELECT auth.uid()) = user_id);

GRANT SELECT, DELETE ON TABLE public.memories TO authenticated;
GRANT ALL ON TABLE public.memories TO service_role;

-- Bumped by the web app on delete; read by the voice server at session start.
ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS memories_revision integer NOT NULL DEFAULT 0;

-- Private bucket holding one tar.gz per user: an exact copy of that user's
-- VoiceMem space directory. Restoring the tarball is far cheaper than
-- rebuilding from `memories`, which re-runs fact extraction on every row.
--
-- Only the voice server (service_role) ever touches this, so no policies for
-- `authenticated` are granted -- service_role bypasses RLS on storage.objects.
INSERT INTO storage.buckets (id, name, public)
VALUES ('voicemem', 'voicemem', false)
ON CONFLICT (id) DO NOTHING;

-- Three things the admin page needs, none of which the schema has today.
--
-- 1. app_settings -- somewhere to put the site-wide LLM model, so changing it
--    is a form submit rather than an env edit + image rebuild + restart.
-- 2. turn_metrics -- somewhere to put per-turn STT/LLM/TTS timings. The
--    pipeline has had enable_metrics=True since it was written and has been
--    throwing every number away for want of a table to keep them in.
-- 3. personalities.is_hidden -- retiring a character without deleting the row,
--    because users.personality_id references it.
--
-- Deliberately NOT touched: personalities_provider_check. Rebuilding that
-- constraint is what dropped 'openrouter' in 20260901072000 and broke character
-- creation until 20260903090000 put it back. Nothing here needs it.


-- ── app_settings ─────────────────────────────────────────────────────────────
-- One row per setting group, value as jsonb so adding a knob is not a migration.

CREATE TABLE IF NOT EXISTS "public"."app_settings" (
    "key"        text PRIMARY KEY,
    "value"      jsonb NOT NULL DEFAULT '{}'::jsonb,
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    "updated_by" uuid REFERENCES "public"."users"("user_id") ON DELETE SET NULL
);

-- Seeded empty on purpose. An absent key means "use the server's env default",
-- so the row exists to be updated without ever having pinned a model that the
-- deployment did not choose.
INSERT INTO "public"."app_settings" ("key", "value")
VALUES ('voice_stack', '{}'::jsonb)
ON CONFLICT ("key") DO NOTHING;

ALTER TABLE "public"."app_settings" ENABLE ROW LEVEL SECURITY;

-- Read-only to signed-in users, writable only by the service role -- the same
-- split as `memories`. Every admin write goes through a server action.
-- Dropped first so a re-run is not a hard error. Everything else in this file
-- is already IF NOT EXISTS / ON CONFLICT; CREATE POLICY is the one statement
-- with no such form, and these migrations get applied by hand with psql where a
-- partial re-run is a real possibility (see scripts/supabase-migrate.sh).
DROP POLICY IF EXISTS "Signed-in users can read app settings" ON "public"."app_settings";
CREATE POLICY "Signed-in users can read app settings"
    ON "public"."app_settings" FOR SELECT TO "authenticated" USING (true);

GRANT SELECT ON TABLE "public"."app_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."app_settings" TO "service_role";


-- ── turn_metrics ─────────────────────────────────────────────────────────────
-- One row per conversational turn. Written by the voice server's observer,
-- best-effort: a failed insert must never be allowed to affect a session.
--
-- Every duration is milliseconds and nullable, because a turn can end early --
-- barge-in, a dropped socket, an LLM error -- and a half-measured turn is still
-- worth keeping. Reading these means tolerating nulls.

CREATE TABLE IF NOT EXISTS "public"."turn_metrics" (
    "turn_metric_id"    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "created_at"        timestamptz NOT NULL DEFAULT now(),
    "user_id"           uuid REFERENCES "public"."users"("user_id") ON DELETE SET NULL,
    "chat_group_id"     uuid,
    "turn_index"        integer NOT NULL DEFAULT 0,
    "transport"         text,
    "personality_key"   text,
    "stt_provider"      text,
    "llm_provider"      text,
    "tts_provider"      text,
    "llm_model"         text,
    -- user stopped speaking -> final transcript
    "stt_ms"            integer,
    -- final transcript -> first LLM token
    "llm_ttfb_ms"       integer,
    -- first LLM token -> last LLM token
    "llm_total_ms"      integer,
    -- first LLM token -> first audio out
    "tts_ttfb_ms"       integer,
    -- user stopped speaking -> first audio out. The number the child feels.
    "total_ms"          integer,
    "prompt_tokens"     integer,
    "completion_tokens" integer,
    "transcript_chars"  integer,
    "response_chars"    integer,
    "interrupted"       boolean NOT NULL DEFAULT false,
    -- Service-reported metrics (per-processor TTFB, TTS leading silence, token
    -- usage) exactly as pipecat emitted them, for when the wall-clock columns
    -- above disagree with what the vendor thinks it did.
    "detail"            jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS "turn_metrics_created_idx"
    ON "public"."turn_metrics" ("created_at" DESC);
-- The admin page's main question is "is this model faster than that one".
CREATE INDEX IF NOT EXISTS "turn_metrics_model_created_idx"
    ON "public"."turn_metrics" ("llm_model", "created_at" DESC);

ALTER TABLE "public"."turn_metrics" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Signed-in users can read turn metrics" ON "public"."turn_metrics";
CREATE POLICY "Signed-in users can read turn metrics"
    ON "public"."turn_metrics" FOR SELECT TO "authenticated" USING (true);

GRANT SELECT ON TABLE "public"."turn_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."turn_metrics" TO "service_role";


-- ── personalities.is_hidden ──────────────────────────────────────────────────
-- Retire a character without deleting it. users.personality_id is a FK with
-- ON DELETE SET DEFAULT, so deleting a row silently moves every child using it
-- back to the Elato default -- not something an admin should trigger by
-- tidying up a list.

ALTER TABLE "public"."personalities"
    ADD COLUMN IF NOT EXISTS "is_hidden" boolean NOT NULL DEFAULT false;

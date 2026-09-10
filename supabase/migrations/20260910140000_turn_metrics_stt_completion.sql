-- Record the moment STT finished, and the wait that follows it.
--
-- Two columns, both about the same blind spot. `stt_ms` ends at the final
-- transcript, and `llm_ttfb_ms` starts there -- so the gap between the
-- recognizer finishing and the LLM being allowed to start was invisible, and
-- counted against the model. On the push-to-talk path that gap is
-- ExternalUserTurnStopStrategy's transcript-merge timer: a flat 502ms on every
-- turn, measured 2026-09-10 against the real strategies.
--
-- `stt_done_at` is wall clock rather than a span because the pipeline clock
-- counts nanoseconds since the task started and means nothing once the row is
-- written. It is what lines the moment up against the conversation and the logs.

ALTER TABLE "public"."turn_metrics"
    ADD COLUMN IF NOT EXISTS "stt_done_at" timestamp with time zone,
    ADD COLUMN IF NOT EXISTS "turn_close_ms" integer;

COMMENT ON COLUMN "public"."turn_metrics"."stt_done_at" IS
    'Wall clock instant the final transcript for this turn was emitted.';
COMMENT ON COLUMN "public"."turn_metrics"."turn_close_ms" IS
    'Final transcript -> user turn closed. Dead time still counted inside llm_ttfb_ms.';

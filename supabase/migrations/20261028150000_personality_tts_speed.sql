-- Per-character MiniMax speech speed.
--
-- The voice server always asked MiniMax for speed 1.0. A storyteller for
-- three-year-olds wants to be slower than a quiz host, so the speed is part
-- of the character, edited on the admin page next to its voice ids.
--
-- 0.5-2.0 is MiniMax's own accepted range (t2a_v2 voice_setting.speed);
-- anything outside it is refused by the API, so it is refused here first.
-- 1.0 is what every session already used, so existing characters do not
-- change.
--
-- Apply before deploying the voice server that reads it: device_registry
-- selects the column by name, and PostgREST answers a select of a missing
-- column with an error.

ALTER TABLE public.personalities
ADD COLUMN IF NOT EXISTS tts_speed real NOT NULL DEFAULT 1.0;

ALTER TABLE public.personalities
DROP CONSTRAINT IF EXISTS personalities_tts_speed_range;

ALTER TABLE public.personalities
ADD CONSTRAINT personalities_tts_speed_range CHECK (tts_speed >= 0.5 AND tts_speed <= 2.0);

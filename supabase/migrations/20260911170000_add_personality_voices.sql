-- Per-character MiniMax voice ids, keyed by language_code.
--
-- personalities.oai_voice stays the English / default voice -- it is what the
-- web app already passes as `voice` on the browser websocket, and what every
-- existing character row holds. This map is the rest: a Cantonese session can
-- use Cantonese_CuteGirl for Pepa and Cantonese_PlayfulMan for Sherlock
-- instead of the one env-level fallback language_profiles.voice_for used to
-- give every character.
--
-- Absent keys mean "keep doing what we do today": oai_voice if it can speak
-- this language, otherwise MINIMAX_VOICE_* / the profile default.

ALTER TABLE public.personalities
ADD COLUMN IF NOT EXISTS voices jsonb NOT NULL DEFAULT '{}'::jsonb;

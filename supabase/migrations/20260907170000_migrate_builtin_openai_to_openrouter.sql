-- Move built-in (/home) OpenAI characters onto the OR + MX stack:
-- provider=openrouter (UI label "OR + MX") + MiniMax TTS voice ids in oai_voice.
-- User-created OpenAI personalities are left unchanged.

UPDATE personalities
SET oai_voice = CASE
  WHEN is_child_voice THEN 'Lively_Girl'
  WHEN lower(oai_voice) IN ('shimmer', 'sage') THEN 'Calm_Woman'
  WHEN lower(oai_voice) IN ('coral', 'ballad') THEN 'Wise_Woman'
  WHEN lower(oai_voice) IN ('alloy', 'echo') THEN 'Friendly_Person'
  WHEN lower(oai_voice) = 'ash' THEN 'Casual_Guy'
  WHEN lower(oai_voice) = 'verse' THEN 'Deep_Voice_Man'
  ELSE 'Friendly_Person'
END
WHERE creator_id IS NULL
  AND provider = 'openai';

UPDATE personalities
SET provider = 'openrouter'
WHERE creator_id IS NULL
  AND provider = 'openai';

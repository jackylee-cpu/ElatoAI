-- The boson migration rebuilt personalities_provider_check without 'openrouter',
-- which broke character creation for OpenRouter/MiniMax voices.
-- Allow the full provider set.
ALTER TABLE personalities
DROP CONSTRAINT IF EXISTS personalities_provider_check;

ALTER TABLE personalities
ADD CONSTRAINT personalities_provider_check
CHECK (provider IN ('openai', 'gemini', 'grok', 'elevenlabs', 'hume', 'openrouter', 'boson'));

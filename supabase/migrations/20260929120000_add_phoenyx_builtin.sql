-- Phoenyx, the language-learning pal, as a built-in character anyone can pick.
--
-- Phoenyx has always been what an unclaimed device talks to: with no device
-- row there is no character_prompt, and build_session_prompt falls back to
-- LANGUAGE_LEARNING_PAL_PROMPT in server/fastapi/character_prompt.py. It never
-- had a row here, so the web picker could not list it and a claimed device
-- could not be given it.
--
-- character_prompt is left empty on purpose. An empty prompt takes that same
-- fallback on both the device and the browser route, so this row is the exact
-- character an unclaimed device already gets, with the prompt kept in one place
-- (the server) instead of a copy here that drifts. Writing a prompt into this
-- row from the admin page turns it into an ordinary custom character.
--
-- Lively_Girl is a legacy MiniMax id, the voice most built-ins use; the column
-- default 'ash' is an OpenAI voice and would not speak. A Cantonese or Mandarin
-- account gets its language's voice instead, as with every other character.
--
-- No artwork of its own ships in /personality, so it borrows elato_default.
--
-- Deliberately NOT touched: personalities_provider_check, per the note in
-- 20260910120000.

INSERT INTO "public"."personalities" (
    "key",
    "title",
    "subtitle",
    "short_description",
    "character_prompt",
    "first_message_prompt",
    "provider",
    "oai_voice",
    "is_story",
    "is_child_voice",
    "is_doctor",
    "is_hidden",
    "image_url",
    "creator_id"
)
VALUES (
    'phoenyx',
    'Phoenyx',
    'Language-learning pal',
    'A warm, playful pal who helps kids learn Spanish one word at a time.',
    '',
    '',
    'openrouter',
    'Lively_Girl',
    false,
    true,
    false,
    false,
    '/personality/elato_default.jpeg',
    NULL
)
ON CONFLICT ("key") DO NOTHING;

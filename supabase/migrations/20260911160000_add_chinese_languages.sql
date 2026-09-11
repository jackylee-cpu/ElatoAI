-- Cantonese and Mandarin for the "Character's language" dropdown.
--
-- The dropdown reads this table and writes users.language_code, which the
-- voice server now resolves into a recognizer language, a MiniMax voice and a
-- prompt instruction (server/fastapi/language_profiles.py). Until this ran,
-- the table held only en-US, de-DE, es-AR and es-ES, so there was no way to
-- ask the toy for Chinese at all.
--
-- The codes matter, not just the labels: language_profiles keys on them, and
-- users.language_code is a foreign key onto languages.code.

INSERT INTO languages (code, name, flag)
VALUES
  ('zh-HK', 'Cantonese (Hong Kong)', '🇭🇰'),
  ('zh-CN', 'Mandarin (China)', '🇨🇳')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  flag = EXCLUDED.flag;

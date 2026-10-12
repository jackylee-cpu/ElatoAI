-- New accounts speak Cantonese.
--
-- A new account's language came from this column's default, 'en-US': the web
-- app's createUser() passed "en-US" but never wrote it, and the signed-in
-- client cannot -- authenticated holds INSERT on users only for the profile
-- columns (migration 20261007130000), and language_code is not one of them.
-- So every parent who signed up got English speech recognition, and a child's
-- Cantonese came back as English nonsense ("你好你叫咩名呀" -> "Nehoa Nekima
-- manga", 2026-10-12).
--
-- Only the default changes. Accounts that already exist keep what they have;
-- a parent changes it in Settings, or an admin with an UPDATE.
--
-- Re-runnable.

ALTER TABLE public.users ALTER COLUMN language_code SET DEFAULT 'zh-HK';

-- Retire the "doctor" identity inherited from upstream.
--
-- A parent became a "doctor" by writing user_type = 'doctor' into their own
-- users.user_info (unlocked by a passcode hard-coded in the web app), which
-- switched them to medical characters and a different home page. The web app
-- no longer has any of that, and nothing reads user_info any more -- so a
-- parent loses the right to write it. That was the last column in the
-- 20261007130000 grant kept only for this.
--
-- The medical characters (is_doctor: blood tests, epilepsy, vaccinations, and
-- upstream filed Santa Claus there too) are hidden, not deleted:
-- users.personality_id points at them, and is_hidden is what the admin page
-- already uses to retire a character. Any of them can be brought back there.
-- Only built-in rows: a parent's own character is theirs.
--
-- Apply only once the web app without the doctor code is live: the old one
-- still writes user_info when onboarding and settings save, and that whole
-- update would fail.
--
-- Re-runnable.

UPDATE public.personalities
SET is_hidden = true
WHERE is_doctor
  AND creator_id IS NULL
  AND NOT is_hidden;

REVOKE UPDATE (user_info) ON TABLE public.users FROM authenticated;

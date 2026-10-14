-- A board is sewn into one toy, and the toy decides who it is.
--
-- An IP is the identity of a physical toy: the rabbit plush is the rabbit IP.
-- Until this ran, the character was the account's (users.personality_id) and
-- every board on the account ran it, so a parent picking 波波熊 turned the
-- rabbit plush into a bear. Now:
--
--   devices.ip_key              which toy this board is inside. Set from the
--                               admin Devices page (later, by the factory).
--                               NULL = not locked: a dev board, or a board in
--                               no particular toy, which runs the account's
--                               character as before.
--   ips.default_personality_id  who a locked board is when the account's
--                               character belongs to another IP. NULL falls
--                               back to the IP's first visible character.
--
-- A locked board runs the account's character only if it is in the board's
-- IP, otherwise the IP's default (server/fastapi/device_registry.py). The
-- account keeps one character, so an account with a rabbit and a bear never
-- needs a choice stored per board: each board takes the account's pick when
-- it fits and its own default when it does not.
--
-- The parent cannot change a board's IP: owners may update only volume,
-- is_reset and is_ota (20261007130000). Until the admin Devices page can set
-- it, a super admin sets it in SQL.
--
-- Re-runnable.

ALTER TABLE public.ips
    ADD COLUMN IF NOT EXISTS default_personality_id uuid
    REFERENCES public.personalities (personality_id) ON DELETE SET NULL;

ALTER TABLE public.devices
    ADD COLUMN IF NOT EXISTS ip_key text
    REFERENCES public.ips (ip_key) ON UPDATE CASCADE;

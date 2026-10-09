-- One account, any number of devices.
--
-- Ownership was recorded twice: `devices.user_id` (what the voice server
-- resolves a board's account and character through) and `users.device_id`, a
-- UNIQUE pointer back to a single device. The second one is what limited an
-- account to one board -- claiming another overwrote it and unbinding either
-- cleared it -- and nothing outside the web app's settings page read it.
--
-- `devices.user_id` is already many-to-one, so it stays the only record of
-- ownership. Every device on an account shares the account's character, child
-- profile and memory.
--
-- Deploy the frontend that no longer reads `users.device_id` (it embedded the
-- device through `users_device_id_fkey`) BEFORE applying this: the old
-- frontend's user query fails once the constraint is gone. The new frontend
-- works against either schema.
--
-- Re-runnable.

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_device_id_fkey;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_device_id_key;
ALTER TABLE public.users DROP COLUMN IF EXISTS device_id;

-- The settings page now lists an account's devices.
CREATE INDEX IF NOT EXISTS devices_user_id_idx ON public.devices (user_id);

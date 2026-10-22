-- A board's "battery full", next to R-41's battery_* columns.
--
--   battery_full   the cell is charged: the charger has finished, or the cell
--                  reads near 100% without charging. Null when the board
--                  cannot tell, which is every board as of 2026-10-16: the
--                  Spotpear board as sold senses only "low" (its supply
--                  sagging), and firmware up to 1.1.0 never sends it.
--
-- battery_charging now means the same: null is "the board cannot tell", not
-- "not charging". The voice server writes both from {"type":"power"}
-- (server/fastapi/device_power.py) with the service role.
--
-- Parents read it through the existing owner SELECT on devices; authenticated
-- has no UPDATE on it (its column-level UPDATE covers volume, is_reset and
-- is_ota only), so a parent cannot forge it.
--
-- Re-runnable.

ALTER TABLE public.devices
    ADD COLUMN IF NOT EXISTS battery_full boolean;

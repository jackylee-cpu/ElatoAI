-- A board's battery state, for the app (R-41).
--
-- The voice server writes these with the service role when a board reports
-- {"type":"power"} (server/fastapi/device_power.py): once per session after
-- "auth", and again when the state changes. A toy is asleep most of the time,
-- so the app shows the last report and when it came.
--
--   battery_low       the board says the cell is nearly empty. The Spotpear
--                     board can say only this, from its supply voltage sagging.
--   battery_percent   0..100, from boards that can measure the cell; null on
--                     the Spotpear board until it gets a divider (R-16).
--   battery_charging  the charger's own output, where the board has one.
--   battery_at        when the voice server took the report.
--
-- All null means the board has never reported: no battery sense, or firmware
-- older than the report. The app shows no battery then.
--
-- Parents read these through the existing owner SELECT on devices.
-- authenticated keeps its column-level UPDATE grant on volume, is_reset and
-- is_ota only, so a parent cannot forge them.
--
-- Re-runnable.

ALTER TABLE public.devices
    ADD COLUMN IF NOT EXISTS battery_low boolean,
    ADD COLUMN IF NOT EXISTS battery_percent smallint
        CHECK (battery_percent BETWEEN 0 AND 100),
    ADD COLUMN IF NOT EXISTS battery_charging boolean,
    ADD COLUMN IF NOT EXISTS battery_at timestamptz;

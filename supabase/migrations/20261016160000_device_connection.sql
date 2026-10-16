-- Whether a board is connected and, if not, why it went: the app shows a toy
-- as online, asleep, probably out of battery, or offline.
--
-- The voice server writes these with the service role
-- (server/fastapi/device_connection.py):
--
--   connected_at       when the board's latest /ws/esp32 session started
--   disconnected_at    when it ended; null while it is still connected
--   disconnect_reason  why it ended:
--       sleep_idle, sleep_button, sleep_session_end
--                      the board said it was going to sleep
--       restart        the board said it was restarting ("Update now", reset)
--       lost           it closed without saying why: power, Wi-Fi, a crash.
--                      After a low battery report, most likely a flat cell
--       unknown        firmware that never says why (1.1.0 and older)
--       server_restart the voice server restarted while it was connected
--
-- All null: the board has not connected since this was deployed.
--
-- devices.last_seen_at is different: when the board last fetched a token, at
-- boot or once a day.
--
-- Parents read these through the existing owner SELECT on devices;
-- authenticated has no UPDATE on them (its column-level UPDATE covers volume,
-- is_reset and is_ota only), so a parent cannot forge them.
--
-- Re-runnable.

ALTER TABLE public.devices
    ADD COLUMN IF NOT EXISTS connected_at timestamptz,
    ADD COLUMN IF NOT EXISTS disconnected_at timestamptz,
    ADD COLUMN IF NOT EXISTS disconnect_reason text;

ALTER TABLE public.devices DROP CONSTRAINT IF EXISTS devices_disconnect_reason_check;
ALTER TABLE public.devices ADD CONSTRAINT devices_disconnect_reason_check CHECK (
    disconnect_reason IN (
        'sleep_idle', 'sleep_button', 'sleep_session_end', 'restart',
        'lost', 'unknown', 'server_restart'
    )
);

-- A board's saved Wi-Fi networks, for the app's Wi-Fi page (R-37).
--
-- The board sends {"type":"wifi_status"} after every "auth" and with the
-- answer to every change the app makes. The voice server keeps the latest in
-- memory, which a restart wipes and which is empty while the toy sleeps -- most
-- of the time. So it also records the report here, through
-- record_device_wifi() (server/fastapi/device_wifi.py), and the page reads
-- this row directly.
--
-- Names only, never passwords: those stay on the board.
--
--   current_ssid / current_rssi   the network it was on when it reported
--   saved                         [{"ssid": text, "joined": bool}, ...], at most 16
--   max_saved                     how many the board can hold
--   reported_at                   when the voice server took the report
--
-- No row means the board has never reported: asleep since it was claimed, or
-- firmware older than R-37, which sends nothing.
--
-- A board that changes hands loses its row (trigger below), so the next owner
-- does not see the last one's network names. The board reports again on its
-- next connect.
--
-- Parents read their own boards' rows; only the service role writes.
--
-- Re-runnable.

CREATE TABLE IF NOT EXISTS public.device_wifi (
    device_id    uuid PRIMARY KEY REFERENCES public.devices (device_id) ON DELETE CASCADE,
    current_ssid text CHECK (octet_length(current_ssid) BETWEEN 1 AND 32),
    current_rssi smallint,
    saved        jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(saved) = 'array'),
    max_saved    smallint,
    reported_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.device_wifi ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.device_wifi FROM anon, authenticated;
GRANT SELECT ON TABLE public.device_wifi TO authenticated;
GRANT ALL ON TABLE public.device_wifi TO service_role;

DROP POLICY IF EXISTS "Owners read their boards' Wi-Fi" ON public.device_wifi;
CREATE POLICY "Owners read their boards' Wi-Fi"
    ON public.device_wifi FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.devices AS d
         WHERE d.device_id = device_wifi.device_id
           AND d.user_id = (SELECT auth.uid())
    ));

-- The voice server knows a board by its MAC. Rows may hold it in either case
-- (device_registry matches the same way). Returns false when no board has
-- that MAC, so the caller can tell a write that went nowhere.
CREATE OR REPLACE FUNCTION public.record_device_wifi(
    p_mac          text,
    p_current_ssid text,
    p_current_rssi smallint,
    p_saved        jsonb,
    p_max_saved    smallint
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_device_id uuid;
BEGIN
    SELECT d.device_id INTO v_device_id
      FROM public.devices AS d
     WHERE d.mac_address ILIKE p_mac
     LIMIT 1;
    IF v_device_id IS NULL THEN
        RETURN false;
    END IF;

    INSERT INTO public.device_wifi AS w
           (device_id, current_ssid, current_rssi, saved, max_saved, reported_at)
    VALUES (v_device_id, p_current_ssid, p_current_rssi, coalesce(p_saved, '[]'::jsonb), p_max_saved, now())
    ON CONFLICT (device_id) DO UPDATE
       SET current_ssid = excluded.current_ssid,
           current_rssi = excluded.current_rssi,
           saved        = excluded.saved,
           max_saved    = excluded.max_saved,
           reported_at  = excluded.reported_at;
    RETURN true;
END;
$$;

-- Supabase grants EXECUTE on new functions in `public` to anon by default.
REVOKE ALL ON FUNCTION public.record_device_wifi(text, text, smallint, jsonb, smallint)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_device_wifi(text, text, smallint, jsonb, smallint)
    TO service_role;

-- ── a new owner starts with no list ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.device_wifi_forget_on_owner_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    DELETE FROM public.device_wifi WHERE device_id = NEW.device_id;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.device_wifi_forget_on_owner_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS devices_forget_wifi_on_owner_change ON public.devices;
CREATE TRIGGER devices_forget_wifi_on_owner_change
    AFTER UPDATE OF user_id ON public.devices
    FOR EACH ROW
    WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id)
    EXECUTE FUNCTION public.device_wifi_forget_on_owner_change();

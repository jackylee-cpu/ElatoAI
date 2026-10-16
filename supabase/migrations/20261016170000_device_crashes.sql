-- Crash reports from boards, for the admin Devices page.
--
-- After each "auth", a board that has crashed since its last acknowledged
-- report sends it; the voice server stores it here with the service role and
-- acknowledges it (server/fastapi/device_crash.py, firmware
-- src/CrashReport.cpp). One row per report:
--
--   report_id         random per crash; unique per board, so a report resent
--                     after a lost ack is stored once
--   crash_count       crashes since the board's last acknowledged report;
--                     the other columns describe the last of them
--   reason            panic | int_wdt | task_wdt | wdt | brownout
--   firmware_version  the image that crashed
--   pc, ra            where, to look up in that version's ELF
--                     (firmware-arduino/tools/decode_crash.py); null for a
--                     brownout, which leaves no note
--   uptime_s          seconds from boot to the crash
--   task, detail      the running task and the core's one-line reason
--   reported_at       when it reached the server, not when it happened
--
-- Nothing about the child or the conversation. Only super admins read it,
-- through admin_list_device_crashes(); parents and anon see nothing.
--
-- Re-runnable.

CREATE TABLE IF NOT EXISTS public.device_crashes (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id        uuid REFERENCES public.devices (device_id) ON DELETE CASCADE,
    mac_address      text NOT NULL,
    report_id        bigint NOT NULL,
    crash_count      integer NOT NULL CHECK (crash_count >= 1),
    reason           text NOT NULL
        CHECK (reason IN ('panic', 'int_wdt', 'task_wdt', 'wdt', 'brownout')),
    firmware_version text,
    pc               text,
    ra               text,
    uptime_s         integer,
    task             text,
    detail           text,
    reported_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (mac_address, report_id)
);

CREATE INDEX IF NOT EXISTS device_crashes_reported_at_idx
    ON public.device_crashes (reported_at DESC);

ALTER TABLE public.device_crashes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.device_crashes FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_list_device_crashes(p_days integer DEFAULT 30)
RETURNS TABLE (
    device_id        uuid,
    mac_address      text,
    crash_count      integer,
    reason           text,
    firmware_version text,
    pc               text,
    ra               text,
    uptime_s         integer,
    task             text,
    detail           text,
    reported_at      timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT public.has_role('super_admin') THEN
        RAISE EXCEPTION 'only a super admin can list crashes'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT c.device_id, c.mac_address, c.crash_count, c.reason, c.firmware_version,
           c.pc, c.ra, c.uptime_s, c.task, c.detail, c.reported_at
      FROM public.device_crashes AS c
     WHERE c.reported_at >= now() - make_interval(days => greatest(p_days, 1))
     ORDER BY c.reported_at DESC
     LIMIT 1000;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_device_crashes(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_device_crashes(integer) TO authenticated;

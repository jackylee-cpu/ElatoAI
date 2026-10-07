-- Firmware releases, and what each board says it is running (P0-13).
--
-- A board asks /api/ota/check on every boot, with its device token, its board
-- id and its version. If the current release for that board is a different
-- version, it downloads the image from /api/ota/firmware/<release_id>, which
-- reads it from the private `firmware` storage bucket. Nothing is public: the
-- image is only handed to a board with a live device token.
--
-- At most one release per board is current. Marking a release current is the
-- whole rollout; un-marking it stops further updates, but boards that already
-- took it keep it.
--
-- A board that boots a new image and cannot reach the voice server rolls back
-- by itself (firmware-arduino/src/OTA.cpp). It then reports that version as
-- failed, and is not offered it again -- otherwise it would download, roll
-- back and download again on every boot.
--
-- Releases are written with the service role (the release script). Super
-- admins may read them, for the admin page. Parents see their own board's
-- reported version through the existing owner SELECT on devices.

CREATE TABLE IF NOT EXISTS public.firmware_releases (
    release_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    board        text NOT NULL CHECK (board ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    version      text NOT NULL CHECK (version ~ '^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$'),
    storage_path text NOT NULL,
    sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes   integer NOT NULL CHECK (size_bytes > 0),
    notes        text,
    is_current   boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (board, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS firmware_releases_one_current
    ON public.firmware_releases (board) WHERE is_current;

ALTER TABLE public.firmware_releases ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.firmware_releases FROM anon, authenticated;
GRANT SELECT ON TABLE public.firmware_releases TO authenticated;
GRANT ALL ON TABLE public.firmware_releases TO service_role;

DROP POLICY IF EXISTS "Super admins read firmware releases" ON public.firmware_releases;
CREATE POLICY "Super admins read firmware releases"
    ON public.firmware_releases FOR SELECT TO authenticated
    USING (public.has_role('super_admin'));

-- What the board last reported. Written only by /api/ota/check (service role);
-- authenticated keeps its column-level UPDATE grant on volume, is_reset and
-- is_ota only, so a parent cannot forge these.
ALTER TABLE public.devices
    ADD COLUMN IF NOT EXISTS firmware_board text,
    ADD COLUMN IF NOT EXISTS firmware_version text,
    ADD COLUMN IF NOT EXISTS firmware_reported_at timestamptz,
    ADD COLUMN IF NOT EXISTS ota_failed_version text,
    ADD COLUMN IF NOT EXISTS ota_failed_at timestamptz;

-- Private bucket for the images. Only the service role reads it.
INSERT INTO storage.buckets (id, name, public)
VALUES ('firmware', 'firmware', false)
ON CONFLICT (id) DO NOTHING;

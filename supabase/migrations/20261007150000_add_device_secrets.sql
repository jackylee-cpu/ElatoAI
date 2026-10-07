-- Device secrets: what a board proves it is with, instead of its MAC.
--
-- Until this ran, /api/generate_auth_token handed a parent's session JWT,
-- with no expiry, to anyone who sent it a MAC address. Now a board gets a
-- random secret the first time it calls in, keeps it in NVS, and has to show
-- it to get anything back: its pairing code while unclaimed, or a device
-- token (24 hours, signed with DEVICE_JWT_SECRET, useless against PostgREST)
-- once claimed. Only the hash is stored.
--
-- Boards registered before this table existed have no row here. The first
-- request for such a device gets a secret issued (trust on first use), the
-- same as a brand-new board.
--
-- A board whose NVS is wiped can no longer prove itself. Deleting its row
-- here lets it be issued a new secret on its next call.
--
-- Nothing outside the service role may read or write this table: RLS is on
-- with no policies, and anon/authenticated hold no grants.

CREATE TABLE IF NOT EXISTS public.device_secrets (
    device_id uuid PRIMARY KEY
        REFERENCES public.devices(device_id) ON DELETE CASCADE,
    secret_hash text NOT NULL,
    issued_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.device_secrets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.device_secrets FROM anon, authenticated;
GRANT ALL ON TABLE public.device_secrets TO service_role;

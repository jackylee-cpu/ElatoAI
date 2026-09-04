-- Devices register themselves the first time they call generate_auth_token, so
-- the web app can list boards that are online but not yet bound to an account
-- and let the owner claim one in a click. Before this, a devices row had to be
-- inserted by hand.

ALTER TABLE public.devices
ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

ALTER TABLE public.devices
ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

-- The claim list only ever reads unbound rows ordered by recency.
CREATE INDEX IF NOT EXISTS devices_unclaimed_idx
    ON public.devices (last_seen_at DESC)
    WHERE user_id IS NULL;

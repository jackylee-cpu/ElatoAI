-- IPs, modes and styles: one product, many characters' worlds.
--
-- Until this ran, a character was one row in `personalities` and everything
-- else about a session was baked into its prompt: Phoenyx's prompt both says
-- who Phoenyx is and that the job is teaching Spanish. This splits a session
-- into four things that can change independently:
--
--   ip           whose world the character lives in. Owns the characters, any
--                hard limits a licensor sets (`guardrails`), its own flavour
--                for each mode, and optionally which modes and styles are
--                allowed. Memory is kept per IP: a child's
--                memories under one IP are never shown to another.
--   character    `personalities`, now each in exactly one IP.
--   mode         the task: companion, story, language. Owned by the platform,
--                because a mode is more than a prompt -- a story needs a place
--                in the story, a lesson needs progress.
--   style        a personality on top of the character: playful, gentle, silly.
--
-- Modes and styles are written in server/fastapi/content/*.yaml and reviewed
-- like code. The voice server reads its prompts from there and, on startup,
-- upserts the keys and names below so the web app can list them and the
-- foreign keys have something to point at. The rows inserted here are only the
-- seed for that, so a fresh database works before the server has ever run.
--
-- IPs and characters stay in the database, edited from the admin page.
--
-- Phase 1 has no locked IPs: every IP can be switched to, by picking one of its
-- characters. The IP is never stored on the account -- it is the character's
-- -- so the account's IP and its character cannot disagree.

-- ── ips ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ips (
    ip_key text PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    -- Hard limits for every character in this IP. Sits after the style and the
    -- mode in the system prompt, so a "silly" style cannot talk a character
    -- past what its owner allows.
    guardrails text NOT NULL DEFAULT '',
    -- Off: every mode / style is allowed, including ones added to the YAML
    -- later -- right for our own characters. On: only those listed in
    -- ip_modes / ip_styles, which is what a licensor signs off.
    restrict_modes boolean NOT NULL DEFAULT false,
    restrict_styles boolean NOT NULL DEFAULT false,
    image_url text,
    is_hidden boolean NOT NULL DEFAULT false,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.ips ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Enable read access for all users" ON public.ips;
CREATE POLICY "Enable read access for all users" ON public.ips
    FOR SELECT USING (true);

GRANT SELECT ON TABLE public.ips TO anon, authenticated;
GRANT ALL ON TABLE public.ips TO service_role;

-- Every character that exists today is one of ours.
INSERT INTO public.ips (ip_key, name, description, sort_order)
VALUES ('house', 'In-house', 'Our own characters.', 0)
ON CONFLICT (ip_key) DO NOTHING;

-- ── modes and styles ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.modes (
    mode_key text PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.styles (
    style_key text PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    sort_order integer NOT NULL DEFAULT 0
);

ALTER TABLE public.modes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.styles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Enable read access for all users" ON public.modes;
CREATE POLICY "Enable read access for all users" ON public.modes
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "Enable read access for all users" ON public.styles;
CREATE POLICY "Enable read access for all users" ON public.styles
    FOR SELECT USING (true);

GRANT SELECT ON TABLE public.modes TO anon, authenticated;
GRANT SELECT ON TABLE public.styles TO anon, authenticated;
GRANT ALL ON TABLE public.modes TO service_role;
GRANT ALL ON TABLE public.styles TO service_role;

-- Seed only. The YAML is the source; the server's startup sync overwrites
-- names and descriptions, so they are not repeated here.
INSERT INTO public.modes (mode_key, name, sort_order)
VALUES
    ('companion', 'Companion', 10),
    ('story', 'Storytelling', 20),
    ('language', 'Language learning', 30)
ON CONFLICT (mode_key) DO NOTHING;

INSERT INTO public.styles (style_key, name, sort_order)
VALUES
    ('playful', 'Playful', 10),
    ('gentle', 'Gentle', 20),
    ('silly', 'Silly', 30)
ON CONFLICT (style_key) DO NOTHING;

-- ── what each IP adds and allows ─────────────────────────────────────────────
--
-- An ip_modes row is the IP's own flavour for a mode. Only when the IP has
-- restrict_modes on is it also the allow list; otherwise a mode with no row
-- is allowed with no flavour. ip_styles is only an allow list, read only under
-- restrict_styles. Separate switches rather than "no rows means everything",
-- so an unrestricted IP can still flavour one mode without restricting itself
-- to it.

CREATE TABLE IF NOT EXISTS public.ip_modes (
    ip_key text NOT NULL REFERENCES public.ips (ip_key) ON UPDATE CASCADE ON DELETE CASCADE,
    mode_key text NOT NULL REFERENCES public.modes (mode_key) ON UPDATE CASCADE ON DELETE CASCADE,
    -- How this IP's characters do the mode, e.g. "tell stories set in the
    -- character's own neighbourhood". Added after the mode's own prompt.
    prompt text NOT NULL DEFAULT '',
    PRIMARY KEY (ip_key, mode_key)
);

CREATE TABLE IF NOT EXISTS public.ip_styles (
    ip_key text NOT NULL REFERENCES public.ips (ip_key) ON UPDATE CASCADE ON DELETE CASCADE,
    style_key text NOT NULL REFERENCES public.styles (style_key) ON UPDATE CASCADE ON DELETE CASCADE,
    PRIMARY KEY (ip_key, style_key)
);

ALTER TABLE public.ip_modes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ip_styles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Enable read access for all users" ON public.ip_modes;
CREATE POLICY "Enable read access for all users" ON public.ip_modes
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "Enable read access for all users" ON public.ip_styles;
CREATE POLICY "Enable read access for all users" ON public.ip_styles
    FOR SELECT USING (true);

GRANT SELECT ON TABLE public.ip_modes TO anon, authenticated;
GRANT SELECT ON TABLE public.ip_styles TO anon, authenticated;
GRANT ALL ON TABLE public.ip_modes TO service_role;
GRANT ALL ON TABLE public.ip_styles TO service_role;

-- ── characters belong to an IP ───────────────────────────────────────────────

ALTER TABLE public.personalities
    ADD COLUMN IF NOT EXISTS ip_key text NOT NULL DEFAULT 'house'
    REFERENCES public.ips (ip_key) ON UPDATE CASCADE;

-- ── the account's mode and style ─────────────────────────────────────────────
--
-- Beside personality_id, because that is where the character is chosen today:
-- an account has one device (users.device_id is unique) and the web
-- playground and the toy share the one choice. NULL means "not chosen", which
-- gives exactly the session every account had before this migration.

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS mode_key text
    REFERENCES public.modes (mode_key) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS style_key text
    REFERENCES public.styles (style_key) ON UPDATE CASCADE ON DELETE SET NULL;

-- ── memory is kept per IP ────────────────────────────────────────────────────
--
-- Everything remembered so far was remembered by an in-house character. The
-- forget-segments trigger on memory_facts needs no change: it matches on
-- chat_group_id, and one conversation is always in one IP.

ALTER TABLE public.memory_facts
    ADD COLUMN IF NOT EXISTS ip_key text NOT NULL DEFAULT 'house'
    REFERENCES public.ips (ip_key) ON UPDATE CASCADE;

ALTER TABLE public.memory_segments
    ADD COLUMN IF NOT EXISTS ip_key text NOT NULL DEFAULT 'house'
    REFERENCES public.ips (ip_key) ON UPDATE CASCADE;

ALTER TABLE public.conversations
    ADD COLUMN IF NOT EXISTS ip_key text NOT NULL DEFAULT 'house'
    REFERENCES public.ips (ip_key) ON UPDATE CASCADE;

-- Every read is now (user_id, ip_key), newest first.
DROP INDEX IF EXISTS public.memory_facts_user_active_idx;
CREATE INDEX IF NOT EXISTS memory_facts_user_ip_active_idx
    ON public.memory_facts (user_id, ip_key, created_at DESC)
    WHERE superseded_at IS NULL;

DROP INDEX IF EXISTS public.memory_segments_user_created_idx;
CREATE INDEX IF NOT EXISTS memory_segments_user_ip_created_idx
    ON public.memory_segments (user_id, ip_key, created_at DESC);

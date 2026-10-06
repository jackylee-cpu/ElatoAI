-- Where the child lives, for the date, time and weather in the system prompt.
--
-- The voice server writes the local date, time and current weather into every
-- session's system instruction (server/fastapi/world_context.py) so the
-- character can answer "what time is it?" and "is it raining?". Until this
-- ran, the place was one server-wide setting in .env, so every family heard
-- Hong Kong's clock and weather.
--
-- The list lives in a table, like `languages`, rather than in code: the web
-- app's "Where you live" dropdown reads it and the voice server joins it onto
-- the account, so both sides always agree on what a code means and adding a
-- city is one INSERT, no deploy.
--
-- users.region_code is nullable and has no default. NULL means "not chosen",
-- and the server falls back to its .env place (LOCAL_TIMEZONE / WEATHER_*),
-- which is what every existing account got before this migration.

CREATE TABLE IF NOT EXISTS public.regions (
  code text PRIMARY KEY,
  name text NOT NULL,
  flag text NOT NULL,
  -- IANA name, e.g. Asia/Hong_Kong. Python's zoneinfo resolves it; a bad one
  -- makes the server fall back to UTC and log a warning, never fail a session.
  timezone text NOT NULL,
  -- Where the weather is looked up (Open-Meteo, by coordinates).
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);

ALTER TABLE public.regions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Enable read access for all users" ON public.regions;
CREATE POLICY "Enable read access for all users" ON public.regions
  FOR SELECT USING (true);

GRANT SELECT ON TABLE public.regions TO anon, authenticated;
GRANT ALL ON TABLE public.regions TO service_role;

INSERT INTO public.regions (code, name, flag, timezone, latitude, longitude, sort_order)
VALUES
  ('hong-kong',    'Hong Kong',    '🇭🇰', 'Asia/Hong_Kong',      22.3193,  114.1694,  10),
  ('macau',        'Macau',        '🇲🇴', 'Asia/Macau',          22.1987,  113.5439,  20),
  ('shenzhen',     'Shenzhen',     '🇨🇳', 'Asia/Shanghai',       22.5431,  114.0579,  30),
  ('guangzhou',    'Guangzhou',    '🇨🇳', 'Asia/Shanghai',       23.1291,  113.2644,  40),
  ('shanghai',     'Shanghai',     '🇨🇳', 'Asia/Shanghai',       31.2304,  121.4737,  50),
  ('beijing',      'Beijing',      '🇨🇳', 'Asia/Shanghai',       39.9042,  116.4074,  60),
  ('taipei',       'Taipei',       '🇹🇼', 'Asia/Taipei',         25.0330,  121.5654,  70),
  ('singapore',    'Singapore',    '🇸🇬', 'Asia/Singapore',       1.3521,  103.8198,  80),
  ('kuala-lumpur', 'Kuala Lumpur', '🇲🇾', 'Asia/Kuala_Lumpur',    3.1390,  101.6869,  90),
  ('tokyo',        'Tokyo',        '🇯🇵', 'Asia/Tokyo',          35.6762,  139.6503, 100),
  ('seoul',        'Seoul',        '🇰🇷', 'Asia/Seoul',          37.5665,  126.9780, 110),
  ('sydney',       'Sydney',       '🇦🇺', 'Australia/Sydney',   -33.8688,  151.2093, 120),
  ('london',       'London',       '🇬🇧', 'Europe/London',       51.5074,   -0.1278, 130),
  ('berlin',       'Berlin',       '🇩🇪', 'Europe/Berlin',       52.5200,   13.4050, 140),
  ('madrid',       'Madrid',       '🇪🇸', 'Europe/Madrid',       40.4168,   -3.7038, 150),
  ('new-york',     'New York',     '🇺🇸', 'America/New_York',    40.7128,  -74.0060, 160),
  ('los-angeles',  'Los Angeles',  '🇺🇸', 'America/Los_Angeles', 34.0522, -118.2437, 170),
  ('toronto',      'Toronto',      '🇨🇦', 'America/Toronto',     43.6532,  -79.3832, 180),
  ('vancouver',    'Vancouver',    '🇨🇦', 'America/Vancouver',   49.2827, -123.1207, 190),
  ('buenos-aires', 'Buenos Aires', '🇦🇷', 'America/Argentina/Buenos_Aires', -34.6037, -58.3816, 200)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  flag = EXCLUDED.flag,
  timezone = EXCLUDED.timezone,
  latitude = EXCLUDED.latitude,
  longitude = EXCLUDED.longitude,
  sort_order = EXCLUDED.sort_order;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS region_code text
  REFERENCES public.regions (code) ON UPDATE CASCADE ON DELETE SET NULL;

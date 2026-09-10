"""Site-wide voice settings, read from Supabase instead of the environment.

The LLM model used to live only in OPENROUTER_MODEL, which meant changing it
was an env edit, an image rebuild and a restart. It lives in the
`app_settings` table now, under the key `voice_stack`, so the admin page can
change it with a form submit.

Env is not replaced, it is the floor. A key absent from the row means "whatever
the server was started with", so a deployment that never opens the admin page
behaves exactly as it did before this module existed. Precedence, per setting:

    app_settings.voice_stack  ->  environment  ->  the provider's own default

Like `device_registry`, everything here fails open. A slow or missing database
yields {} and the caller falls back to env; it must never be the reason a child
gets silence.
"""

from __future__ import annotations

import os
import time

import aiohttp
from loguru import logger

# Read lazily, never captured at import time. bot.py calls load_dotenv() in its
# module body, which runs *after* its own import block -- so anything this
# module resolves at import time sees the environment as it was before .env was
# loaded, i.e. empty. That failure is invisible: configured() returns False,
# every lookup fails open, and the admin page's model setting is silently
# ignored for the life of the process. device_registry.py gets away with the
# same pattern only because server.py happens to import it after `from bot
# import ...` has triggered load_dotenv.


def _supabase_url() -> str:
    return os.getenv("SUPABASE_URL", "").rstrip("/")


def _service_role_key() -> str:
    # Service role: this read happens on behalf of the server itself, before any
    # user is known, so it has to bypass RLS.
    return os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")


def _lookup_timeout() -> float:
    # This read is on the "toy is slow to wake up" path -- it runs before the
    # first audio frame -- so it gets the same short budget as the device lookup.
    return float(os.getenv("APP_SETTINGS_TIMEOUT", "3"))


def _cache_ttl() -> float:
    # Long enough that a busy server is not re-reading one row per connection,
    # short enough that an admin who changes the model and reconnects sees it
    # even if the cache-busting call in /internal/settings_refresh never
    # arrives.
    return float(os.getenv("APP_SETTINGS_CACHE_TTL", "30"))

SETTINGS_KEY = "voice_stack"

_cache: dict | None = None
_cache_expires_at: float = 0.0


def configured() -> bool:
    """Is there a Supabase to read from?

    Mirrors memory/store.py: an unedited `your_...` placeholder is a non-empty
    string that 401s on every request, so it has to count as unset rather than
    as a value.
    """
    key = _service_role_key().strip()
    return bool(_supabase_url() and key and not key.lower().startswith("your_"))


def invalidate_cache() -> None:
    """Drop the cached row so the next read goes to the database.

    Called by /internal/settings_refresh, which the web app hits right after
    saving, so a change is live on the next connection rather than up to
    CACHE_TTL_SECONDS later.
    """
    global _cache, _cache_expires_at
    _cache = None
    _cache_expires_at = 0.0


async def fetch_voice_settings() -> dict:
    """The `voice_stack` settings row, or {} if there isn't one to be had.

    {} is returned for every failure mode -- no Supabase configured, timeout,
    non-200, malformed value -- because every one of them means the same thing
    to the caller: use the environment.
    """
    global _cache, _cache_expires_at

    now = time.monotonic()
    if _cache is not None and now < _cache_expires_at:
        return _cache

    settings = await _read_settings()

    _cache = settings
    _cache_expires_at = now + _cache_ttl()
    return settings


async def _read_settings() -> dict:
    if not configured():
        return {}

    key = _service_role_key()
    url = (
        f"{_supabase_url()}/rest/v1/app_settings"
        f"?key=eq.{SETTINGS_KEY}&select=value&limit=1"
    )
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }

    try:
        timeout = aiohttp.ClientTimeout(total=_lookup_timeout())
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=headers) as response:
                if response.status != 200:
                    body = (await response.text())[:200]
                    logger.warning(
                        "Reading app settings failed: HTTP {} {}", response.status, body
                    )
                    return {}
                rows = await response.json()
    except Exception as exc:  # noqa: BLE001 - a settings read must never raise
        logger.warning("Reading app settings errored: {}", exc)
        return {}

    return parse_rows(rows)


def parse_rows(rows: object) -> dict:
    """Turn a PostgREST response into a settings dict, or {} if it isn't one."""
    if not isinstance(rows, list) or not rows:
        return {}
    first = rows[0]
    if not isinstance(first, dict):
        return {}
    value = first.get("value")
    if not isinstance(value, dict):
        return {}

    # Empty strings are what a cleared form field sends, and they are not a
    # model name. Drop them here so callers can use a plain `or` fallback and
    # land on the environment default rather than on "".
    return {
        key: val
        for key, val in value.items()
        if not (isinstance(val, str) and not val.strip())
    }

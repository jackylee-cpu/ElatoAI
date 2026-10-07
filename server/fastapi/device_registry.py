"""Look up a device's assigned personality in Supabase, keyed by MAC address.

The ESP32 sends its MAC in the `X-Device-Mac` header on every websocket
connection. The browser route gets its character from query params the web app
builds out of the personality the user picked; the device has no such channel,
so it resolves the same data server-side:

    devices.mac_address -> devices.user_id -> users.personality_id -> personalities

Everything here fails open. A device that is unknown, a Supabase that is down,
or a misconfigured key all fall back to the built-in defaults rather than
refusing the session -- a toy that goes silent because a database was slow is
worse than one running the default character.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import quote

import aiohttp
from loguru import logger

import language_profiles
from world_context import Region

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
# The service role key bypasses RLS, which is what we want: this lookup runs
# on behalf of the device, not of a logged-in user.
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
# Keep this short. It runs before the first audio frame, so a slow database
# shows up to the user as the toy being slow to wake up.
LOOKUP_TIMEOUT_SECONDS = float(os.getenv("DEVICE_LOOKUP_TIMEOUT", "3"))

# `oai_voice` is the field the web app passes as `voice` on the browser route,
# so the device resolves the same column and the two transports stay in sync.
# `voices` is the per-language map the admin page writes; the browser sends
# it as a query param, the toy has to load it here.
#
# `user_id` and the child's own fields are pulled for long-term memory: the
# memory store is keyed by user_id, and the child profile goes into the system
# prompt the way the Deno route already does it (server/deno/supabase.ts:96).
_SELECT = (
    "volume,"
    "user_id,"
    "user:user_id("
    "supervisee_name,supervisee_age,supervisee_persona,language_code,"
    "memories_revision,"
    "region:region_code(name,timezone,latitude,longitude),"
    "personality:personality_id("
    "key,title,character_prompt,voice_prompt,oai_voice,voices"
    ")"
    ")"
)

# The browser route already carries its character on the query string, so the
# account lookup only needs the child's own fields. Same names as the nested
# `user(...)` above so both rows can go through `_parse`.
_USER_SELECT = (
    "supervisee_name,supervisee_age,supervisee_persona,language_code,memories_revision,"
    "region:region_code(name,timezone,latitude,longitude)"
)


@dataclass(frozen=True)
class DevicePersonality:
    title: str | None = None
    character_prompt: str | None = None
    voice_prompt: str | None = None
    tts_voice: str | None = None
    tts_voices: dict[str, str] | None = None
    volume: int | None = None
    # Identity and child profile. All optional: a device that cannot be
    # resolved still gets a session, just without memory or personalisation.
    user_id: str | None = None
    personality_key: str | None = None
    child_name: str | None = None
    child_age: int | None = None
    child_persona: str | None = None
    language_code: str | None = None
    memories_revision: int = 0
    # Where the child lives, for the date, time and weather in the prompt.
    # None when the account has not chosen one; world_context falls back to
    # the server's own place.
    region: Region | None = None


def _clean(value: object) -> str | None:
    """Normalise a PostgREST field to a non-empty string, or None."""
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _int_or(value: object, default: int | None = None) -> int | None:
    """PostgREST integers arrive as ints, but a null or a string must not crash."""
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    return value


def _parse_region(value: object) -> Region | None:
    """The embedded `regions` row, or None if unset or malformed."""
    if not isinstance(value, dict):
        return None
    name = _clean(value.get("name"))
    tz = _clean(value.get("timezone"))
    lat, lon = value.get("latitude"), value.get("longitude")
    if not name or not tz or not all(
        isinstance(v, (int, float)) and not isinstance(v, bool) for v in (lat, lon)
    ):
        logger.warning("Ignoring incomplete region {}", value)
        return None
    return Region(name=name, timezone=tz, latitude=float(lat), longitude=float(lon))


def _parse(row: dict) -> DevicePersonality:
    user = row.get("user") or {}
    personality = user.get("personality") or {}

    volume = row.get("volume")
    if isinstance(volume, bool) or not isinstance(volume, int):
        volume = None
    elif not 0 <= volume <= 100:
        logger.warning("Device volume {} out of range, ignoring", volume)
        volume = None

    age = _int_or(user.get("supervisee_age"))
    if age is not None and not 1 <= age <= 18:
        logger.warning("Supervisee age {} out of range, ignoring", age)
        age = None

    return DevicePersonality(
        title=_clean(personality.get("title")),
        character_prompt=_clean(personality.get("character_prompt")),
        voice_prompt=_clean(personality.get("voice_prompt")),
        tts_voice=_clean(personality.get("oai_voice")),
        tts_voices=language_profiles.parse_voices(personality.get("voices")),
        volume=volume,
        user_id=_clean(row.get("user_id")),
        personality_key=_clean(personality.get("key")),
        child_name=_clean(user.get("supervisee_name")),
        child_age=age,
        child_persona=_clean(user.get("supervisee_persona")),
        language_code=_clean(user.get("language_code")),
        memories_revision=_int_or(user.get("memories_revision"), 0) or 0,
        region=_parse_region(user.get("region")),
    )


async def _fetch_rows(url: str, what: str) -> list[dict]:
    """GET a PostgREST url, failing open to no rows on any error.

    Every caller here would rather run on defaults than refuse a session, so a
    down database or a bad key is a warning, not an exception.
    """
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Accept": "application/json",
    }
    try:
        timeout = aiohttp.ClientTimeout(total=LOOKUP_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=headers) as response:
                if response.status != 200:
                    body = (await response.text())[:200]
                    logger.warning(
                        "Lookup for {} failed: HTTP {} {}", what, response.status, body
                    )
                    return []
                return await response.json()
    except Exception as exc:  # noqa: BLE001 - fail open on any transport error
        logger.warning("Lookup for {} errored: {}", what, exc)
        return []


def _supabase_configured(what: str) -> bool:
    if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
        return True
    logger.debug(
        "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set, skipping {} lookup", what
    )
    return False


async def fetch_device_personality(mac_address: str | None) -> DevicePersonality:
    """Resolve the personality assigned to `mac_address`.

    Returns an empty DevicePersonality (all fields None) whenever the device
    cannot be resolved, which leaves every caller on its existing defaults.
    """
    if not mac_address:
        return DevicePersonality()

    if not _supabase_configured("device personality"):
        return DevicePersonality()

    # Devices report the MAC uppercased; rows may have been written in either
    # case, so match case-insensitively. MAC addresses contain no LIKE
    # wildcards, so `ilike` is safe here.
    url = (
        f"{SUPABASE_URL}/rest/v1/devices"
        f"?mac_address=ilike.{quote(mac_address, safe='')}"
        f"&select={quote(_SELECT, safe='()*,:')}"
        f"&limit=1"
    )
    rows = await _fetch_rows(url, f"device {mac_address}")

    if not rows:
        logger.info("No device row for mac={}, using default character", mac_address)
        return DevicePersonality()

    personality = _parse(rows[0])
    logger.info(
        "Device {} resolved to character={} voice={} volume={} user={}",
        mac_address,
        personality.title or "default",
        personality.tts_voice or "default",
        personality.volume if personality.volume is not None else "default",
        personality.user_id or "unknown",
    )
    return personality


async def fetch_user_personality(user_id: str | None) -> DevicePersonality:
    """Resolve a logged-in account's child profile, for the browser route.

    The web app already passes the character it picked on the query string, so
    only the child's own fields and `memories_revision` matter here -- but the
    same row feeds the same `_parse`, so the browser and the toy build the
    child profile from one code path instead of two that can drift.
    """
    if not user_id:
        return DevicePersonality()

    if not _supabase_configured("user profile"):
        return DevicePersonality()

    url = (
        f"{SUPABASE_URL}/rest/v1/users"
        f"?user_id=eq.{quote(user_id, safe='')}"
        f"&select={quote(_USER_SELECT, safe='()*,:')}"
        f"&limit=1"
    )
    rows = await _fetch_rows(url, f"user {user_id}")

    if not rows:
        logger.info("No user row for {}, running without memory", user_id)
        return DevicePersonality()

    # `_parse` reads the child's fields out of a nested `user` object, which is
    # how they arrive on the device query. Shape the flat row to match rather
    # than duplicating the parsing.
    personality = _parse({"user_id": user_id, "user": rows[0]})
    logger.info(
        "User {} resolved to child={} revision={}",
        user_id,
        personality.child_name or "unknown",
        personality.memories_revision,
    )
    return personality

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

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
# The service role key bypasses RLS, which is what we want: this lookup runs
# on behalf of the device, not of a logged-in user.
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
# Keep this short. It runs before the first audio frame, so a slow database
# shows up to the user as the toy being slow to wake up.
LOOKUP_TIMEOUT_SECONDS = float(os.getenv("DEVICE_LOOKUP_TIMEOUT", "3"))

# `oai_voice` is the field the web app passes as `voice` on the browser route,
# so the device resolves the same column and the two transports stay in sync.
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
    "personality:personality_id("
    "key,title,character_prompt,voice_prompt,oai_voice"
    ")"
    ")"
)


@dataclass(frozen=True)
class DevicePersonality:
    title: str | None = None
    character_prompt: str | None = None
    voice_prompt: str | None = None
    tts_voice: str | None = None
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
        volume=volume,
        user_id=_clean(row.get("user_id")),
        personality_key=_clean(personality.get("key")),
        child_name=_clean(user.get("supervisee_name")),
        child_age=age,
        child_persona=_clean(user.get("supervisee_persona")),
        language_code=_clean(user.get("language_code")),
        memories_revision=_int_or(user.get("memories_revision"), 0) or 0,
    )


async def fetch_device_personality(mac_address: str | None) -> DevicePersonality:
    """Resolve the personality assigned to `mac_address`.

    Returns an empty DevicePersonality (all fields None) whenever the device
    cannot be resolved, which leaves every caller on its existing defaults.
    """
    if not mac_address:
        return DevicePersonality()

    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        logger.debug(
            "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set, "
            "skipping device personality lookup"
        )
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
                        "Device lookup for {} failed: HTTP {} {}",
                        mac_address,
                        response.status,
                        body,
                    )
                    return DevicePersonality()
                rows = await response.json()
    except Exception as exc:  # noqa: BLE001 - fail open on any transport error
        logger.warning("Device lookup for {} errored: {}", mac_address, exc)
        return DevicePersonality()

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

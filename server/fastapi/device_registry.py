"""Look up a device's assigned personality in Supabase, keyed by MAC address.

The ESP32 sends its MAC in the `X-Device-Mac` header on every websocket
connection. The browser route gets its character from query params the web app
builds out of the personality the user picked; the device has no such channel,
so it resolves the same data server-side:

    devices.mac_address -> devices.user_id -> users.personality_id -> personalities

unless the board is locked into a toy (devices.ip_key), whose IP the character
must belong to (_board_character).

Everything here fails open. A device that is unknown, a Supabase that is down,
or a misconfigured key all fall back to the built-in defaults rather than
refusing the session -- a toy that goes silent because a database was slow is
worse than one running the default character.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, replace
from urllib.parse import quote

import aiohttp
from loguru import logger

import language_profiles
import session_content
from session_content import IpRules
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
# `user_id` and the device's `memories_revision` are pulled for long-term
# memory, which is keyed by account and device; the revision is how many times
# the device's memory has been cleared (memory/store._stamp). The child profile
# goes into the system prompt (character_prompt.build_child_block).
#
# The character's IP comes along with it: its guardrails and the modes and
# styles it allows shape the prompt, and its key decides whose memories load.
_IP_SELECT = (
    "ip:ip_key(ip_key,guardrails,restrict_modes,restrict_styles,"
    "ip_modes(mode_key,prompt),ip_styles(style_key))"
)

_CHARACTER_FIELDS = (
    "key,title,character_prompt,first_message_prompt,oai_voice,voices,"
    f"mode_key,style_key,{_IP_SELECT}"
)

# One account and its character, the same for the toy and the browser: both
# resolve the character the parent picked from the account row, so the two can
# never disagree, and nothing about the character is taken from the client.
_ACCOUNT_SELECT = (
    "supervisee_name,supervisee_age,supervisee_persona,language_code,"
    "region:region_code(name,timezone,latitude,longitude),"
    f"personality:personality_id({_CHARACTER_FIELDS})"
)

# The toy the board is sewn into, if it has been set, and who that toy is when
# the account's character belongs to another toy (see _board_character).
_TOY_SELECT = (
    f"toy:ip_key(ip_key,default_character:default_personality_id({_CHARACTER_FIELDS}))"
)

_SELECT = (
    f"volume,user_id,memories_revision,{_TOY_SELECT},user:user_id({_ACCOUNT_SELECT})"
)


@dataclass(frozen=True)
class DevicePersonality:
    title: str | None = None
    character_prompt: str | None = None
    # How the character opens a browser session. The toy keeps the bot's own
    # greeting, as it always has.
    first_message_prompt: str | None = None
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
    # The device's memory revision. 0 on the browser route, which has no
    # device and no memory.
    memories_revision: int = 0
    # Whether the device row has an owner. None when that is unknown -- the
    # lookup failed, or this is the browser route, which has no device -- and
    # only False means the board is unclaimed.
    claimed: bool | None = None
    # Where the child lives, for the date, time and weather in the prompt.
    # None when the account has not chosen one; world_context falls back to
    # the server's own place.
    region: Region | None = None
    # What the character is doing and in what manner, as its author set it on
    # the admin page. None means none, which leaves that block out.
    mode_key: str | None = None
    style_key: str | None = None
    # The character's IP. None when it could not be read, which is not the
    # same as the default IP: memory stays off rather than risk loading
    # another IP's memories into this character.
    ip: IpRules | None = None


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
        first_message_prompt=_clean(personality.get("first_message_prompt")),
        tts_voice=_clean(personality.get("oai_voice")),
        tts_voices=language_profiles.parse_voices(personality.get("voices")),
        volume=volume,
        user_id=_clean(row.get("user_id")),
        personality_key=_clean(personality.get("key")),
        child_name=_clean(user.get("supervisee_name")),
        child_age=age,
        child_persona=_clean(user.get("supervisee_persona")),
        language_code=_clean(user.get("language_code")),
        memories_revision=_int_or(row.get("memories_revision"), 0) or 0,
        region=_parse_region(user.get("region")),
        mode_key=_clean(personality.get("mode_key")),
        style_key=_clean(personality.get("style_key")),
        ip=_parse_ip(personality),
    )


def _parse_ip(personality: dict) -> IpRules | None:
    """The character's IP, or the default IP when there is no character.

    No character is the built-in pal, which an unclaimed device and the
    browser's default both get, and the built-in pal is an in-house character.
    A character whose IP did not come back is a different case and stays None.
    """
    if not personality:
        return session_content.DEFAULT_IP
    ip = session_content.parse_ip_rules(personality.get("ip"))
    if ip is None:
        logger.warning(
            "Character {} came back without its IP", personality.get("key") or "unknown"
        )
    return ip


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


def _ip_key_of(character: object) -> str | None:
    if not isinstance(character, dict):
        return None
    ip = character.get("ip")
    return _clean(ip.get("ip_key")) if isinstance(ip, dict) else None


def _toy_key(row: dict) -> str | None:
    """The IP of the toy this board is in, or None when it is not locked."""
    toy = row.get("toy")
    return _clean(toy.get("ip_key")) if isinstance(toy, dict) else None


async def _first_character_in(ip_key: str) -> dict | None:
    """The IP's first visible character, for a toy with no default set."""
    url = (
        f"{SUPABASE_URL}/rest/v1/personalities"
        f"?ip_key=eq.{quote(ip_key, safe='')}"
        f"&is_hidden=not.is.true"
        f"&select={quote(_CHARACTER_FIELDS, safe='()*,:')}"
        f"&order=created_at.asc&limit=1"
    )
    rows = await _fetch_rows(url, f"characters of IP {ip_key}")
    return rows[0] if rows else None


async def _board_character(row: dict, mac_address: str) -> dict:
    """The device row, with the character this board may actually run.

    A board in a toy is that toy (an IP is one physical toy): the rabbit plush
    never runs 波波熊, whatever the account picked. The account's character
    stays when it belongs to the toy's IP. Otherwise the toy's default
    character, then its first visible one. A toy IP with no character at all
    is a setup mistake, and gets the built-in pal rather than another toy's
    animal.
    """
    toy_key = _toy_key(row)
    if not toy_key:
        return row
    user = row.get("user") if isinstance(row.get("user"), dict) else {}
    picked = user.get("personality")
    if _ip_key_of(picked) == toy_key:
        return row

    default = (row.get("toy") or {}).get("default_character")
    # A default that has since moved to another IP is not this toy any more.
    character = default if _ip_key_of(default) == toy_key else None
    if character is None:
        character = await _first_character_in(toy_key)
    if character is None or _ip_key_of(character) != toy_key:
        logger.warning(
            "Device {} is in toy {}, which has no character; using the built-in pal",
            mac_address,
            toy_key,
        )
        character = None
    else:
        logger.info(
            "Device {} is in toy {}: running {} instead of the account's {}",
            mac_address,
            toy_key,
            character.get("key") or "unknown",
            (picked or {}).get("key") or "default",
        )
    return {**row, "user": {**user, "personality": character}}


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

    row = await _board_character(rows[0], mac_address)
    personality = replace(_parse(row), claimed=bool(_clean(row.get("user_id"))))
    logger.info(
        "Device {} resolved to character={} ip={} mode={} style={} voice={} volume={} user={}",
        mac_address,
        personality.title or "default",
        personality.ip.ip_key if personality.ip else "unknown",
        personality.mode_key or "none",
        personality.style_key or "none",
        personality.tts_voice or "default",
        personality.volume if personality.volume is not None else "default",
        personality.user_id or "unknown",
    )
    return personality


async def fetch_user_personality(user_id: str | None) -> DevicePersonality:
    """Resolve a signed-in account's child profile and character, for the browser route.

    `user_id` comes from a verified web voice token (device_auth.verify_web).
    The character is the one on the account -- picking one in the web app
    saves it there first -- read through the same select and `_parse` as the
    toy's, so the browser and the toy build a session from one code path.
    """
    if not user_id:
        return DevicePersonality()

    if not _supabase_configured("user profile"):
        return DevicePersonality()

    url = (
        f"{SUPABASE_URL}/rest/v1/users"
        f"?user_id=eq.{quote(user_id, safe='')}"
        f"&select={quote(_ACCOUNT_SELECT, safe='()*,:')}"
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
    # Whether the child has a name on file, never the name (P1-02).
    logger.info(
        "User {} resolved to character={} ip={} child_named={}",
        user_id,
        personality.title or "default",
        personality.ip.ip_key if personality.ip else "unknown",
        bool(personality.child_name),
    )
    return personality

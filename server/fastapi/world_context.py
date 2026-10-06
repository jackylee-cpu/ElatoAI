"""The date, time and weather where the toy is, for the system prompt.

Without this the model has no clock at all: asked "what time is it?" it either
refuses or invents one, and a character that says "good morning" at bedtime is
the kind of thing a child notices.

Where the toy is comes from the account's `region_code` -- the "Where you
live" dropdown in Settings, backed by the `regions` table. An account that has
not picked one gets the server's own place, from `LOCAL_TIMEZONE` and the
`WEATHER_*` variables in env.example, which is what every account got before
the dropdown existed.

The block is written once, when the session starts, because the system
instruction is fixed for the life of a websocket. It says so in its wording,
so the model can reason that a conversation started at 7:58 is past 8 by now
rather than repeating the start time as if it were live.

Weather comes from Open-Meteo, which needs no API key. It is cached for a few
minutes -- it does not change faster than that, and every connect waiting on a
fresh request would add a round trip to the greeting. A failed or slow request
leaves the weather out; it never holds up or fails a session.
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from loguru import logger

DEFAULT_TIMEZONE = "Asia/Hong_Kong"
DEFAULT_PLACE = "Hong Kong"
DEFAULT_LATITUDE = 22.3193
DEFAULT_LONGITUDE = 114.1694

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
# Long enough that back-to-back sessions share one request, short enough that
# the afternoon's rain is not still being reported as morning sun.
WEATHER_CACHE_SECONDS = 15 * 60
# The greeting waits on this, so a slow weather service must not make the toy
# slow to answer. Past this the session goes ahead without weather.
WEATHER_TIMEOUT_SECONDS = 1.5

# WMO weather interpretation codes, as Open-Meteo reports them.
_WMO_DESCRIPTIONS = {
    0: "clear sky",
    1: "mainly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "foggy",
    48: "foggy with frost",
    51: "light drizzle",
    53: "drizzle",
    55: "heavy drizzle",
    56: "light freezing drizzle",
    57: "freezing drizzle",
    61: "light rain",
    63: "rain",
    65: "heavy rain",
    66: "light freezing rain",
    67: "freezing rain",
    71: "light snow",
    73: "snow",
    75: "heavy snow",
    77: "snow grains",
    80: "light rain showers",
    81: "rain showers",
    82: "heavy rain showers",
    85: "light snow showers",
    86: "heavy snow showers",
    95: "a thunderstorm",
    96: "a thunderstorm with hail",
    99: "a thunderstorm with heavy hail",
}

# Keyed by where and which timezone, since sessions for different families
# now ask about different places.
_weather_cache: dict[tuple[float, float, str], tuple[float, str]] = {}


@dataclass(frozen=True)
class Region:
    """A place: what to call it, its clock, and where to look up its weather."""

    name: str
    timezone: str
    latitude: float
    longitude: float


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        logger.warning("{}={!r} is not a number, using {}", name, raw, default)
        return default


def default_region() -> Region:
    """The server's own place, for accounts that have not chosen one."""
    return Region(
        name=os.getenv("WEATHER_PLACE", "").strip() or DEFAULT_PLACE,
        timezone=os.getenv("LOCAL_TIMEZONE", "").strip() or DEFAULT_TIMEZONE,
        latitude=_env_float("WEATHER_LATITUDE", DEFAULT_LATITUDE),
        longitude=_env_float("WEATHER_LONGITUDE", DEFAULT_LONGITUDE),
    )


def resolve_timezone(name: str) -> tzinfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        # Wrong by hours is worse than saying nothing specific, but UTC at least
        # labels itself, and the log says why.
        logger.warning("Unknown timezone {!r}, telling the model UTC", name)
        return timezone.utc


def weather_enabled() -> bool:
    return os.getenv("WEATHER_ENABLED", "true").strip().lower() not in {"0", "false", "no", "off"}


def describe_time(now: datetime) -> str:
    """"Tuesday, 23 September 2026, 7:58 PM" -- the way it is said, not ISO."""
    hour = now.hour % 12 or 12
    meridiem = "AM" if now.hour < 12 else "PM"
    return (
        f"{now:%A}, {now.day} {now:%B %Y}, {hour}:{now.minute:02d} {meridiem}"
    )


def describe_weather(payload: dict) -> str | None:
    """One sentence from an Open-Meteo response, or None if it lacks the basics."""
    current = payload.get("current") or {}
    temperature = current.get("temperature_2m")
    if temperature is None:
        return None
    parts = []
    condition = _WMO_DESCRIPTIONS.get(current.get("weather_code"))
    if condition:
        parts.append(condition)
    parts.append(f"{round(temperature)} degrees Celsius")
    humidity = current.get("relative_humidity_2m")
    if humidity is not None:
        parts.append(f"{round(humidity)} percent humidity")
    sentence = "Right now it is " + ", ".join(parts) + "."

    daily = payload.get("daily") or {}
    highs = daily.get("temperature_2m_max") or []
    lows = daily.get("temperature_2m_min") or []
    rain = daily.get("precipitation_probability_max") or []
    if highs and lows and highs[0] is not None and lows[0] is not None:
        sentence += f" Today's high is {round(highs[0])} and the low is {round(lows[0])}."
    if rain and rain[0] is not None:
        sentence += f" The chance of rain today is {round(rain[0])} percent."
    return sentence


async def fetch_weather(region: Region, tz: tzinfo) -> str | None:
    """Current weather as a sentence, from cache when it is fresh. Never raises."""
    if not weather_enabled():
        return None
    tz_name = getattr(tz, "key", "UTC")
    key = (round(region.latitude, 3), round(region.longitude, 3), tz_name)
    cached = _weather_cache.get(key)
    if cached and time.monotonic() - cached[0] < WEATHER_CACHE_SECONDS:
        return cached[1]

    params = {
        "latitude": region.latitude,
        "longitude": region.longitude,
        "current": "temperature_2m,relative_humidity_2m,weather_code",
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
        # "Today" for the daily high and low is the child's today, not UTC's.
        "timezone": tz_name,
        "forecast_days": 1,
    }
    try:
        async with httpx.AsyncClient(timeout=WEATHER_TIMEOUT_SECONDS) as client:
            response = await client.get(OPEN_METEO_URL, params=params)
            response.raise_for_status()
            sentence = describe_weather(response.json())
    except (httpx.HTTPError, ValueError, asyncio.TimeoutError) as exc:
        logger.warning("Weather lookup failed, starting without it: {!r}", exc)
        return None
    if sentence:
        _weather_cache[key] = (time.monotonic(), sentence)
    return sentence


def build_world_block(now: datetime, place: str, weather: str | None) -> str:
    lines = [
        f"WHEN AND WHERE: This conversation started on {describe_time(now)}, "
        f"local time in {place}. Time has kept moving since, so if asked the "
        "time later on, allow for how long you have been talking.",
    ]
    if weather:
        lines.append(f"The weather in {place}: {weather}")
    lines.append(
        "Use this when the child asks about the time, the date, the day or the "
        "weather, and to greet them in a way that fits the time of day. Say "
        "times and temperatures the way a person would say them aloud. Do not "
        "bring it up when nobody asked."
    )
    return " ".join(lines)


async def fetch_world_block(region: Region | None = None) -> str:
    """The prompt block for a session starting now, in `region` or the default."""
    region = region or default_region()
    tz = resolve_timezone(region.timezone)
    weather = await fetch_weather(region, tz)
    return build_world_block(datetime.now(tz), region.name, weather)

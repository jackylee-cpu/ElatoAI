"""A board's battery state, written to its devices row for the app (R-41).

The board sends {"type":"power"} once per session after "auth" and again when
the state changes (firmware Audio.cpp reportPower()):

    {"type":"power","low":true}                                   Spotpear: VDD sag only
    {"type":"power","low":false,"percent":72,"charging":false}    boards with battery sense

It goes to the database rather than a cache here because a toy spends most of
its time asleep with no socket: the app has to show the last known state, and
this process forgets everything on restart.

Writes run in the background so the voice pipeline never waits on Supabase,
and fail open: a lost battery update is a stale badge, not a broken session.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

import aiohttp
from loguru import logger

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
WRITE_TIMEOUT_SECONDS = 5.0

# One lock per board, so two updates in quick succession land in the order the
# board sent them; asyncio locks are FIFO.
_locks: dict[str, asyncio.Lock] = {}
# Holds the write tasks until they finish; the loop keeps only weak references.
_tasks: set[asyncio.Task] = set()


def _key(mac: str | None) -> str:
    return (mac or "").strip().upper()


def clean(message: dict[str, Any]) -> dict[str, Any] | None:
    """The devices columns this message sets, or None when it is malformed.

    Only these fields are copied out, so a misbehaving board cannot write
    anything else into its row.
    """
    low = message.get("low")
    if not isinstance(low, bool):
        return None
    row: dict[str, Any] = {
        "battery_low": low,
        "battery_percent": None,
        "battery_charging": None,
        "battery_at": datetime.now(timezone.utc).isoformat(),
    }
    percent = message.get("percent")
    # bool is an int in Python; True is not a percentage.
    if isinstance(percent, int) and not isinstance(percent, bool) and 0 <= percent <= 100:
        row["battery_percent"] = percent
        charging = message.get("charging")
        row["battery_charging"] = charging if isinstance(charging, bool) else None
    return row


async def write(mac: str, row: dict[str, Any]) -> bool:
    """PATCH the board's devices row. True when Supabase took it."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        logger.debug("Supabase not configured, not recording battery for {}", mac)
        return False
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    # Rows may hold the MAC in either case (device_registry does the same).
    url = f"{SUPABASE_URL}/rest/v1/devices?mac_address=ilike.{quote(mac, safe='')}"
    lock = _locks.setdefault(mac, asyncio.Lock())
    async with lock:
        try:
            timeout = aiohttp.ClientTimeout(total=WRITE_TIMEOUT_SECONDS)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.patch(url, json=row, headers=headers) as response:
                    if response.status not in (200, 204):
                        body = (await response.text())[:200]
                        logger.warning(
                            "Battery for {} not recorded: HTTP {} {}", mac, response.status, body
                        )
                        return False
        except Exception as exc:  # noqa: BLE001 - fail open on any transport error
            logger.warning("Battery for {} not recorded: {}", mac, type(exc).__name__)
            return False
    logger.info(
        "Battery for {}: {}{}",
        mac,
        "LOW" if row["battery_low"] else "ok",
        f", {row['battery_percent']}%" if row["battery_percent"] is not None else "",
    )
    return True


def handle_device_message(mac: str | None, message: dict[str, Any]) -> bool:
    """Take a board's power message. True when it was one, so the voice
    pipeline never sees it."""
    if message.get("type") != "power":
        return False
    key = _key(mac)
    row = clean(message)
    if not key or row is None:
        return True
    task = asyncio.get_running_loop().create_task(write(key, row))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return True

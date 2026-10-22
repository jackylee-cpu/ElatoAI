"""Whether a board is connected, and if not, why it went (for the app).

Each /ws/esp32 session writes to the board's devices row:

    connect      connected_at = now, disconnected_at = null, disconnect_reason = null
    disconnect   disconnected_at = now, disconnect_reason = why

The board says why just before it closes, with {"type":"bye","reason":...}
(firmware sayBye() in Audio.cpp):

    sleep_idle          idle timeout (5 minutes on the Spotpear board)
    sleep_button        the sleep gesture
    sleep_session_end   the server's SESSION.END
    restart             "Update now" or a factory reset from the app

A close with no "bye" before it is "lost": power gone, Wi-Fi gone, a crash.
After a "low battery" report that is most likely a flat cell, which is what
the app makes of it. Firmware without "bye" (cloud 1.0.1, 1.1.0) does not list
it in X-Device-Caps; its closes are "unknown", since some of them are sleeps.

A board that reconnects before its old socket is cleaned up must not be shown
as gone, so a disconnect only lands on the row while connected_at is still its
own session's.

When this process starts, rows it left "connected" (a crash, a restart) are
closed as "server_restart"; live boards reconnect within seconds. That assumes
one voice server per database, which is how every stack runs.

Writes run in the background and fail open, as in device_power.
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

CAPS_HEADER = "x-device-caps"
BOARD_REASONS = frozenset({"sleep_idle", "sleep_button", "sleep_session_end", "restart"})

_locks: dict[str, asyncio.Lock] = {}
_tasks: set[asyncio.Task] = set()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def says_bye(caps_header: str | None) -> bool:
    """True when this firmware sends "bye" before every close it means."""
    caps = {c.strip().lower() for c in (caps_header or "").split(",")}
    return "bye" in caps


def _state(websocket: Any):
    return getattr(websocket, "state", None)


def handle_device_message(websocket: Any, message: dict[str, Any]) -> bool:
    """Take a board's "bye". True when it was one, so the voice pipeline never sees it."""
    if message.get("type") != "bye":
        return False
    reason = message.get("reason")
    state = _state(websocket)
    if reason in BOARD_REASONS and state is not None:
        state.bye_reason = reason
    return True


def disconnect_reason(websocket: Any) -> str:
    state = _state(websocket)
    bye = getattr(state, "bye_reason", None)
    if bye in BOARD_REASONS:
        return bye
    return "lost" if getattr(state, "says_bye", False) else "unknown"


async def _patch(key: str, query: str, row: dict[str, Any]) -> bool:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        logger.debug("Supabase not configured, not recording the connection for {}", key)
        return False
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    url = f"{SUPABASE_URL}/rest/v1/devices?{query}"
    try:
        timeout = aiohttp.ClientTimeout(total=WRITE_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.patch(url, json=row, headers=headers) as response:
                if response.status not in (200, 204):
                    body = (await response.text())[:200]
                    logger.warning(
                        "Connection of {} not recorded: HTTP {} {}", key, response.status, body
                    )
                    return False
    except Exception as exc:  # noqa: BLE001 - fail open on any transport error
        logger.warning("Connection of {} not recorded: {}", key, type(exc).__name__)
        return False
    return True


async def write(mac: str, row: dict[str, Any], session_started: str | None = None) -> bool:
    """PATCH the board's row; with session_started, only while that session is the latest."""
    # Rows may hold the MAC in either case (device_registry does the same).
    query = f"mac_address=ilike.{quote(mac, safe='')}"
    if session_started is not None:
        query += f"&connected_at=eq.{quote(session_started, safe='')}"
    async with _locks.setdefault(mac, asyncio.Lock()):
        return await _patch(mac, query, row)


def _spawn(coro) -> None:
    task = asyncio.get_running_loop().create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


def _key(mac: str | None) -> str:
    return (mac or "").strip().upper()


def connected(mac: str | None, websocket: Any, caps_header: str | None) -> None:
    """A session started. Call once "auth" has gone out."""
    key = _key(mac)
    state = _state(websocket)
    if not key or state is None:
        return
    state.says_bye = says_bye(caps_header)
    state.bye_reason = None
    state.session_started_at = _now()
    _spawn(
        write(
            key,
            {
                "connected_at": state.session_started_at,
                "disconnected_at": None,
                "disconnect_reason": None,
            },
        )
    )


def disconnected(mac: str | None, websocket: Any) -> None:
    """The session ended. Safe to call for one connected() never saw."""
    key = _key(mac)
    started = getattr(_state(websocket), "session_started_at", None)
    if not key or started is None:
        return
    reason = disconnect_reason(websocket)
    logger.info("ESP32 {} gone: {}", key, reason)
    _spawn(write(key, {"disconnected_at": _now(), "disconnect_reason": reason}, started))


async def close_stale_sessions() -> bool:
    """At startup: close the sessions a previous run of this server left open."""
    return await _patch(
        "all boards",
        "connected_at=not.is.null&disconnected_at=is.null",
        {"disconnected_at": _now(), "disconnect_reason": "server_restart"},
    )

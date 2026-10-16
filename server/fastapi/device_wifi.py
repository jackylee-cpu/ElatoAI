"""Remote Wi-Fi management for ESP32 boards (R-37).

The web app cannot reach a board directly, so it asks this server, which relays
over the board's live /ws/esp32 socket:

    web app --/internal/device_wifi--> here --{"type":"wifi",...}--> board
    board --{"type":"wifi_result","id":...}--> here --> web app

The board also sends {"type":"wifi_status"} unprompted after each "auth", so
the page can show the last known list while the board sleeps.

A "switch" is answered before the board moves -- moving takes its socket down
-- so how it ended comes later, as "last_switch" on the report the board sends
once it is back. That is kept apart from the list, stamped with when it
arrived, so the page can tell a fresh result from an old one.

Passwords pass through and are never kept: not in the status cache, not in a
log line, not in an exception message. Only network names are kept: in memory,
and in the board's device_wifi row (record_device_wifi(), migration
20261016120000), which the page reads directly so that a sleeping board's list
survives a restart of this server.

Firmware older than R-37 (cloud 1.0.1) neither reports nor answers. A board
that has been connected for REPORT_GRACE_S without reporting is taken to be
one, and requests to it fail at once as "unsupported" rather than after
REQUEST_TIMEOUT_S.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import aiohttp
from fastapi import WebSocket
from loguru import logger

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
WRITE_TIMEOUT_S = 5.0

# How long a board gets to answer. A scan blocks the board's Wi-Fi task for a
# few seconds and it may be mid-turn, so leave room.
REQUEST_TIMEOUT_S = 20.0

# A "status" is answered from the board's last report, without asking it, when
# that report came over the board's current connection and is this recent. The
# board reports on every connect and after every change, so the list is already
# current; only the signal strength ages. A mid-turn board can take seconds to
# answer, which a page opening should not wait for. "fresh" asks it anyway.
STATUS_MAX_AGE_S = 60.0

# R-37 firmware reports within a second or two of "auth"; its Wi-Fi task can be
# busy with a reconnect for longer, so allow plenty before calling it old.
REPORT_GRACE_S = 20.0

# What a board reports, and the only fields copied out of its messages. Keeps a
# misbehaving board from parking arbitrary data here.
_STATUS_FIELDS = ("current", "saved", "max")


@dataclass
class _Board:
    sockets: set[WebSocket] = field(default_factory=set)
    status: dict[str, Any] | None = None
    status_at: float | None = None
    pending: dict[str, asyncio.Future] = field(default_factory=dict)
    # When the board's current run of sockets began; None while it has none.
    connected_at: float | None = None
    # How the last Wi-Fi switch ended, with "at": when the board reported it.
    last_switch: dict[str, Any] | None = None
    # The last status written to the database, so an unchanged report is not
    # written again.
    recorded: dict[str, Any] | None = None


_boards: dict[str, _Board] = {}
# Holds the write tasks until they finish; the loop keeps only weak references.
_tasks: set[asyncio.Task] = set()
# One lock per board, so reports land in the order the board sent them.
_locks: dict[str, asyncio.Lock] = {}


def _key(mac: str | None) -> str:
    return (mac or "").strip().upper()


def _board(mac: str) -> _Board:
    return _boards.setdefault(mac, _Board())


def _clean_status(message: dict[str, Any]) -> dict[str, Any]:
    status: dict[str, Any] = {}
    current = message.get("current")
    if isinstance(current, dict) and isinstance(current.get("ssid"), str):
        status["current"] = {
            "ssid": current["ssid"][:32],
            "rssi": current.get("rssi") if isinstance(current.get("rssi"), int) else None,
        }
    else:
        status["current"] = None
    saved = message.get("saved")
    status["saved"] = [
        {"ssid": item["ssid"][:32], "joined": bool(item.get("joined"))}
        for item in (saved if isinstance(saved, list) else [])
        if isinstance(item, dict) and isinstance(item.get("ssid"), str)
    ][:16]
    status["max"] = message.get("max") if isinstance(message.get("max"), int) else None
    return status


def _clean_switch(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or not isinstance(value.get("ssid"), str):
        return None
    result: dict[str, Any] = {"ssid": value["ssid"][:32], "ok": bool(value.get("ok"))}
    if not result["ok"]:
        error = value.get("error")
        result["error"] = error if isinstance(error, str) and len(error) <= 32 else "failed"
        if isinstance(value.get("back"), str) and value["back"]:
            result["back"] = value["back"][:32]
    return result


def _clean_networks(message: dict[str, Any]) -> list[dict[str, Any]]:
    networks = message.get("networks")
    return [
        {
            "ssid": item["ssid"][:32],
            "rssi": item.get("rssi") if isinstance(item.get("rssi"), int) else None,
            "secure": bool(item.get("secure", True)),
        }
        for item in (networks if isinstance(networks, list) else [])
        if isinstance(item, dict) and isinstance(item.get("ssid"), str) and item["ssid"]
    ][:30]


def register(mac: str | None, websocket: WebSocket) -> None:
    key = _key(mac)
    if key:
        board = _board(key)
        if not board.sockets:
            board.connected_at = time.time()
        board.sockets.add(websocket)


def unregister(mac: str | None, websocket: WebSocket) -> None:
    key = _key(mac)
    board = _boards.get(key)
    if board is None:
        return
    board.sockets.discard(websocket)
    if not board.sockets:
        board.connected_at = None
        # Nobody left to answer; fail the waiters now rather than at timeout.
        for future in board.pending.values():
            if not future.done():
                future.set_exception(ConnectionError("device disconnected"))
        board.pending.clear()


def handle_device_message(mac: str | None, message: dict[str, Any]) -> bool:
    """Take a board's Wi-Fi message. True when it was one, so the voice
    pipeline never sees it."""
    msg_type = message.get("type")
    if msg_type not in ("wifi_status", "wifi_result"):
        return False
    key = _key(mac)
    if not key:
        return True
    board = _board(key)

    if any(name in message for name in _STATUS_FIELDS):
        board.status = _clean_status(message)
        board.status_at = time.time()
        _record_later(key, board)
    switch = _clean_switch(message.get("last_switch"))
    if switch is not None:
        board.last_switch = {**switch, "at": time.time()}
        logger.info(
            "Wi-Fi switch on {}: {}", key, "ok" if switch["ok"] else switch["error"]
        )

    if msg_type == "wifi_result":
        future = board.pending.pop(str(message.get("id", "")), None)
        if future is not None and not future.done():
            future.set_result(message)
    return True


def _reports_wifi(board: _Board | None) -> bool | None:
    """True when the board reported over its current connection, False when it
    has been connected REPORT_GRACE_S without, None when it cannot be told yet
    (asleep, or only just connected)."""
    if board is None or not board.sockets or board.connected_at is None:
        return None
    if board.status_at is not None and board.status_at >= board.connected_at:
        return True
    if time.time() - board.connected_at >= REPORT_GRACE_S:
        return False
    return None


def snapshot(mac: str | None) -> dict[str, Any]:
    """What the page shows: online or not, and the last list the board sent."""
    board = _boards.get(_key(mac))
    return {
        "online": bool(board and board.sockets),
        "status": board.status if board else None,
        "status_at": board.status_at if board else None,
        "last_switch": board.last_switch if board else None,
        "reports_wifi": _reports_wifi(board),
    }


async def _record(mac: str, status: dict[str, Any]) -> bool:
    """Write a report to the board's device_wifi row. True when Supabase took
    it. Fails open: a lost write only means an older list on a sleeping
    board's page."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        logger.debug("Supabase not configured, not recording Wi-Fi for {}", mac)
        return False
    current = status.get("current") or {}
    args = {
        "p_mac": mac,
        # The table holds 1-32 bytes; "" would fail the whole write.
        "p_current_ssid": current.get("ssid") or None,
        "p_current_rssi": current.get("rssi"),
        "p_saved": status.get("saved") or [],
        "p_max_saved": status.get("max"),
    }
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    url = f"{SUPABASE_URL}/rest/v1/rpc/record_device_wifi"
    try:
        timeout = aiohttp.ClientTimeout(total=WRITE_TIMEOUT_S)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=args, headers=headers) as response:
                if response.status != 200:
                    body = (await response.text())[:200]
                    logger.warning("Wi-Fi for {} not recorded: HTTP {} {}", mac, response.status, body)
                    return False
                if await response.json() is not True:
                    logger.warning("Wi-Fi for {} not recorded: no board with that MAC", mac)
                    return False
    except Exception as exc:  # noqa: BLE001 - fail open on any transport error
        logger.warning("Wi-Fi for {} not recorded: {}", mac, type(exc).__name__)
        return False
    return True


async def _record_in_order(mac: str, board: _Board, status: dict[str, Any]) -> None:
    async with _locks.setdefault(mac, asyncio.Lock()):
        if status == board.recorded:
            return
        if await _record(mac, status):
            board.recorded = status


def _record_later(mac: str, board: _Board) -> None:
    """Write the board's report in the background, if it changed: the socket
    loop never waits on Supabase."""
    status = board.status
    if status is None or status == board.recorded:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # called outside a loop (tests); nothing to write with
        return
    task = loop.create_task(_record_in_order(mac, board, status))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


def status_is_fresh(mac: str | None) -> bool:
    """The board is online and its last report needs no second asking."""
    board = _boards.get(_key(mac))
    if board is None or not board.sockets or board.status_at is None:
        return False
    return (
        board.connected_at is not None
        and board.status_at >= board.connected_at
        and time.time() - board.status_at < STATUS_MAX_AGE_S
    )


def presence() -> dict[str, dict[str, Any]]:
    """Every board this process has heard from since it started, by MAC: what
    the admin devices page shows (P2-14). A board missing here has not had a
    session since the last restart, which the page shows as offline."""
    return {
        mac: {
            **snapshot(mac),
            "connected_at": board.connected_at if board.sockets else None,
        }
        for mac, board in _boards.items()
    }


async def request(mac: str | None, op: str, **fields: Any) -> dict[str, Any]:
    """Ask the board to do op and wait for its answer.

    Returns the snapshot plus "ok" and, on failure, "error" -- a short code the
    web app turns into words. Never raises for the board's own failures.
    """
    key = _key(mac)
    board = _boards.get(key)
    if board is None or not board.sockets:
        return {**snapshot(key), "ok": False, "error": "offline"}
    if _reports_wifi(board) is False:
        return {**snapshot(key), "ok": False, "error": "unsupported"}

    request_id = uuid.uuid4().hex[:12]
    future: asyncio.Future = asyncio.get_running_loop().create_future()
    board.pending[request_id] = future
    payload = json.dumps({"type": "wifi", "id": request_id, "op": op, **fields})

    # The newest socket is the live one; an older one may be a stale socket not
    # yet reaped.
    socket = next(reversed(list(board.sockets)))
    try:
        await socket.send_text(payload)
    except Exception as exc:  # noqa: BLE001 - a dead socket is just "offline"
        board.pending.pop(request_id, None)
        # Only the exception's type: its text could echo the payload.
        logger.warning("Wi-Fi {} to {} failed to send: {}", op, key, type(exc).__name__)
        return {**snapshot(key), "ok": False, "error": "offline"}

    try:
        reply = await asyncio.wait_for(future, REQUEST_TIMEOUT_S)
    except asyncio.TimeoutError:
        board.pending.pop(request_id, None)
        logger.warning("Wi-Fi {} to {} timed out", op, key)
        return {**snapshot(key), "ok": False, "error": "timeout"}
    except ConnectionError:
        return {**snapshot(key), "ok": False, "error": "offline"}

    ok = bool(reply.get("ok"))
    result: dict[str, Any] = {**snapshot(key), "ok": ok}
    if not ok:
        error = reply.get("error")
        result["error"] = error if isinstance(error, str) and len(error) <= 32 else "failed"
    if op == "scan":
        result["networks"] = _clean_networks(reply)
    if op == "switch" and ok:
        result["switching"] = True
    logger.info("Wi-Fi {} on {}: {}", op, key, "ok" if ok else result["error"])
    return result

"""Remote Wi-Fi management for ESP32 boards (R-37).

The web app cannot reach a board directly, so it asks this server, which relays
over the board's live /ws/esp32 socket:

    web app --/internal/device_wifi--> here --{"type":"wifi",...}--> board
    board --{"type":"wifi_result","id":...}--> here --> web app

The board also sends {"type":"wifi_status"} unprompted after each "auth", so
the page can show the last known list while the board sleeps.

Passwords pass through and are never kept: not in the status cache, not in a
log line, not in an exception message. Only network names are cached, in
memory, and only so an offline board's page is not empty.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket
from loguru import logger

# How long a board gets to answer. A scan blocks the board's Wi-Fi task for a
# few seconds and it may be mid-turn, so leave room.
REQUEST_TIMEOUT_S = 20.0

# What a board reports, and the only fields copied out of its messages. Keeps a
# misbehaving board from parking arbitrary data here.
_STATUS_FIELDS = ("current", "saved", "max")


@dataclass
class _Board:
    sockets: set[WebSocket] = field(default_factory=set)
    status: dict[str, Any] | None = None
    status_at: float | None = None
    pending: dict[str, asyncio.Future] = field(default_factory=dict)


_boards: dict[str, _Board] = {}


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
        _board(key).sockets.add(websocket)


def unregister(mac: str | None, websocket: WebSocket) -> None:
    key = _key(mac)
    board = _boards.get(key)
    if board is None:
        return
    board.sockets.discard(websocket)
    if not board.sockets:
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

    if msg_type == "wifi_result":
        future = board.pending.pop(str(message.get("id", "")), None)
        if future is not None and not future.done():
            future.set_result(message)
    return True


def snapshot(mac: str | None) -> dict[str, Any]:
    """What the page shows: online or not, and the last list the board sent."""
    board = _boards.get(_key(mac))
    return {
        "online": bool(board and board.sockets),
        "status": board.status if board else None,
        "status_at": board.status_at if board else None,
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
    logger.info("Wi-Fi {} on {}: {}", op, key, "ok" if ok else result["error"])
    return result

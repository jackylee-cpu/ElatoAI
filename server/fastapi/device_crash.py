"""Crash reports from boards, stored for the admin Devices page.

After each "auth", a board that has crashed since its last acknowledged
report sends (firmware src/CrashReport.cpp):

    {"type":"crash","id":3735928559,"count":2,"reason":"panic","fw":"1.8.4",
     "pc":"0x42012abc","ra":"0x42012a80","uptime_s":1234,"task":"network",
     "detail":"Load access fault"}

    id        random per crash, so a report resent after a lost ack is stored once
    count     crashes since the last acknowledged report; the rest describe the last
    reason    panic | int_wdt | task_wdt | wdt | brownout
    fw        the version that crashed (it may since have rolled back)
    pc, ra    where: look them up in that version's ELF (tools/decode_crash.py).
              Absent for a brownout, which is not a panic

Once the row is stored (or was already), the board gets {"type":"crash_ack",
"id":...} and forgets the report. A failed write sends no ack, so the board
tries again on its next session.

Firmware from before this report (cloud 1.0.1, 1.1.0) never sends one.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any

import aiohttp
from loguru import logger

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
WRITE_TIMEOUT_SECONDS = 5.0

REASONS = frozenset({"panic", "int_wdt", "task_wdt", "wdt", "brownout"})
_ADDRESS = re.compile(r"^0x[0-9a-f]{8}$")
_VERSION = re.compile(r"^[0-9A-Za-z.+_-]{1,32}$")

_tasks: set[asyncio.Task] = set()


def _text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    # Printable only: these end up on a web page.
    cleaned = "".join(ch for ch in value if ch.isprintable())[:limit].strip()
    return cleaned or None


def _uint(value: Any, top: int) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= top:
        return None
    return value


def clean(message: dict[str, Any], mac: str, device_id: str | None) -> dict[str, Any] | None:
    """The device_crashes row for this report, or None when it is malformed."""
    report_id = _uint(message.get("id"), 0xFFFFFFFF)
    count = _uint(message.get("count"), 0xFFFFFFFF)
    reason = message.get("reason")
    if report_id is None or not count or reason not in REASONS:
        return None
    fw = message.get("fw")
    pc = message.get("pc")
    ra = message.get("ra")
    return {
        "mac_address": mac,
        "device_id": device_id,
        "report_id": report_id,
        "crash_count": count,
        "reason": reason,
        "firmware_version": fw if isinstance(fw, str) and _VERSION.match(fw) else None,
        "pc": pc if isinstance(pc, str) and _ADDRESS.match(pc) else None,
        "ra": ra if isinstance(ra, str) and _ADDRESS.match(ra) else None,
        "uptime_s": _uint(message.get("uptime_s"), 0x7FFFFFFF),
        "task": _text(message.get("task"), 16),
        "detail": _text(message.get("detail"), 64),
    }


async def store(row: dict[str, Any]) -> bool:
    """Insert the row; a report already stored counts as stored."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        logger.debug("Supabase not configured, not storing a crash from {}", row["mac_address"])
        return False
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal,resolution=ignore-duplicates",
    }
    url = f"{SUPABASE_URL}/rest/v1/device_crashes?on_conflict=mac_address,report_id"
    try:
        timeout = aiohttp.ClientTimeout(total=WRITE_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=row, headers=headers) as response:
                if response.status not in (200, 201, 204):
                    body = (await response.text())[:200]
                    logger.warning(
                        "Crash from {} not stored: HTTP {} {}", row["mac_address"], response.status, body
                    )
                    return False
    except Exception as exc:  # noqa: BLE001 - fail open; the board will resend
        logger.warning("Crash from {} not stored: {}", row["mac_address"], type(exc).__name__)
        return False
    return True


async def _store_and_ack(websocket: Any, row: dict[str, Any]) -> None:
    logger.warning(
        "ESP32 {} crashed: {} x{} on {} at pc={} ra={} task={} after {}s ({})",
        row["mac_address"],
        row["reason"],
        row["crash_count"],
        row["firmware_version"],
        row["pc"],
        row["ra"],
        row["task"],
        row["uptime_s"],
        row["detail"],
    )
    if not await store(row) or websocket is None:
        return
    try:
        await websocket.send_text(json.dumps({"type": "crash_ack", "id": row["report_id"]}))
    except Exception as exc:  # noqa: BLE001 - socket gone: the board resends next time
        logger.info("Crash ack to {} not sent: {}", row["mac_address"], type(exc).__name__)


def handle_device_message(websocket: Any, mac: str | None, message: dict[str, Any]) -> bool:
    """Take a board's crash report. True when it was one, so the pipeline never sees it."""
    if message.get("type") != "crash":
        return False
    key = (mac or "").strip().upper()
    device_id = getattr(getattr(websocket, "state", None), "device_id", None)
    row = clean(message, key, device_id) if key else None
    if row is None:
        logger.warning("Malformed crash report from {}", key or "an unknown board")
        return True
    task = asyncio.get_running_loop().create_task(_store_and_ack(websocket, row))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return True

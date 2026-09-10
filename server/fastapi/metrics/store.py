"""Supabase side of per-turn latency: write a row, never get in the way.

Everything here is best-effort and silent on failure, for a stronger reason
than the rest of the Supabase code in this server. `memory/store.py` fails open
because a toy that forgets beats a toy that goes quiet; this fails open because
a *measurement* that changes what it measures is worse than no measurement. An
insert that blocked the pipeline would show up in the very numbers this table
exists to record.

So the write is fired onto the event loop and forgotten. Callers get no result
and cannot await it.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

import aiohttp
from loguru import logger

# Read lazily, never captured at import time -- see the same note in
# app_settings.py. bot.py imports this module from its import block and only
# calls load_dotenv() afterwards, so a module-level os.getenv here resolves to
# "" and every metrics write is then dropped by configured() with nothing said.


def _supabase_url() -> str:
    return os.getenv("SUPABASE_URL", "").rstrip("/")


def _service_role_key() -> str:
    return os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")


def _write_timeout() -> float:
    # Off the critical path entirely, so it can afford to wait out a slow
    # database rather than dropping the row.
    return float(os.getenv("TURN_METRICS_WRITE_TIMEOUT", "10"))

# asyncio only keeps a weak reference to a bare task, so a fire-and-forget task
# can be garbage collected mid-flight. Holding them here until they finish is
# what stops that.
_pending: set[asyncio.Task] = set()


def configured() -> bool:
    key = _service_role_key().strip()
    return bool(_supabase_url() and key and not key.lower().startswith("your_"))


def record_turn(row: dict[str, Any]) -> None:
    """Queue one turn_metrics row. Returns immediately; failures are logged."""
    if not configured():
        return
    try:
        task = asyncio.create_task(_insert(row))
    except RuntimeError:
        # No running loop. Only reachable from a synchronous test harness, and
        # dropping the row is the right answer there.
        return
    _pending.add(task)
    task.add_done_callback(_pending.discard)


async def _insert(row: dict[str, Any]) -> None:
    key = _service_role_key()
    url = f"{_supabase_url()}/rest/v1/turn_metrics"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    try:
        timeout = aiohttp.ClientTimeout(total=_write_timeout())
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=[row], headers=headers) as response:
                if response.status not in (200, 201, 204):
                    body = (await response.text())[:200]
                    logger.warning(
                        "Write of turn metrics failed: HTTP {} {}", response.status, body
                    )
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - a metrics write must never raise
        logger.warning("Write of turn metrics errored: {}", exc)

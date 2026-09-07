"""Supabase side of long-term memory: the durable copy of what the toy knows.

VoiceMem keeps its working store on local disk (one sqlite plus a directory per
memory space). On Pipecat Cloud and on a plain `docker compose up` that disk is
gone on the next start, so Supabase holds the truth and the local space is a
cache:

    storage bucket `voicemem`/<user_id>.tar.gz   exact copy of the space dir
    table `memories`                             every ingested utterance; the
                                                 only thing a rebuild replays
    table `conversations`                        transcript for the web app

Everything here fails open, for the same reason `device_registry` does: a toy
that goes silent because a database was slow is worse than a toy that forgets.
A failed write is logged and dropped; a failed read yields "no memory yet".
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import aiohttp
from loguru import logger

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
# Service role: this runs on behalf of the device, not a logged-in user, so it
# has to bypass RLS -- the same reasoning as device_registry.
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
SNAPSHOT_BUCKET = os.getenv("VOICEMEM_BUCKET", "voicemem")

# Reads happen before the first audio frame, so they are on the "toy is slow to
# wake up" path and must stay short. Writes happen in a background worker and
# can afford longer.
READ_TIMEOUT_SECONDS = float(os.getenv("VOICEMEM_READ_TIMEOUT", "3"))
WRITE_TIMEOUT_SECONDS = float(os.getenv("VOICEMEM_WRITE_TIMEOUT", "15"))


def configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


def _headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    }
    if extra:
        headers.update(extra)
    return headers


def _clean(value: object) -> str | None:
    """Normalise a PostgREST field to a non-empty string, or None."""
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


@dataclass(frozen=True)
class MemoryRow:
    """One utterance that was fed into memory, plus what the toy answered.

    A rebuild replays exactly these, in order, with `created_at` as the
    observation time -- so what comes back is what was there, and a row a
    parent deleted stays gone.
    """

    content: str
    kind: str = "fact"
    agent_reply: str | None = None
    source_personality_key: str | None = None
    created_at: str | None = None


# ── memories table ───────────────────────────────────────────────────────────


async def fetch_memories(user_id: str, limit: int = 500) -> list[MemoryRow]:
    """Every memory we hold for this child, oldest first.

    Oldest first matters: rebuilding replays these through `ingest()`, and
    VoiceMem's temporal reasoning depends on them arriving in the order they
    were learned.
    """
    if not configured() or not user_id:
        return []

    url = (
        f"{SUPABASE_URL}/rest/v1/memories"
        f"?user_id=eq.{quote(user_id, safe='')}"
        f"&select=content,kind,agent_reply,source_personality_key,created_at"
        f"&order=created_at.asc"
        f"&limit={int(limit)}"
    )
    rows = await _get_json(url, what=f"memories for {user_id}")
    if not rows:
        return []
    out: list[MemoryRow] = []
    for row in rows:
        content = _clean(row.get("content"))
        if not content:
            continue
        out.append(
            MemoryRow(
                content=content,
                kind=_clean(row.get("kind")) or "fact",
                agent_reply=_clean(row.get("agent_reply")),
                source_personality_key=_clean(row.get("source_personality_key")),
                created_at=_clean(row.get("created_at")),
            )
        )
    return out


async def upsert_memories(user_id: str, rows: list[MemoryRow]) -> int:
    """Record the utterances that went into memory, for the parent and for rebuilds.

    Conflicts on (user_id, md5(content)) are ignored rather than merged: the
    same sentence restated is the same memory, and duplicating it would both
    clutter the parent's list and bias a rebuild toward whatever the child
    happens to repeat.
    """
    if not configured() or not user_id or not rows:
        return 0

    payload = [
        {
            "user_id": user_id,
            "content": row.content,
            "kind": row.kind,
            "agent_reply": row.agent_reply,
            "source_personality_key": row.source_personality_key,
        }
        for row in rows
        if row.content.strip()
    ]
    if not payload:
        return 0

    url = f"{SUPABASE_URL}/rest/v1/memories"
    ok = await _post_json(
        url,
        payload,
        # Postgrest cannot ON CONFLICT against an expression index, so a plain
        # insert with duplicates tolerated is the closest thing available.
        headers={"Prefer": "resolution=ignore-duplicates,return=minimal"},
        what=f"memory mirror for {user_id}",
    )
    return len(payload) if ok else 0


async def fetch_memories_revision(user_id: str) -> int:
    """The parent-facing delete counter. A change means "rebuild from scratch"."""
    if not configured() or not user_id:
        return 0
    url = (
        f"{SUPABASE_URL}/rest/v1/users"
        f"?user_id=eq.{quote(user_id, safe='')}"
        f"&select=memories_revision&limit=1"
    )
    rows = await _get_json(url, what=f"memories_revision for {user_id}")
    if not rows:
        return 0
    value = rows[0].get("memories_revision")
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


# ── conversations table ──────────────────────────────────────────────────────


async def insert_conversation_turn(
    user_id: str,
    role: str,
    content: str,
    personality_key: str | None,
    chat_group_id: str | None,
) -> bool:
    """Persist one turn.

    Columns match the Deno server's only writer (server/deno/supabase.ts:201) so
    both transports produce the same shape of history. `chat_group_id` has
    existed since the original schema but was never written by anyone; one uuid
    per session finally fills it in.
    """
    if not configured() or not user_id:
        return False
    content = (content or "").strip()
    if not content:
        return False

    row: dict[str, Any] = {
        "user_id": user_id,
        "role": role,
        "content": content,
        "is_sensitive": False,
    }
    if personality_key:
        row["personality_key"] = personality_key
    if chat_group_id:
        row["chat_group_id"] = chat_group_id

    return await _post_json(
        f"{SUPABASE_URL}/rest/v1/conversations",
        [row],
        headers={"Prefer": "return=minimal"},
        what=f"conversation turn for {user_id}",
    )


# ── storage snapshot ─────────────────────────────────────────────────────────


def _snapshot_path(user_id: str) -> str:
    return f"{SNAPSHOT_BUCKET}/{quote(user_id, safe='')}.tar.gz"


async def fetch_snapshot(user_id: str) -> bytes | None:
    """The tarred-up VoiceMem space dir, or None if there isn't one yet."""
    if not configured() or not user_id:
        return None
    url = f"{SUPABASE_URL}/storage/v1/object/{_snapshot_path(user_id)}"
    try:
        timeout = aiohttp.ClientTimeout(total=READ_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=_headers()) as response:
                if response.status == 404:
                    logger.info("No memory snapshot yet for {}", user_id)
                    return None
                if response.status != 200:
                    body = (await response.text())[:200]
                    logger.warning(
                        "Snapshot download for {} failed: HTTP {} {}",
                        user_id,
                        response.status,
                        body,
                    )
                    return None
                return await response.read()
    except Exception as exc:  # noqa: BLE001 - fail open on any transport error
        logger.warning("Snapshot download for {} errored: {}", user_id, exc)
        return None


async def push_snapshot(user_id: str, blob: bytes) -> bool:
    """Upload the space dir. `x-upsert` because this replaces the last copy."""
    if not configured() or not user_id or not blob:
        return False
    url = f"{SUPABASE_URL}/storage/v1/object/{_snapshot_path(user_id)}"
    try:
        timeout = aiohttp.ClientTimeout(total=WRITE_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                url,
                data=blob,
                headers=_headers(
                    {"Content-Type": "application/gzip", "x-upsert": "true"}
                ),
            ) as response:
                if response.status not in (200, 201):
                    body = (await response.text())[:200]
                    logger.warning(
                        "Snapshot upload for {} failed: HTTP {} {}",
                        user_id,
                        response.status,
                        body,
                    )
                    return False
    except Exception as exc:  # noqa: BLE001
        logger.warning("Snapshot upload for {} errored: {}", user_id, exc)
        return False
    logger.info("Uploaded {} byte memory snapshot for {}", len(blob), user_id)
    return True


async def delete_snapshot(user_id: str) -> bool:
    """Drop a stale snapshot so the next session cannot restore from it."""
    if not configured() or not user_id:
        return False
    url = f"{SUPABASE_URL}/storage/v1/object/{_snapshot_path(user_id)}"
    try:
        timeout = aiohttp.ClientTimeout(total=WRITE_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.delete(url, headers=_headers()) as response:
                return response.status in (200, 204, 404)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Snapshot delete for {} errored: {}", user_id, exc)
        return False


# ── transport helpers ────────────────────────────────────────────────────────


async def _get_json(url: str, *, what: str) -> list[dict] | None:
    try:
        timeout = aiohttp.ClientTimeout(total=READ_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(
                url, headers=_headers({"Accept": "application/json"})
            ) as response:
                if response.status != 200:
                    body = (await response.text())[:200]
                    logger.warning(
                        "Read of {} failed: HTTP {} {}", what, response.status, body
                    )
                    return None
                return await response.json()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Read of {} errored: {}", what, exc)
        return None


async def _post_json(
    url: str,
    payload: object,
    *,
    headers: dict[str, str],
    what: str,
) -> bool:
    try:
        timeout = aiohttp.ClientTimeout(total=WRITE_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                url,
                json=payload,
                headers=_headers({"Content-Type": "application/json", **headers}),
            ) as response:
                if response.status not in (200, 201, 204):
                    body = (await response.text())[:200]
                    logger.warning(
                        "Write of {} failed: HTTP {} {}", what, response.status, body
                    )
                    return False
                return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("Write of {} errored: {}", what, exc)
        return False

"""Supabase side of long-term memory: everything the toy knows, in three tables.

Every row is kept per IP (`ip_key`) as well as per child: what a child tells
one IP's characters is never read back by another's. Within an IP, its
characters share one memory.

    table `memory_facts`      who the child is, one active fact per row
    table `memory_segments`   what each stretch of conversation was about
    table `conversations`     the transcript, for the web app; never read back
                              into a prompt

`memories` (one row per utterance) and the `voicemem` storage bucket are left
over from the VoiceMem store removed on 2026-09-24. Nothing here reads or writes
them any more.

Everything here fails open, for the same reason `device_registry` does: a toy
that goes silent because a database was slow is worse than a toy that forgets.
A failed write is logged and dropped; a failed read yields "no memory yet",
except where a caller needs to tell the two apart (see fetch_active_facts).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

import aiohttp
from loguru import logger

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
# Service role: this runs on behalf of the device, not a logged-in user, so it
# has to bypass RLS -- the same reasoning as device_registry.
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

# Reads happen before the first audio frame, so they are on the "toy is slow to
# wake up" path and must stay short. Writes happen in a background worker and
# can afford longer.
READ_TIMEOUT_SECONDS = float(
    os.getenv("MEMORY_READ_TIMEOUT") or os.getenv("VOICEMEM_READ_TIMEOUT") or "3"
)
WRITE_TIMEOUT_SECONDS = float(
    os.getenv("MEMORY_WRITE_TIMEOUT") or os.getenv("VOICEMEM_WRITE_TIMEOUT") or "15"
)


def _is_placeholder(value: str) -> bool:
    """Is this still the `your_...` line copied out of env.example?

    A placeholder is a non-empty string, so a plain truth test calls it
    configured and every request then 401s. That failure is invisible in a voice
    session -- the lookup fails open, memory turns itself off, and the toy just
    quietly stops remembering -- so an unedited placeholder has to count as
    unset, not as a value.
    """
    return value.strip().lower().startswith("your_")


def configured() -> bool:
    return bool(
        SUPABASE_URL
        and SUPABASE_SERVICE_ROLE_KEY
        and not _is_placeholder(SUPABASE_SERVICE_ROLE_KEY)
    )


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


def _stamp(row: dict[str, Any], revision: int | None) -> None:
    """Mark a write with the memory revision its session started under.

    The database refuses a stamp older than the account's current
    `users.memories_revision`, which goes up every time a parent clears the
    child's memory (migration 20261009120000). That is what stops a session
    that was live during the clear -- or the consolidation that finishes after
    it -- from writing back what was just deleted. Such a refusal shows up here
    as a failed write, which is the right outcome.
    """
    if revision is not None:
        row["memories_revision"] = int(revision)


# ── memory_segments table ────────────────────────────────────────────────────


@dataclass(frozen=True)
class Segment:
    """One stretch of a conversation, compressed to a sentence or two.

    Segments are what makes a *new* session feel continuous. A search
    cannot do that job: it needs a query, and at "hello" there is
    nothing to query with. The last session's closing segments are the answer
    to a question nobody has asked yet, so they have to be already loaded.
    """

    summary: str
    from_turn: int = 0
    to_turn: int = 0
    created_at: str | None = None
    chat_group_id: str | None = None


def _parse_segments(rows: list[dict] | None) -> list[Segment]:
    out: list[Segment] = []
    for row in rows or []:
        summary = _clean(row.get("summary"))
        if not summary:
            continue
        out.append(
            Segment(
                summary=summary,
                from_turn=int(row.get("from_turn") or 0),
                to_turn=int(row.get("to_turn") or 0),
                created_at=_clean(row.get("created_at")),
                chat_group_id=_clean(row.get("chat_group_id")),
            )
        )
    return out


async def fetch_recent_segments(user_id: str, ip_key: str, limit: int = 2) -> list[Segment]:
    """This child's most recent segments, oldest first.

    The query asks newest-first because that is what the index serves, and the
    result is reversed here: a brief reads as "we talked about A, then B", so
    the order it is rendered in has to be the order it happened in.
    """
    if not configured() or not user_id:
        return []
    url = (
        f"{SUPABASE_URL}/rest/v1/memory_segments"
        f"?user_id=eq.{quote(user_id, safe='')}"
        f"&ip_key=eq.{quote(ip_key, safe='')}"
        f"&select=summary,from_turn,to_turn,created_at,chat_group_id"
        f"&order=created_at.desc"
        f"&limit={int(limit)}"
    )
    rows = await _get_json(url, what=f"memory segments for {user_id}")
    return list(reversed(_parse_segments(rows)))


async def insert_segment(
    user_id: str,
    ip_key: str,
    chat_group_id: str | None,
    from_turn: int,
    to_turn: int,
    summary: str,
    *,
    revision: int | None = None,
) -> bool:
    """Record one compressed stretch. Fails open like every other write here."""
    if not configured() or not user_id:
        return False
    summary = (summary or "").strip()
    if not summary:
        return False
    row: dict[str, Any] = {
        "user_id": user_id,
        "ip_key": ip_key,
        "from_turn": int(from_turn),
        "to_turn": int(to_turn),
        "summary": summary,
    }
    if chat_group_id:
        row["chat_group_id"] = chat_group_id
    _stamp(row, revision)
    return await _post_json(
        f"{SUPABASE_URL}/rest/v1/memory_segments",
        [row],
        headers={"Prefer": "return=minimal"},
        what=f"memory segment for {user_id}",
    )


# ── memory_facts table ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class Fact:
    """One thing known about the child. Active until something replaces it."""

    fact_id: str
    content: str
    created_at: str | None = None


async def fetch_active_facts(
    user_id: str, ip_key: str, limit: int = 200
) -> list[Fact] | None:
    """This child's active facts, oldest first. None if the read failed.

    None is not []: consolidation hands the known list to the model so it can
    say which fact a new one replaces, and "we could not read them" passed off
    as "there are none" would have it re-add everything it already knows.
    """
    if not configured() or not user_id:
        return []
    url = (
        f"{SUPABASE_URL}/rest/v1/memory_facts"
        f"?user_id=eq.{quote(user_id, safe='')}"
        f"&ip_key=eq.{quote(ip_key, safe='')}"
        f"&superseded_at=is.null"
        f"&select=fact_id,content,created_at"
        f"&order=created_at.desc,fact_id.desc"
        f"&limit={int(limit)}"
    )
    rows = await _get_json(url, what=f"memory facts for {user_id}")
    if rows is None:
        return None
    out = [
        Fact(
            fact_id=str(row.get("fact_id")),
            content=content,
            created_at=_clean(row.get("created_at")),
        )
        for row in rows
        if (content := _clean(row.get("content"))) and row.get("fact_id")
    ]
    # Asked newest-first so the limit keeps the newest; rendered oldest-first
    # because that is the order they were learned in.
    return list(reversed(out))


async def insert_fact(
    user_id: str,
    ip_key: str,
    chat_group_id: str | None,
    content: str,
    *,
    revision: int | None = None,
) -> str | None:
    """Record one fact and return its id, or None if the write failed."""
    if not configured() or not user_id:
        return None
    content = (content or "").strip()
    if not content:
        return None
    row: dict[str, Any] = {"user_id": user_id, "ip_key": ip_key, "content": content}
    if chat_group_id:
        row["chat_group_id"] = chat_group_id
    _stamp(row, revision)
    rows = await _post_json_returning(
        f"{SUPABASE_URL}/rest/v1/memory_facts?select=fact_id",
        [row],
        what=f"memory fact for {user_id}",
    )
    if not rows:
        return None
    fact_id = rows[0].get("fact_id")
    return str(fact_id) if fact_id else None


async def supersede_fact(user_id: str, fact_id: str, replaced_by: str) -> bool:
    """Retire a fact in favour of a newer one. The row stays, for tracing."""
    if not configured() or not user_id or not fact_id:
        return False
    url = (
        f"{SUPABASE_URL}/rest/v1/memory_facts"
        f"?fact_id=eq.{quote(fact_id, safe='')}"
        f"&user_id=eq.{quote(user_id, safe='')}"
    )
    try:
        timeout = aiohttp.ClientTimeout(total=WRITE_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.patch(
                url,
                json={
                    "superseded_at": datetime.now(timezone.utc).isoformat(),
                    "superseded_by": replaced_by,
                },
                headers=_headers(
                    {"Content-Type": "application/json", "Prefer": "return=minimal"}
                ),
            ) as response:
                if response.status not in (200, 204):
                    body = (await response.text())[:200]
                    logger.warning(
                        "Retiring fact {} for {} failed: HTTP {} {}",
                        fact_id,
                        user_id,
                        response.status,
                        body,
                    )
                    return False
                return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("Retiring fact {} for {} errored: {}", fact_id, user_id, exc)
        return False


# ── conversations table ──────────────────────────────────────────────────────


async def insert_conversation_turn(
    user_id: str,
    ip_key: str,
    role: str,
    content: str,
    personality_key: str | None,
    chat_group_id: str | None,
    *,
    revision: int | None = None,
) -> bool:
    """Persist one turn.

    Columns match what the upstream Deno server wrote (role, content, user_id,
    is_sensitive, personality_key), so older history has the same shape. `chat_group_id` has
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
        "ip_key": ip_key,
        "role": role,
        "content": content,
        "is_sensitive": False,
    }
    if personality_key:
        row["personality_key"] = personality_key
    if chat_group_id:
        row["chat_group_id"] = chat_group_id
    _stamp(row, revision)

    return await _post_json(
        f"{SUPABASE_URL}/rest/v1/conversations",
        [row],
        headers={"Prefer": "return=minimal"},
        what=f"conversation turn for {user_id}",
    )


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


async def _post_json_returning(
    url: str, payload: object, *, what: str
) -> list[dict] | None:
    """POST and return the inserted rows, for when the caller needs their ids."""
    try:
        timeout = aiohttp.ClientTimeout(total=WRITE_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                url,
                json=payload,
                headers=_headers(
                    {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "Prefer": "return=representation",
                    }
                ),
            ) as response:
                if response.status not in (200, 201):
                    body = (await response.text())[:200]
                    logger.warning(
                        "Write of {} failed: HTTP {} {}", what, response.status, body
                    )
                    return None
                rows = await response.json()
                return rows if isinstance(rows, list) else None
    except Exception as exc:  # noqa: BLE001
        logger.warning("Write of {} errored: {}", what, exc)
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

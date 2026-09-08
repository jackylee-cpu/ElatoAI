"""One VoiceMem store per child, cached across sessions and backed by Supabase.

Two things drive the shape of this module.

**Isolation.** VoiceMem resolves its storage as `memory_root or
$VOICEMEM_MEMORY_ROOT`, and that env var wins over the `space` argument
entirely (voicemem/orchestrator.py sets `self._space = None` when it is set).
So `VOICEMEM_MEMORY_ROOT` must never be exported in a deployment that serves
more than one child -- it would silently collapse every child into one shared
store. We pass an explicit per-user `memory_root` instead.

**Blocking.** `ingest()` and `search()` are synchronous, and VoiceMem's own
docs put a recall at roughly 1-2s of wall time against OpenAI defaults. Nothing
here may ever be awaited from the frame path; every call goes through
`asyncio.to_thread`, and writes go through a queue drained by a background
worker.
"""

from __future__ import annotations

import asyncio
import io
import os
import shutil
import sqlite3
import tarfile
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

from loguru import logger

from memory import store

# Base directory holding one subdirectory per child. Deliberately not named
# VOICEMEM_MEMORY_ROOT: that name is read by VoiceMem itself and would defeat
# per-child isolation (see the module docstring).
MEMORY_BASE = Path(os.getenv("VOICEMEM_BASE_DIR", "./voicemem_spaces")).expanduser()
TOP_K = int(os.getenv("VOICEMEM_TOP_K", "5"))
# How long the final transcript may wait for an in-flight prefetch. 0 means
# never wait -- see MemoryProcessor for why that is the default.
SEARCH_BLOCK_MS = int(os.getenv("VOICEMEM_SEARCH_BLOCK_MS", "0"))
# Each cached store holds an open sqlite handle and its share of the embedding
# model's working set, so the number of children kept warm has to be bounded.
MAX_SESSIONS = int(os.getenv("VOICEMEM_MAX_SESSIONS", "32"))
# VoiceMem's own Classify() is an extra LLM round trip before the search. It
# improves slot targeting but it is the bulk of that 1-2s, so it is off by
# default on a toy where the reply has to land quickly.
USE_CLASSIFY = os.getenv("VOICEMEM_CLASSIFY", "false").strip().lower() in {"1", "true", "yes"}


def enabled() -> bool:
    return os.getenv("VOICEMEM_ENABLED", "true").strip().lower() in {"1", "true", "yes"}


@dataclass
class PendingTurn:
    """A completed exchange waiting to be written to memory and to Supabase."""

    user_text: str
    agent_reply: str
    personality_key: str | None
    observed_at: str


class MemorySession:
    """The memory for one child, for the duration of one connection.

    Instances are shared: two devices on the same account get the same store.
    `acquire()` / `release()` reference-count so the last one out flushes.
    """

    def __init__(self, user_id: str, language_code: str | None = None):
        self.user_id = user_id
        self.language_code = language_code
        self.root = MEMORY_BASE / user_id
        self._vm = None
        self._refs = 0
        self._revision = 0
        self._ready = asyncio.Event()
        self._queue: asyncio.Queue[PendingTurn | None] = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self._dirty = False
        # One uuid per connection, written to conversations.chat_group_id and
        # handed to VoiceMem as its session id so both agree on turn grouping.
        self.chat_group_id: str | None = None

    # ── lifecycle ────────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Load or rebuild this child's store. Safe to call once per session."""
        async with self._lock:
            if self._vm is not None and not await self._revision_changed():
                self._ready.set()
                return
            await self._build()
            self._ready.set()
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._drain())

    async def _revision_changed(self) -> bool:
        """Has a parent deleted something since we loaded this store?"""
        remote = await store.fetch_memories_revision(self.user_id)
        return remote != self._revision

    async def _build(self) -> None:
        """Get a usable store on local disk.

        Order matters. The revision check comes first because a parent deleting
        a memory has to win over both caches -- otherwise the toy keeps
        remembering something the parent removed, which is the one failure this
        whole feature cannot have.
        """
        remote_revision = await store.fetch_memories_revision(self.user_id)

        if remote_revision != self._revision and self.root.exists():
            logger.info(
                "Memory revision for {} changed ({} -> {}), discarding local store",
                self.user_id,
                self._revision,
                remote_revision,
            )
            await asyncio.to_thread(shutil.rmtree, self.root, True)
            await store.delete_snapshot(self.user_id)

        self._revision = remote_revision

        if self.root.exists() and not self._has_schema():
            # A directory with a schema-less sqlite in it. This is what deleting
            # a live store leaves behind: the running process still holds the
            # open file, sqlite recreates an empty one at the same path, and
            # VoiceMem only builds its schema at construction -- so every search
            # and every ingest afterwards fails with "no such table" forever.
            # Rebuilding is the only way out, and it has to be automatic:
            # nothing about the symptom points at the directory.
            logger.warning(
                "Memory store for {} has no schema, discarding and rebuilding it",
                self.user_id,
            )
            await asyncio.to_thread(shutil.rmtree, self.root, True)

        if not self.root.exists():
            restored = await self._restore_snapshot()
            if not restored:
                await self._rebuild_from_supabase()

        self._vm = await asyncio.to_thread(self._construct)
        logger.info("Memory ready for {} at {}", self.user_id, self.root)

    # Tables VoiceMem builds late, so a half-created store has the early ones
    # and not these. Both names come from the errors a broken store actually
    # produced -- "no such table: touched_refs" on every search and "no such
    # table: memory_tags" on every ingest (2026-09-08). A store missing them is
    # unusable in both directions, and no amount of running fixes it.
    _SCHEMA_SENTINELS = ("touched_refs", "memory_tags")

    def _has_schema(self) -> bool:
        """Does the store on disk actually hold VoiceMem's schema?

        Existence of the directory is not enough -- see the caller.
        """
        databases = list(self.root.glob("*.sqlite"))
        if not databases:
            return False
        for database in databases:
            try:
                with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as conn:
                    present = {
                        row[0]
                        for row in conn.execute(
                            "SELECT name FROM sqlite_master WHERE type='table'"
                        )
                    }
            except sqlite3.Error:
                return False
            if not present.issuperset(self._SCHEMA_SENTINELS):
                return False
        return True

    @staticmethod
    def _local_slot_classifier():
        """Slot classification on the local E5, sharing the embedder's copy."""
        from voicemem.leftbrain.cognitive_graph.local_query_classifier import (
            LocalQueryClassifier,
        )
        from voicemem.leftbrain.local_e5_embedder import shared_e5

        return LocalQueryClassifier(model=shared_e5())

    @staticmethod
    def _configure_llm_model() -> None:
        """Point VoiceMem's internal LLM at a model our key is allowed to use.

        VoiceMem hardcodes `gpt-4o-mini` for the left brain's fact extraction,
        and reads the override from the process-global `OPENAI_MODEL` -- there
        is no per-instance setting, even through its own config layer, which
        just assigns that env var (voicemem/config.py:215). Setting it here is
        therefore a process-wide choice; nothing else in this server reads that
        name, so it is ours to set.

        Without it the write path fails silently on an OpenRouter key that does
        not carry OpenAI models: measured 2026-09-08, every OpenAI model id on
        ours returns HTTP 403 "violation of provider Terms Of Service", and
        VoiceMem swallows it as `[ingest] 抽取失败 ... 无原文，跳过` -- no
        traceback, no memory, no clue. Default to the model the pipeline already
        talks to, so one working key is enough to make memory work too.
        """
        model = os.getenv("VOICEMEM_LLM_MODEL") or os.getenv("OPENROUTER_MODEL")
        if model and os.getenv("OPENROUTER_API_KEY"):
            os.environ["OPENAI_MODEL"] = model

    def _construct(self):
        from voicemem import VoiceMem
        from voicemem.leftbrain.local_e5_embedder import LocalE5Embedder

        self._configure_llm_model()
        self.root.mkdir(parents=True, exist_ok=True)
        return VoiceMem(
            mode="text_mode",
            # Both are passed: user_id tags the rows inside the store, and an
            # explicit memory_root is what actually keeps two children apart.
            # Never rely on `space` here -- $VOICEMEM_MEMORY_ROOT overrides it
            # and would put every child into one shared store.
            user_id=self.user_id,
            memory_root=str(self.root),
            # Both of these default to OpenAI APIs, which would send every
            # sentence a child says off the machine on every single search --
            # measured here as 401s and multi-second stalls when the key was
            # wrong. The local E5 model does both jobs offline (and shares one
            # copy between them), which is what VoiceMem's own docs recommend
            # for their latency budget. Baked into the image at build time.
            embedding=lambda: LocalE5Embedder(),
            schema=self._local_slot_classifier,
            api_key=os.getenv("OPENROUTER_API_KEY") or os.getenv("OPENAI_API_KEY"),
            base_url=(
                "https://openrouter.ai/api/v1"
                if os.getenv("OPENROUTER_API_KEY")
                else os.getenv("OPENAI_BASE_URL")
            ),
            top_k=TOP_K,
            memory_language=self.language_code,
        )

    async def _restore_snapshot(self) -> bool:
        blob = await store.fetch_snapshot(self.user_id)
        if not blob:
            return False
        try:
            await asyncio.to_thread(self._extract_snapshot, blob)
        except Exception as exc:  # noqa: BLE001 - a bad tarball falls back to replay
            logger.warning(
                "Snapshot for {} could not be extracted ({}), rebuilding instead",
                self.user_id,
                exc,
            )
            await asyncio.to_thread(shutil.rmtree, self.root, True)
            return False
        logger.info("Restored memory snapshot for {}", self.user_id)
        return True

    def _extract_snapshot(self, blob: bytes) -> None:
        self.root.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
            # The archive is written by push_snapshot below, but it round-trips
            # through storage, so refuse anything that would escape the root.
            for member in tar.getmembers():
                target = (self.root / member.name).resolve()
                if not str(target).startswith(str(self.root.resolve())):
                    raise ValueError(f"unsafe path in snapshot: {member.name}")
            tar.extractall(self.root)

    async def _rebuild_from_supabase(self) -> None:
        """Replay every remembered utterance, oldest first.

        This is the expensive path -- one fact-extraction call per row -- so it
        only runs when there is no usable snapshot. `observed_at` carries the
        original timestamp; without it VoiceMem stamps everything "now" and
        every question about when something happened answers wrong.
        """
        rows = await store.fetch_memories(self.user_id)
        if not rows:
            return
        logger.info("Rebuilding memory for {} from {} rows", self.user_id, len(rows))
        vm = await asyncio.to_thread(self._construct)
        started = time.monotonic()
        for row in rows:
            try:
                await asyncio.to_thread(
                    vm.ingest,
                    row.content,
                    agent_reply=row.agent_reply,
                    observed_at=row.created_at,
                )
            except Exception as exc:  # noqa: BLE001 - one bad row must not stop the rest
                logger.warning("Replay of one memory row for {} failed: {}", self.user_id, exc)
        logger.info(
            "Rebuilt memory for {} in {:.1f}s",
            self.user_id,
            time.monotonic() - started,
        )

    async def acquire(self) -> None:
        self._refs += 1
        await self.start()

    async def release(self) -> None:
        self._refs = max(0, self._refs - 1)
        if self._refs > 0:
            return
        await self.close()

    async def close(self) -> None:
        """Drain pending writes, run the session-boundary batch, upload."""
        await self._queue.put(None)
        if self._worker is not None:
            try:
                await asyncio.wait_for(self._worker, timeout=30)
            except asyncio.TimeoutError:
                logger.warning("Memory worker for {} did not finish in time", self.user_id)
                self._worker.cancel()
            self._worker = None

        if self._vm is not None:
            try:
                await asyncio.to_thread(self._vm.flush)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Memory flush for {} failed: {}", self.user_id, exc)

        if self._dirty:
            await self._push_snapshot()
            self._dirty = False

    async def _push_snapshot(self) -> None:
        try:
            blob = await asyncio.to_thread(self._pack_snapshot)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not pack memory for {}: {}", self.user_id, exc)
            return
        await store.push_snapshot(self.user_id, blob)

    def _pack_snapshot(self) -> bytes:
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
            for path in sorted(self.root.rglob("*")):
                tar.add(path, arcname=str(path.relative_to(self.root)))
        return buffer.getvalue()

    # ── reads ────────────────────────────────────────────────────────────────

    async def search(self, text: str) -> str:
        """Prompt-ready memory for `text`, or "" when there is nothing.

        Rendering goes through VoiceMem's own `build_memory_context`, which is
        the library's single source of truth for turning a SearchResult into
        prompt text (it also caps right-brain hits at 3, a latency fix their
        demo measured).
        """
        if self._vm is None or not text.strip():
            return ""
        try:
            return await asyncio.to_thread(self._search_sync, text)
        except Exception as exc:  # noqa: BLE001 - never let a lookup break a turn
            # The store's vector index is a local Qdrant folder, and Qdrant
            # allows exactly one process per folder. A second server on the same
            # disk -- two containers sharing a volume, or a dev server started
            # alongside the real one -- therefore reads nothing at all while
            # still writing happily, which looks from the outside like a toy
            # that has simply stopped remembering. Name it, because the library's
            # own wording buries the cause.
            if "already accessed by another instance" in str(exc):
                logger.error(
                    "Memory search for {} failed: another process already holds "
                    "{}. Only one server may use a store at a time -- this one "
                    "will write memories but never recall any until that process "
                    "stops. Give each instance its own VOICEMEM_BASE_DIR, or run "
                    "a single server.",
                    self.user_id,
                    self.root,
                )
            else:
                logger.warning("Memory search for {} failed: {}", self.user_id, exc)
            return ""

    def _search_sync(self, text: str) -> str:
        from voicemem.memory_api import build_memory_context

        if USE_CLASSIFY:
            classification = self._vm.Classify(text)
            result = self._vm.Search(
                text,
                slots=classification.slots,
                entities=classification.entities,
                top_k=TOP_K,
            )
        else:
            result = self._vm.search(text)
        return build_memory_context(result)

    # ── writes ───────────────────────────────────────────────────────────────

    def enqueue(self, turn: PendingTurn) -> None:
        """Hand a finished exchange to the background worker. Never blocks."""
        self._queue.put_nowait(turn)

    async def _drain(self) -> None:
        while True:
            turn = await self._queue.get()
            if turn is None:
                self._queue.task_done()
                return
            try:
                await self._write_turn(turn)
            except Exception as exc:  # noqa: BLE001 - a failed write must not kill the worker
                logger.warning("Memory write for {} failed: {}", self.user_id, exc)
            finally:
                self._queue.task_done()

    async def _write_turn(self, turn: PendingTurn) -> None:
        # Supabase first: it is the source of truth, and a row written here can
        # rebuild the local store, whereas a local write we failed to mirror is
        # lost the next time the container restarts.
        await store.upsert_memories(
            self.user_id,
            [
                store.MemoryRow(
                    content=turn.user_text,
                    agent_reply=turn.agent_reply or None,
                    source_personality_key=turn.personality_key,
                )
            ],
        )
        await store.insert_conversation_turn(
            self.user_id, "user", turn.user_text, turn.personality_key, self.chat_group_id
        )
        if turn.agent_reply:
            await store.insert_conversation_turn(
                self.user_id,
                "assistant",
                turn.agent_reply,
                turn.personality_key,
                self.chat_group_id,
            )

        if self._vm is None:
            return
        # async_facts stays False: it hands the work to a daemon thread nobody
        # joins, so a disconnect would silently drop the last turn.
        await asyncio.to_thread(
            self._vm.ingest,
            turn.user_text,
            agent_reply=turn.agent_reply or None,
            session_id=self.chat_group_id,
        )
        self._dirty = True


# ── registry ─────────────────────────────────────────────────────────────────

_sessions: OrderedDict[str, MemorySession] = OrderedDict()
_registry_lock = asyncio.Lock()


async def acquire(user_id: str, language_code: str | None = None) -> MemorySession | None:
    """Get this child's memory, loading it if needed. None when unavailable.

    Every `None` here is a session that will not remember anything, and that is
    invisible from the outside: the toy talks normally and simply never recalls.
    So each reason says so out loud rather than returning a quiet None.
    """
    if not enabled():
        logger.info("VOICEMEM_ENABLED is off, running without memory")
        return None
    if not store.configured():
        logger.warning(
            "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unset or still the "
            "env.example placeholder, so this session cannot load or save "
            "memory. `supabase status` prints the local service role key."
        )
        return None
    if not user_id:
        logger.warning(
            "No user id for this session, running without memory. The browser "
            "sends one on the websocket query string and a device resolves one "
            "from its claimed account -- an empty one usually means the "
            "Supabase lookup failed, so check the warning above it."
        )
        return None
    try:
        from voicemem import VoiceMem  # noqa: F401 - import check only
    except Exception as exc:  # noqa: BLE001 - not installed is a valid deployment
        logger.warning("voicemem is not importable ({}), running without memory", exc)
        return None

    evictions: list[tuple[str, MemorySession]] = []
    async with _registry_lock:
        session = _sessions.pop(user_id, None)
        if session is None:
            session = MemorySession(user_id, language_code)
        _sessions[user_id] = session

        while len(_sessions) > MAX_SESSIONS:
            evicted_id, evicted = next(iter(_sessions.items()))
            if evicted is session:
                break
            _sessions.pop(evicted_id)
            evictions.append((evicted_id, evicted))

    # Closed outside the lock. close() drains the write queue and uploads a
    # snapshot, which can take tens of seconds; doing that while holding the
    # registry lock would stall every other device trying to connect. Same
    # reasoning as the socket close in server.py's device_refresh.
    for evicted_id, evicted in evictions:
        logger.info("Evicting cached memory for {}", evicted_id)
        try:
            await evicted.close()
        except Exception as exc:  # noqa: BLE001 - eviction must not fail a new session
            logger.warning("Could not flush evicted memory for {}: {}", evicted_id, exc)

    try:
        await session.acquire()
    except Exception as exc:  # noqa: BLE001 - a broken store must not refuse the session
        logger.warning("Could not load memory for {}: {}", user_id, exc)
        return None
    return session


async def warmup() -> None:
    """Load the local models once at startup, not on a child's first sentence."""
    if not enabled():
        return
    try:
        from voicemem import VoiceMem
    except Exception:  # noqa: BLE001
        return

    def _warm() -> None:
        from voicemem.leftbrain.local_e5_embedder import LocalE5Embedder

        probe = VoiceMem(
            mode="text_mode",
            memory_root=str(MEMORY_BASE / "_warmup"),
            # Same local components as a real session, or this warms the wrong
            # thing and the first child still pays the model load.
            embedding=lambda: LocalE5Embedder(),
            schema=MemorySession._local_slot_classifier,
        )
        # audio=False keeps this to the text path: the ASR, VAD and voiceprint
        # models are never used here and take about twenty seconds to load.
        # Loading E5 itself takes far longer on a cold container -- measured at
        # over two minutes when the weights still have to be downloaded, which
        # is why the image bakes them in.
        probe.warmup(audio=False, verbose=False)

    try:
        await asyncio.to_thread(_warm)
        logger.info("VoiceMem models warmed")
    except Exception as exc:  # noqa: BLE001
        logger.warning("VoiceMem warmup skipped: {}", exc)

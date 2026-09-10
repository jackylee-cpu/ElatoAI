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
import tarfile
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

from loguru import logger

from memory import privacy, store
from memory.summarise import summarise

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
# Completed turns between cold-path summaries. Every boundary costs one LLM
# call, so this trades money for how much of an abandoned session survives:
# whatever has not been summarised when the container dies is only in
# `memories`, and only a search can find it again.
SUMMARY_EVERY_TURNS = max(1, int(os.getenv("MEMORY_SUMMARY_EVERY_TURNS", "6")))
# How many of the previous segments the opening brief carries. Two is about one
# session's worth; more starts to crowd the character's own prompt.
BRIEF_SEGMENTS = max(0, int(os.getenv("MEMORY_BRIEF_SEGMENTS", "2")))
# How much of the running summary may go into a turn's memory block. The
# running summary exists to cover the turns that fell out of the history
# window, not to restate the whole session.
SESSION_SUMMARY_MAX_CHARS = int(os.getenv("MEMORY_SESSION_SUMMARY_MAX_CHARS", "400"))


def enabled() -> bool:
    return os.getenv("VOICEMEM_ENABLED", "true").strip().lower() in {"1", "true", "yes"}


_voicemem_ok: bool | None = None


def retrieval_available() -> bool:
    """Is VoiceMem importable in this deployment?

    Memory has two halves and only one of them needs the library. Retrieval --
    "what did this child tell me weeks ago about dinosaurs" -- is VoiceMem's
    job. Continuity -- "last time we talked about dinosaurs" -- is a summary
    read straight out of Supabase, and it is the half a child actually notices
    because it lands in the greeting.

    So a missing or broken VoiceMem must not switch memory off wholesale, which
    is what it used to do. This deployment spent a week with retrieval silently
    unavailable; there is no reason the toy should also have forgotten
    yesterday for that week.
    """
    global _voicemem_ok
    if _voicemem_ok is None:
        try:
            import voicemem  # noqa: F401
        except Exception as exc:  # noqa: BLE001 - not installed is a valid deployment
            logger.warning(
                "voicemem is not importable ({}), so this server will remember "
                "what was said in each session but cannot search across them",
                exc,
            )
            _voicemem_ok = False
        else:
            _voicemem_ok = True
    return _voicemem_ok


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
        self._built = False
        self._refs = 0
        self._revision = 0
        # None until this instance has actually read one. See _build().
        self._segments_revision: int | None = None
        self._ready = asyncio.Event()
        self._queue: asyncio.Queue[PendingTurn | None] = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self._dirty = False
        # One uuid per connection, written to conversations.chat_group_id and
        # handed to VoiceMem as its session id so both agree on turn grouping.
        self.chat_group_id: str | None = None

        # ── the always-ready half of memory ──────────────────────────────────
        # Everything above this line is retrieval: it needs a query and it
        # costs ~850ms. None of it can answer "hello". These three carry the
        # continuity instead, and every one of them is a plain string that was
        # loaded or written before the turn that reads it.
        #
        # What the last sessions ended on. Loaded once at start(), rendered
        # into the system prompt, so it is in front of the model for the
        # greeting -- the one turn a search can never serve.
        self.opening_brief = ""
        # What this session has covered so far, rebuilt every time the cold
        # path runs. This is what stops the history window from being a
        # forgetting window: turns that fall out of it are still represented
        # here.
        self.session_summary = ""
        self._turns_seen = 0
        self._pending_episodes: list[PendingTurn] = []
        self._session_segments: list[str] = []
        self._summarised_through = 0

        # ── the replay, moved off the critical path ──────────────────────────
        # A replay is one fact-extraction call per remembered utterance:
        # measured at 287s for seven rows. It used to be awaited before the
        # pipeline was built, so the toy said nothing at all for that whole
        # time and every client gave up first. It now runs in the background
        # and the session starts immediately with the always-ready half above
        # (the opening brief and the running summary), which is the same state
        # a deployment without retrieval configured already runs in.
        #
        # `_warming` is True while that is happening. Turns spoken during it
        # are already safe in Supabase -- _write_turn mirrors there first,
        # unconditionally -- but they are not yet in the local index, and the
        # replay reads a list of rows fetched before they existed. Buffering
        # them here and ingesting them once the store attaches is what stops
        # them being the one gap a completed replay never fills.
        self._warming = False
        self._warmup_turns: list[PendingTurn] = []
        self._warmup_task: asyncio.Task | None = None

    # ── lifecycle ────────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Load or rebuild this child's store. Safe to call once per session."""
        async with self._lock:
            if self._built and not await self._revision_changed():
                self._ready.set()
            else:
                await self._build()
                self._ready.set()
            # Outside the cache branch on purpose. A reconnect takes the fast
            # path above -- same instance, store still warm -- and that is
            # exactly the case that needs a fresh brief: the last session's
            # closing segment was written after this instance was built, so
            # skipping this is what makes "disconnect, reconnect, ask if it
            # remembers" answer no.
            if self._refs <= 1:
                await self._begin_session()
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._drain())

    async def _begin_session(self) -> None:
        """Reset per-session state and load what the last sessions ended on.

        Guarded on the reference count by the caller: two devices on one
        account share this instance, and resetting the counters under the
        second one would restart the first one's summary mid-conversation.
        """
        self._turns_seen = 0
        self._summarised_through = 0
        self._pending_episodes = []
        self._session_segments = []
        self.session_summary = ""
        segments = await store.fetch_recent_segments(self.user_id, BRIEF_SEGMENTS)
        self.opening_brief = " ".join(s.summary for s in segments).strip()
        if self.opening_brief:
            logger.info(
                "Loaded {} chars of opening brief for {} from {} segment(s)",
                len(self.opening_brief),
                self.user_id,
                len(segments),
            )
        else:
            logger.info(
                "No previous sessions to brief {} with, so this conversation "
                "starts cold. That is expected on a first session and a bug "
                "on a later one -- check for 'Wrote a session summary' in the "
                "log of the session before it.",
                self.user_id,
            )

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

        # A fresh instance is born with `_revision` 0, but the store it is
        # about to find on disk was built at some particular revision and
        # records it. Seeding from that is what stops every child whose parent
        # has *ever* deleted something from being replayed in full on the first
        # connection after each restart: their remote revision is permanently
        # above zero, so comparing it against 0 reads as a deletion that just
        # happened. This is the same trap the segments branch below already
        # documents -- this is the store half of it, and it was the expensive
        # half, because discarding the store also deletes the snapshot and so
        # forces the minutes-long replay path.
        if not self._built:
            stored_revision = self._read_stored_revision()
            if stored_revision is not None:
                self._revision = stored_revision

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

        # Segments are derived from utterances, so a deleted utterance can still
        # be quoted by a summary; dropping them is the only way a parent's delete
        # is actually a delete.
        #
        # But the baseline has to be "what this process last saw", not the 0 an
        # instance is born with. Keying it off self._revision instead wipes every
        # segment on the first connection after a restart, for every child whose
        # parent has ever deleted anything -- their revision is permanently above
        # zero, so a fresh process reads it as a change that just happened.
        # Observed here as "revision changed (0 -> 1)" on a server that had only
        # just started.
        if self._segments_revision is not None and remote_revision != self._segments_revision:
            logger.info(
                "Memory revision for {} changed ({} -> {}), discarding session summaries",
                self.user_id,
                self._segments_revision,
                remote_revision,
            )
            await store.delete_segments(self.user_id)
        self._segments_revision = remote_revision

        if not retrieval_available():
            # Not an error path. Segments are read and written without any of
            # this, so the session continues with continuity but no recall.
            self._built = True
            logger.info(
                "Memory ready for {} without retrieval (session summaries only)",
                self.user_id,
            )
            return

        replayed = False
        if not self.root.exists():
            restored = await self._restore_snapshot()
            if restored:
                # The snapshot carries the revision it was packed at. One that
                # predates a deletion has to go too: restoring it would quietly
                # resurrect what the parent removed, which is the one failure
                # this feature cannot have.
                snapshot_revision = self._read_stored_revision()
                if snapshot_revision is not None and snapshot_revision != remote_revision:
                    logger.info(
                        "Snapshot for {} predates a deletion ({} -> {}), replaying instead",
                        self.user_id,
                        snapshot_revision,
                        remote_revision,
                    )
                    await asyncio.to_thread(shutil.rmtree, self.root, True)
                    await store.delete_snapshot(self.user_id)
                    restored = False
            if not restored:
                replayed = True

        if replayed:
            # Start the session now and replay behind it. Retrieval is absent
            # until the store attaches; continuity is not, because the opening
            # brief and running summary do not depend on it.
            self._vm = None
            self._warming = True
            self._built = True
            self._warmup_task = asyncio.create_task(self._replay_in_background(remote_revision))
            logger.info(
                "Memory for {} is replaying in the background; this session "
                "starts with session summaries but no recall until it finishes",
                self.user_id,
            )
            return

        self._vm = await asyncio.to_thread(self._construct)
        # Written after _construct so the directory is certain to exist, and
        # before any snapshot is packed so the tarball carries it.
        self._write_stored_revision(remote_revision)
        self._built = True
        logger.info("Memory ready for {} at {}", self.user_id, self.root)

    async def _replay_in_background(self, remote_revision: int) -> None:
        """Rebuild the store from Supabase without holding up the greeting.

        Deliberately not cancelled when the session ends: the whole point is
        that the work survives a client giving up. The revision marker and the
        snapshot are written only once this completes, so a crash part-way
        leaves no marker and the next connection simply replays again -- which
        is correct, because Supabase still holds every row.
        """
        try:
            await self._rebuild_from_supabase()
            vm = await asyncio.to_thread(self._construct)

            async with self._lock:
                self._vm = vm
                # Anything said while the replay was running. It is in Supabase
                # already, but the row list the replay worked from predates it.
                buffered, self._warmup_turns = self._warmup_turns, []
                self._warming = False

            for turn in buffered:
                try:
                    await asyncio.to_thread(
                        vm.ingest,
                        turn.user_text,
                        agent_reply=turn.agent_reply or None,
                        session_id=self.chat_group_id,
                    )
                except Exception as exc:  # noqa: BLE001 - one row must not stop the rest
                    logger.warning(
                        "Could not ingest a turn buffered during replay for {}: {}",
                        self.user_id,
                        exc,
                    )
            if buffered:
                logger.info(
                    "Ingested {} turn(s) said while memory for {} was replaying",
                    len(buffered),
                    self.user_id,
                )

            self._write_stored_revision(remote_revision)
            # Persist straight away rather than waiting for close(). A replay
            # costs minutes, and the session that pays for it is exactly the
            # one most likely to have been abandoned -- which is what made a
            # slow first session look like a toy that had permanently stopped
            # talking.
            await self._push_snapshot()
            self._dirty = False
            logger.info("Memory ready for {} at {}", self.user_id, self.root)
        except Exception as exc:  # noqa: BLE001 - a failed replay must not kill the session
            logger.warning(
                "Background memory replay for {} failed: {}. No revision marker "
                "was written, so the next connection will try again.",
                self.user_id,
                exc,
            )
            async with self._lock:
                self._warming = False

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

    def _revision_file(self) -> Path:
        """Where the store records which revision it reflects.

        Inside the store directory on purpose: `_pack_snapshot` tars everything
        under the root, so this rides along in the snapshot and comes back with
        it. That is what lets a cold process tell "the parent deleted
        something" apart from "I have only just started".
        """
        return self.root / ".revision"

    def _read_stored_revision(self) -> int | None:
        """The revision this store was built at, or None if it does not say.

        None means a store written before this file existed, or an unreadable
        one. Both have to fall back to the old behaviour rather than guess: a
        wrong guess here either replays needlessly or, worse, keeps serving a
        memory a parent deleted.
        """
        try:
            return int(self._revision_file().read_text().strip())
        except (OSError, ValueError):
            return None

    def _write_stored_revision(self, revision: int) -> None:
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            self._revision_file().write_text(str(revision))
        except OSError as exc:  # noqa: BLE001 - losing this only costs one replay
            logger.warning(
                "Could not record memory revision for {}: {}", self.user_id, exc
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

        # The tail, after the queue drained so every turn of this session is
        # counted. Without this the last few turns -- which are the ones a
        # child is most likely to ask about next time -- never reach a segment,
        # because a session almost never ends on a summary boundary.
        await self._summarise_pending(reason="session end")

        if self._warming:
            # A replay is still running. Its own completion writes the marker
            # and uploads the snapshot, and it is deliberately not cancelled
            # here -- so leave both alone rather than packing a half-built
            # store over the top of it.
            logger.info(
                "Session for {} ended while memory was still replaying; the "
                "replay continues and will persist itself",
                self.user_id,
            )
            return

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
            if self._note_missing_schema(exc):
                pass
            elif "already accessed by another instance" in str(exc):
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

    def _note_missing_schema(self, exc: Exception) -> bool:
        """Was this "no such table", and if so, arrange a rebuild.

        VoiceMem builds its tables lazily, from several cached components -- so
        a store on disk legitimately holds only the tables the paths exercised
        so far, and the shape of the directory says nothing about its health.
        What does break it is the file being replaced underneath a live
        instance (deleting a store while the server runs): the cached
        components keep their handles, sqlite serves them a fresh empty
        database, and every call after that fails with "no such table" for the
        life of the process.

        Dropping `_vm` makes the next session rebuild it, which re-runs those
        constructors and recreates what is missing. Deliberately not a rebuild
        in place: this runs inside an exception handler, on a worker thread, in
        the middle of somebody's turn.
        """
        if "no such table" not in str(exc):
            return False
        logger.error(
            "Memory store for {} lost its schema ({}). Its files were most "
            "likely replaced while the server was running -- deleting a store "
            "needs the server stopped first. Rebuilding on the next session.",
            self.user_id,
            exc,
        )
        self._vm = None
        return True

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
                if not self._note_missing_schema(exc):
                    logger.warning("Memory write for {} failed: {}", self.user_id, exc)
            finally:
                self._queue.task_done()

    async def _write_turn(self, turn: PendingTurn) -> None:
        # A turn carrying a phone number, an ID or a card number is transcribed
        # but never remembered. The check runs before both writes rather than on
        # one of them: gating only the Supabase mirror would leave the number in
        # the live VoiceMem store until the next restart, so the toy would repeat
        # it today and forget it tomorrow. See memory/privacy.py for what this
        # does and does not catch.
        sensitive = privacy.holds_sensitive_number(turn.user_text) or (
            privacy.holds_sensitive_number(turn.agent_reply)
        )
        if sensitive:
            logger.info(
                "A turn for {} held a long number, so it stays in the transcript "
                "but not in memory",
                self.user_id,
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
            return

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

        if self._warming:
            # The store is still replaying. This turn is already in Supabase
            # (above), so nothing is lost; it is held here because the replay
            # is working from a row list that predates it, and would otherwise
            # finish and write its marker without ever having seen it.
            self._warmup_turns.append(turn)
            return

        if self._vm is not None:
            try:
                # async_facts stays False: it hands the work to a daemon thread
                # nobody joins, so a disconnect would silently drop the last
                # turn.
                await asyncio.to_thread(
                    self._vm.ingest,
                    turn.user_text,
                    agent_reply=turn.agent_reply or None,
                    session_id=self.chat_group_id,
                )
                self._dirty = True
            except Exception as exc:  # noqa: BLE001 - see below
                # Caught here rather than in the worker, and that placement is
                # the point: an ingest that raises used to take the rest of this
                # function with it, so a store that could not write also stopped
                # the turn being counted and the session summary being built.
                # One broken half must not disable the other.
                logger.warning("VoiceMem ingest for {} failed: {}", self.user_id, exc)

        # Deliberately outside the block above, and outside its failure. Segments
        # are what carries this conversation into the next one, and they have to
        # keep being written whether or not the vector store is working.
        self._turns_seen += 1
        self._pending_episodes.append(turn)
        if len(self._pending_episodes) >= SUMMARY_EVERY_TURNS:
            await self._summarise_pending(reason="turn boundary")


    async def _summarise_pending(self, *, reason: str) -> None:
        """Compress the turns since the last segment into one row.

        Runs in the write worker or on close, never on the frame path.

        A failure drops the pending turns rather than holding them for the next
        boundary. Retrying would make every later segment cover a longer and
        longer stretch, so one bad minute would end up producing a summary far
        too long for the prompt it feeds -- and the utterances themselves are
        still in `memories` either way, which is the copy that matters.
        """
        episodes = self._pending_episodes
        if not episodes:
            return
        self._pending_episodes = []
        from_turn = self._summarised_through
        to_turn = self._turns_seen
        self._summarised_through = to_turn

        summary = await summarise(episodes, self.language_code)
        if not summary:
            logger.info(
                "No session summary for {} at {} (turns {}-{}); the next "
                "conversation will not hear about this stretch",
                self.user_id,
                reason,
                from_turn,
                to_turn,
            )
            return

        self._session_segments.append(summary)
        self.session_summary = self._join_session_summary()
        await store.insert_segment(
            self.user_id, self.chat_group_id, from_turn, to_turn, summary
        )
        logger.info(
            "Wrote a session summary for {} at {} covering turns {}-{}: {}",
            self.user_id,
            reason,
            from_turn,
            to_turn,
            summary,
        )

    def _join_session_summary(self) -> str:
        """This session's segments, oldest first, inside the character budget.

        Oldest are dropped rather than truncated: half a sentence about what a
        child said is worse than not mentioning it, because the model will
        happily complete it.
        """
        segments = list(self._session_segments)
        while segments and len(" ".join(segments)) > SESSION_SUMMARY_MAX_CHARS:
            segments.pop(0)
        return " ".join(segments).strip()

    # ── prompt blocks ────────────────────────────────────────────────────────

    def opening_brief_block(self) -> str:
        """The system-prompt half of memory: what the last sessions ended on.

        This goes into the system instruction at pipeline build time, not into
        a per-turn message, and that placement is the whole point: the greeting
        runs before the child has said anything, so it is the one turn no
        retrieval can ever serve. It is also the turn where being remembered
        actually shows.
        """
        if not self.opening_brief:
            return ""
        return (
            "WHAT YOU REMEMBER FROM YOUR LAST CONVERSATIONS WITH THIS CHILD:\n"
            f"{self.opening_brief}\n"
            "Treat that as your own memory of them. Bring it up naturally when "
            "it fits, the way a friend would; never announce that you were "
            "given notes and never read it back as a list. If something is not "
            "written there, you do not know it -- ask, do not guess."
        )

    def session_block(self) -> str:
        """The running summary of this conversation, for the per-turn block.

        Pairs with the history window in MemoryProcessor: the window keeps the
        last few turns verbatim, this keeps the gist of everything before them.
        Without it, trimming history would simply be forgetting.
        """
        if not self.session_summary:
            return ""
        return f"EARLIER IN THIS CONVERSATION:\n{self.session_summary}"


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
    # Deliberately no check on voicemem here. It used to refuse the session
    # outright, which meant one missing wheel cost the toy its whole memory --
    # including the session summaries, which do not need it. `_build()` decides
    # per-half instead.

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

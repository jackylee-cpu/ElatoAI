"""Long-term memory for one child: who they are, and what you did together.

Everything here lives in Supabase and is read as plain text into the prompt.
Nothing is searched per turn. Two kinds of memory, written by one LLM call
(memory/summarise.py) every few turns and at the end of a session:

  * `memory_facts` -- who the child is. All active facts go into the system
    prompt at connect, so the greeting already knows the dog's name.
  * `memory_segments` -- what each stretch was about. The last couple of
    sessions with substance become the opening brief, and this session's own
    segments are the running summary that covers turns the history window
    has dropped.

This replaced a VoiceMem vector store (removed 2026-09-24). It searched on
every turn, which cost 0.6-0.9s of CPU that stalled the event loop by up to
100ms, and every remembered sentence cost ~3 LLM calls. It also kept a local
store that needed snapshots, replays and revision markers to survive a
restart, and most of the memory bugs found were in that machinery. For a child
the list of things worth knowing is short enough to keep in the prompt.

**Blocking.** Nothing here is ever awaited on the frame path. Turns go through
a write queue drained by a background worker, and consolidation has a worker
of its own.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from datetime import date, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from loguru import logger

from memory import privacy, store
from memory.summarise import consolidate
from metrics import store as metrics_store

# Completed turns between cold-path summaries. Every boundary costs one LLM
# call, so this trades money for how much of an abandoned session survives:
# whatever has not been consolidated when the container dies is only in the
# `conversations` transcript.
SUMMARY_EVERY_TURNS = max(1, int(os.getenv("MEMORY_SUMMARY_EVERY_TURNS", "6")))
# How many of the previous segments the opening brief carries. Two is about one
# session's worth; more starts to crowd the character's own prompt.
BRIEF_SEGMENTS = max(0, int(os.getenv("MEMORY_BRIEF_SEGMENTS", "2")))
# Sessions shorter than this are skipped when choosing the brief, as long as a
# longer one is available. Most sessions are one or two turns (measured on the
# dev data: 44 of 57), and "the last two segments" was routinely two sessions
# that only asked the time -- pushing out the one that said the dog's name.
BRIEF_MIN_TURNS = max(0, int(os.getenv("MEMORY_BRIEF_MIN_TURNS", "3")))
# How far back to look for those longer sessions.
BRIEF_LOOKBACK_SEGMENTS = 12
# Active facts rendered into the system prompt, newest kept when there are more.
FACTS_IN_PROMPT = max(0, int(os.getenv("MEMORY_FACTS_IN_PROMPT", "40")))
# Consolidation calls per stretch before its turns are given up on. One retry:
# with facts riding on the same call, a single dropped call now loses who the
# child is as well as what was said.
CONSOLIDATE_ATTEMPTS = 2
CONSOLIDATE_RETRY_SECONDS = 2.0
# How much of the running summary may go into a turn's memory block. The
# running summary exists to cover the turns that fell out of the history
# window, not to restate the whole session.
SESSION_SUMMARY_MAX_CHARS = int(os.getenv("MEMORY_SESSION_SUMMARY_MAX_CHARS", "400"))




def enabled() -> bool:
    # VOICEMEM_ENABLED is the old name, honoured so an existing .env that turned
    # memory off does not quietly turn it back on.
    value = os.getenv("MEMORY_ENABLED") or os.getenv("VOICEMEM_ENABLED") or "true"
    return value.strip().lower() in {"1", "true", "yes"}


@dataclass
class PendingTurn:
    """A completed exchange waiting to be written to memory and to Supabase."""

    user_text: str
    agent_reply: str
    personality_key: str | None
    observed_at: str
    # Stamped when the turn is written, not when it is indexed: indexing can
    # run minutes behind, by which time `MemorySession.chat_group_id` may
    # already belong to the next connection.
    chat_group_id: str | None = None


@dataclass
class _Stretch:
    """Turns handed to consolidation, with everything about where they came from.

    Captured when the stretch is cut, not when it is processed: the worker can
    run after the session ends, and by then the instance's counters and
    chat_group_id may belong to the next connection.
    """

    turns: list[PendingTurn]
    from_turn: int
    to_turn: int
    chat_group_id: str | None
    reason: str


def choose_brief(segments: list, count: int, min_turns: int) -> list:
    """The segments for the opening brief: the latest from sessions with substance.

    A session's length is the highest `to_turn` among its segments. One
    without a chat_group_id cannot be measured and is kept, as is everything
    when no session clears the bar -- a thin brief beats no brief.
    """
    if count <= 0:
        return []
    length: dict[str, int] = {}
    for segment in segments:
        group = segment.chat_group_id
        if group:
            length[group] = max(length.get(group, 0), segment.to_turn)
    substantial = [
        segment
        for segment in segments
        if not segment.chat_group_id or length[segment.chat_group_id] >= min_turns
    ]
    return (substantial or segments)[-count:]


class MemorySession:
    """The memory for one child, for the duration of one connection.

    Shared while live: two connections from the same board -- a reconnect that
    lands before the old socket has closed -- get the same instance, and
    `acquire()` / `release()` reference-count so the last one out closes
    it. Each new connection after that gets a fresh instance, which is cheap --
    everything it knows is read from Supabase in `_begin_session()`.

    Two workers, because the two jobs cost wildly different amounts. The write
    queue (`_drain`) puts each turn in the transcript and counts it, a few
    hundred ms. Consolidation (`_drain_consolidation`) is an LLM call. They
    were once one queue with the slow step in the middle, and close() cancelled
    it after 30s, losing every turn still queued -- measured 2026-09-23, two
    five-turn sessions kept only their first turn.
    """

    def __init__(
        self,
        user_id: str,
        device_id: str,
        ip_key: str,
        language_code: str | None = None,
        revision: int | None = None,
    ):
        self.user_id = user_id
        # Which board on the account this memory is. Each board remembers its
        # own child -- an account with two toys usually has two children.
        self.device_id = device_id
        # Whose world this memory belongs to. Every read and write is scoped
        # to it, so one IP's characters never hear what was told to another's.
        self.ip_key = ip_key
        self.language_code = language_code
        # `devices.memories_revision` as it was when this session started. Every
        # write carries it, and the database refuses it once a parent has
        # cleared this board's memory since (store._stamp). None writes
        # unstamped, which nothing checks.
        self.revision = revision
        self._refs = 0
        self._lock = asyncio.Lock()
        self._queue: asyncio.Queue[PendingTurn | None] = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        # One uuid per connection, written to conversations.chat_group_id and
        # to every segment and fact learned in it.
        self.chat_group_id: str | None = None
        # The account's clock, for turning "next Saturday" into a date. Set by
        # the caller like chat_group_id; None falls back to the server's.
        self.timezone: str | None = None

        # What the last sessions ended on. Loaded once at start(), rendered
        # into the system prompt, so it is in front of the model for the
        # greeting.
        self.opening_brief = ""
        # Who the child is. Loaded at start() into the system prompt with the
        # brief, and kept for the whole session: facts learned during it are
        # already in the history window and the running summary.
        self.facts: list[store.Fact] = []
        # What this session has covered so far, rebuilt every time a stretch
        # is consolidated. This is what stops the history window from being a
        # forgetting window: turns that fall out of it are still represented
        # here.
        self.session_summary = ""
        self._turns_seen = 0
        self._pending_episodes: list[PendingTurn] = []
        self._session_segments: list[str] = []
        self._summarised_through = 0
        # Consolidation runs on its own worker, not on the write queue, and is
        # not cancelled by close(): the session-end stretch is cut as the
        # session ends, which is exactly when a cancellable task would die.
        self._consolidate_queue: asyncio.Queue[_Stretch] = asyncio.Queue()
        self._consolidate_worker: asyncio.Task | None = None

    # ── lifecycle ────────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Load what this child's memory holds. Once per connection."""
        async with self._lock:
            # Only the first connection in. Resetting under the second one would
            # restart the first one's summary mid-conversation.
            if self._refs <= 1:
                await self._begin_session()
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._drain())

    async def _begin_session(self) -> None:
        """Reset per-session state and load what the last sessions ended on.

        Guarded on the reference count by the caller: two connections from one
        board share this instance, and resetting the counters under the
        second one would restart the first one's summary mid-conversation.
        """
        self._turns_seen = 0
        self._summarised_through = 0
        self._pending_episodes = []
        self._session_segments = []
        self.session_summary = ""
        recent, facts = await asyncio.gather(
            store.fetch_recent_segments(
                self.user_id, self.device_id, self.ip_key, BRIEF_LOOKBACK_SEGMENTS
            ),
            store.fetch_active_facts(self.user_id, self.device_id, self.ip_key, FACTS_IN_PROMPT),
        )
        if facts is None:
            logger.warning(
                "Could not read the facts known about {}; this session starts "
                "without them",
                self.user_id,
            )
        self.facts = facts or []
        if self.facts:
            logger.info("Loaded {} fact(s) about {}", len(self.facts), self.user_id)
        segments = choose_brief(recent, BRIEF_SEGMENTS, BRIEF_MIN_TURNS)
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

    async def acquire(self) -> None:
        self._refs += 1
        await self.start()

    async def release(self) -> None:
        self._refs = max(0, self._refs - 1)
        if self._refs > 0:
            return
        await self.close()

    async def close(self) -> None:
        """Drain pending writes and hand the last stretch to consolidation."""
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
        # because a session almost never ends on a summary boundary. For most
        # sessions it is the only stretch there is: they are shorter than one.
        # Handed to the worker rather than awaited, so it survives this
        # connection going away.
        self._schedule_consolidation("session end")

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
        await store.insert_conversation_turn(
            self.user_id,
            self.device_id,
            self.ip_key,
            "user",
            turn.user_text,
            turn.personality_key,
            self.chat_group_id,
            revision=self.revision,
        )
        if turn.agent_reply:
            await store.insert_conversation_turn(
                self.user_id,
                self.device_id,
                self.ip_key,
                "assistant",
                turn.agent_reply,
                turn.personality_key,
                self.chat_group_id,
                revision=self.revision,
            )

        # A turn carrying a phone number, an ID or a card number is transcribed
        # but never remembered: not counted, so it reaches no segment and no
        # fact. The summariser prompt also refuses them, and facts are checked
        # again before they are written; this is the check that does not rely
        # on a model listening. See memory/privacy.py for what it catches.
        if privacy.holds_sensitive_number(turn.user_text) or privacy.holds_sensitive_number(
            turn.agent_reply
        ):
            logger.info(
                "A turn for {} held a long number, so it stays in the transcript "
                "but not in memory",
                self.user_id,
            )
            return

        self._turns_seen += 1
        self._pending_episodes.append(turn)
        if len(self._pending_episodes) >= SUMMARY_EVERY_TURNS:
            # Off this queue: a consolidation is an LLM call, and waiting on it
            # here would hold every later turn's transcript write behind it.
            self._schedule_consolidation("turn boundary")

    # ── consolidation: segments and facts ───────────────────────────────────

    def _cut_stretch(self, reason: str) -> _Stretch | None:
        """Take the turns since the last cut. Synchronous, so nothing slips in."""
        turns = self._pending_episodes
        if not turns:
            return None
        self._pending_episodes = []
        stretch = _Stretch(
            turns=turns,
            from_turn=self._summarised_through,
            to_turn=self._turns_seen,
            chat_group_id=self.chat_group_id,
            reason=reason,
        )
        self._summarised_through = self._turns_seen
        return stretch

    def _schedule_consolidation(self, reason: str) -> None:
        stretch = self._cut_stretch(reason)
        if stretch is None:
            return
        self._consolidate_queue.put_nowait(stretch)
        if self._consolidate_worker is None:
            self._consolidate_worker = asyncio.create_task(self._drain_consolidation())

    async def _drain_consolidation(self) -> None:
        """One stretch at a time, in order: each sees the facts the last one added.

        Clears its handle only with the queue empty and nothing awaited between
        that check and the return, so a stretch queued at any moment either
        sees this worker still running or starts a new one -- never stranded.
        """
        try:
            while not self._consolidate_queue.empty():
                stretch = self._consolidate_queue.get_nowait()
                try:
                    await self._consolidate(stretch)
                except Exception as exc:  # noqa: BLE001 - one stretch must not stop the rest
                    logger.warning(
                        "Consolidating turns {}-{} for {} failed: {}",
                        stretch.from_turn,
                        stretch.to_turn,
                        self.user_id,
                        exc,
                    )
            self._consolidate_worker = None
        except BaseException:
            self._consolidate_worker = None
            raise

    async def wait_for_consolidation(self) -> None:
        """Until every cut stretch has been consolidated."""
        while self._consolidate_worker is not None:
            await asyncio.shield(self._consolidate_worker)

    async def _summarise_pending(self, *, reason: str) -> None:
        """Cut the pending turns and consolidate them now, awaited."""
        stretch = self._cut_stretch(reason)
        if stretch is not None:
            await self._consolidate(stretch)

    def _today(self) -> date:
        """Today on the account's clock, which is where "tomorrow" is measured."""
        try:
            now = datetime.now(ZoneInfo(self.timezone)) if self.timezone else datetime.now()
        except (ZoneInfoNotFoundError, ValueError):
            now = datetime.now()
        return now.date()

    async def _consolidate(self, stretch: _Stretch) -> None:
        """One stretch -> at most one segment and any new facts.

        A failure after the retry gives the turns up rather than folding them
        into the next stretch: that would make each later call cover a longer
        and longer stretch. They are still in `conversations`, so a stretch
        lost here can be recovered from the transcript.
        """
        known = await store.fetch_active_facts(self.user_id, self.device_id, self.ip_key)
        if known is None:
            # Fall back to what this session loaded, so the model can still
            # see what it already knows rather than re-adding all of it.
            known = list(self.facts)

        result = None
        for attempt in range(CONSOLIDATE_ATTEMPTS):
            result = await consolidate(
                stretch.turns,
                [fact.content for fact in known],
                self._today(),
                self.language_code,
                on_usage=lambda model, usage: self._record_usage(
                    model, usage, stretch.chat_group_id
                ),
            )
            if result is not None:
                break
            if attempt + 1 < CONSOLIDATE_ATTEMPTS:
                await asyncio.sleep(CONSOLIDATE_RETRY_SECONDS)
        if result is None:
            logger.warning(
                "Gave up consolidating turns {}-{} for {} at {}; they are in "
                "`conversations` but in no segment and no fact",
                stretch.from_turn,
                stretch.to_turn,
                self.user_id,
                stretch.reason,
            )
            return

        if result.summary:
            # Only into this session's running summary if it is still this
            # session: a session-end stretch can finish after the next one began.
            if stretch.chat_group_id == self.chat_group_id:
                self._session_segments.append(result.summary)
                self.session_summary = self._join_session_summary()
            await store.insert_segment(
                self.user_id,
                self.device_id,
                self.ip_key,
                stretch.chat_group_id,
                stretch.from_turn,
                stretch.to_turn,
                result.summary,
                revision=self.revision,
            )
            # The summary is the child's words retold: DEBUG only (P1-02).
            logger.info(
                "Wrote a session summary for {} at {} covering turns {}-{} ({} chars)",
                self.user_id,
                stretch.reason,
                stretch.from_turn,
                stretch.to_turn,
                len(result.summary),
            )
            logger.debug("Session summary for {}: {}", self.user_id, result.summary)
        else:
            logger.info(
                "Nothing worth a summary for {} at {} (turns {}-{})",
                self.user_id,
                stretch.reason,
                stretch.from_turn,
                stretch.to_turn,
            )

        await self._record_facts(result.facts, known, stretch.chat_group_id)

    def _record_usage(self, model: str, usage: dict, chat_group_id: str | None) -> None:
        """Bill one consolidation call to this board, beside its turns.

        It runs outside the voice pipeline, so the turn observer never sees
        it; without this row the usage page would undercount every session
        that was long enough to be summarised.
        """
        row = {
            "row_kind": "memory",
            "llm_provider": "openrouter" if os.getenv("OPENROUTER_API_KEY") else "openai",
            "llm_model": model,
            "prompt_tokens": usage.get("prompt_tokens"),
            "completion_tokens": usage.get("completion_tokens"),
            "user_id": self.user_id,
            "device_id": self.device_id,
        }
        if chat_group_id:
            row["chat_group_id"] = chat_group_id
        metrics_store.record_turn(row)

    async def _record_facts(self, new_facts, known: list[store.Fact], chat_group_id) -> None:
        known_texts = {fact.content.strip() for fact in known}
        for new in new_facts:
            text = new.text.strip()
            if text in known_texts:
                # Told not to, and does anyway now and then.
                continue
            # The prompt forbids these; this is the check that does not rely
            # on the model listening. Same rule as the write path.
            if privacy.holds_sensitive_number(text):
                logger.info("Dropped a fact about {} that held a long number", self.user_id)
                continue
            fact_id = await store.insert_fact(
                self.user_id,
                self.device_id,
                self.ip_key,
                chat_group_id,
                text,
                revision=self.revision,
            )
            if fact_id is None:
                continue
            known_texts.add(text)
            fact = store.Fact(fact_id=fact_id, content=text)
            self.facts.append(fact)
            replaced = known[new.replaces] if new.replaces is not None else None
            if replaced is not None:
                await store.supersede_fact(self.user_id, replaced.fact_id, fact_id)
                self.facts = [f for f in self.facts if f.fact_id != replaced.fact_id]
                logger.info(
                    "Learned a fact about {} ({} chars), replacing an older one",
                    self.user_id,
                    len(text),
                )
                logger.debug(
                    "Learned about {}: {!r} (replaces {!r})",
                    self.user_id,
                    text,
                    replaced.content,
                )
            else:
                logger.info("Learned a fact about {} ({} chars)", self.user_id, len(text))
                logger.debug("Learned about {}: {!r}", self.user_id, text)

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

    def facts_block(self) -> str:
        """The system-prompt list of who this child is.

        Next to the brief rather than per turn, for the same reason: the
        greeting needs it, and it does not change during a session.
        """
        if not self.facts:
            return ""
        lines = "\n".join(f"- {fact.content}" for fact in self.facts)
        return (
            "WHAT YOU KNOW ABOUT THIS CHILD:\n"
            f"{lines}\n"
            "These are things they told you themselves. Use them the way a "
            "friend would -- call them what they asked to be called, remember "
            "their pets and what they love -- without reciting them."
        )

    def prompt_preamble(self) -> str:
        """Everything memory puts in the system prompt: who they are, then last time."""
        return "\n\n".join(
            block for block in (self.facts_block(), self.opening_brief_block()) if block
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

# Live sessions only, so two connections from one board share one (a board that
# reconnects before its old socket has closed). A session leaves when its last
# connection does; a finishing consolidation keeps the object alive on its own.
# Keyed by board and by IP: each board on an account is its own memory, and so
# is each IP on a board.
_sessions: dict[tuple[str, str, str], MemorySession] = {}
_registry_lock = asyncio.Lock()


async def acquire(
    user_id: str,
    device_id: str | None,
    ip_key: str | None,
    language_code: str | None = None,
    revision: int | None = None,
) -> MemorySession | None:
    """Get this child's memory for a new connection. None when unavailable.

    Every `None` here is a session that will not remember anything, and that is
    invisible from the outside: the toy talks normally and simply never recalls.
    So each reason says so out loud rather than returning a quiet None.
    """
    if not enabled():
        logger.info("MEMORY_ENABLED is off, running without memory")
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
            "No user id for this session, running without memory. A device "
            "resolves one from its claimed account -- an empty one usually "
            "means the Supabase lookup failed, so check the warning above it."
        )
        return None
    if not device_id:
        # Memory is a board's. The web playground has none and runs without.
        logger.info("No device for {}'s session, running without memory", user_id)
        return None

    if not ip_key:
        # Not the same as the default IP. The character's IP could not be
        # read, and loading the wrong IP's memories into it is worse than
        # remembering nothing for one session.
        logger.warning(
            "No IP for {}'s character, running without memory. The character "
            "lookup failed; check the warning above it.",
            user_id,
        )
        return None

    key = (user_id, device_id, ip_key)
    async with _registry_lock:
        session = _sessions.get(key)
        if (
            session is not None
            and revision is not None
            and (session.revision or 0) < revision
        ):
            # The memory was cleared while that session was live. It still
            # holds what was cleared, and everything it writes is refused, so
            # this connection starts its own. The old one stays alive for
            # whoever still holds it and leaves the registry alone on release.
            logger.info(
                "Memory for {} was cleared since its live session started; "
                "this connection starts a new one",
                user_id,
            )
            session = None
        if session is None:
            session = _sessions[key] = MemorySession(
                user_id, device_id, ip_key, language_code, revision
            )
    try:
        await session.acquire()
    except Exception as exc:  # noqa: BLE001 - a broken read must not refuse the session
        logger.warning("Could not load memory for {}: {}", user_id, exc)
        await release(session)
        return None
    return session


async def release(session: MemorySession) -> None:
    """The connection is over. The last one out closes the session."""
    await session.release()
    if session._refs == 0:
        key = (session.user_id, session.device_id, session.ip_key)
        async with _registry_lock:
            if _sessions.get(key) is session:
                del _sessions[key]

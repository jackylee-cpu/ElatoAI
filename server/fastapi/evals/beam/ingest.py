"""Feed BEAM conversations through the real memory code, with Supabase faked.

Everything that decides what is remembered is the production code:
MemorySession cuts the stretches, summarise.consolidate makes the real LLM
call (MEMORY_SUMMARY_MODEL from .env), `_record_facts` applies replacements,
and `choose_brief` / `prompt_preamble` build what the next session would see.
Only the store is swapped for an in-memory one, and `_today()` is pinned to
each session's BEAM time anchor so relative dates resolve the way they would
have on that day.

Each BEAM session is one connection: a fresh MemorySession, its own
chat_group_id, turns enqueued in order, then close() -- which is where the
session-end stretch is consolidated, as in production. After the last one, one
more session is started and its `prompt_preamble()` is what the answering
model is given.
"""

from __future__ import annotations

import asyncio
import contextvars
import itertools
import json
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from evals.beam.data import Conversation
from evals.beam.prompts import ADULT_CONSOLIDATION_SYSTEM
from memory import privacy, store, summarise
from memory import session as memory_session
from memory.session import MemorySession

# Stretches of BEAM turns are far longer than a child's: a six-turn stretch of
# technical answers is ~30k characters. The production 20s would time out on
# input the toy never sends, so both configs get more room; failures are
# counted either way.
CONSOLIDATION_TIMEOUT = 90.0

# name -> {(module, attribute): value}. "prod" changes nothing that decides
# what is kept.
CONFIGS: dict[str, dict[tuple[object, str], object]] = {
    "prod": {
        (summarise, "TIMEOUT_SECONDS"): CONSOLIDATION_TIMEOUT,
    },
    "adult": {
        (summarise, "TIMEOUT_SECONDS"): CONSOLIDATION_TIMEOUT,
        (summarise, "_SYSTEM"): ADULT_CONSOLIDATION_SYSTEM,
        (summarise, "FACT_MAX_CHARS"): 300,
        (summarise, "SEGMENT_MAX_CHARS"): 600,
        (summarise, "MAX_TOKENS"): 4000,
        (memory_session, "FACTS_IN_PROMPT"): 200,
        (memory_session, "BRIEF_SEGMENTS"): 50,
        (memory_session, "BRIEF_MIN_TURNS"): 0,
        (memory_session, "BRIEF_LOOKBACK_SEGMENTS"): 200,
    },
}


# Configs whose prompt blocks drop the child framing. The production headings
# ("WHAT YOU KNOW ABOUT THIS CHILD", "call them what they asked to be
# called, remember their pets") are part of what prod is and stay there; under
# adult they would contradict facts about a 49-year-old developer.
NEUTRAL_HEADINGS = {"adult"}


@contextmanager
def applied(config: str):
    saved = []
    for (module, name), value in CONFIGS[config].items():
        saved.append((module, name, getattr(module, name)))
        setattr(module, name, value)
    try:
        yield
    finally:
        for module, name, value in reversed(saved):
            setattr(module, name, value)


# ── the fake store ───────────────────────────────────────────────────────────


@dataclass
class _FactRow:
    fact_id: str
    content: str
    chat_group_id: str | None
    superseded_by: str | None = None


@dataclass
class _UserStore:
    facts: list[_FactRow] = field(default_factory=list)
    segments: list[store.Segment] = field(default_factory=list)
    transcript_rows: int = 0


class FakeStore:
    """memory.store's interface, in memory, one namespace per user_id."""

    def __init__(self):
        self.users: dict[str, _UserStore] = {}
        self._ids = itertools.count(1)

    def user(self, user_id: str) -> _UserStore:
        return self.users.setdefault(user_id, _UserStore())

    async def fetch_recent_segments(self, user_id, limit=2):
        segments = self.user(user_id).segments
        return list(segments[-limit:]) if limit else []

    async def insert_segment(self, user_id, chat_group_id, from_turn, to_turn, summary):
        self.user(user_id).segments.append(
            store.Segment(
                summary=summary,
                from_turn=from_turn,
                to_turn=to_turn,
                chat_group_id=chat_group_id,
            )
        )
        return True

    async def fetch_active_facts(self, user_id, limit=200):
        active = [f for f in self.user(user_id).facts if f.superseded_by is None]
        return [store.Fact(fact_id=f.fact_id, content=f.content) for f in active[-limit:]]

    async def insert_fact(self, user_id, chat_group_id, content):
        fact_id = f"f{next(self._ids)}"
        self.user(user_id).facts.append(_FactRow(fact_id, content, chat_group_id))
        return fact_id

    async def supersede_fact(self, user_id, fact_id, replaced_by):
        for row in self.user(user_id).facts:
            if row.fact_id == fact_id:
                row.superseded_by = replaced_by
                return True
        return False

    async def insert_conversation_turn(self, user_id, role, content, personality_key, group):
        self.user(user_id).transcript_rows += 1
        return True


_PATCHED = (
    "fetch_recent_segments",
    "insert_segment",
    "fetch_active_facts",
    "insert_fact",
    "supersede_fact",
    "insert_conversation_turn",
)


@contextmanager
def patched_store(fake: FakeStore):
    saved = [(name, getattr(store, name)) for name in _PATCHED]
    for name in _PATCHED:
        setattr(store, name, getattr(fake, name))
    try:
        yield
    finally:
        for name, original in saved:
            setattr(store, name, original)


# ── counting consolidation calls per conversation ────────────────────────────


@dataclass
class Stats:
    consolidation_calls: int = 0
    consolidation_failures: int = 0
    turns: int = 0
    turns_dropped_by_privacy: int = 0


_current: contextvars.ContextVar[Stats | None] = contextvars.ContextVar("beam_stats", default=None)


@contextmanager
def counted_consolidation():
    """Wrap summarise.consolidate as MemorySession sees it, and count per task.

    The workers MemorySession starts are created inside the conversation's
    task, so they inherit its context -- and with it the right Stats.
    """
    original = memory_session.consolidate

    async def wrapper(*args, **kwargs):
        result = await original(*args, **kwargs)
        stats = _current.get()
        if stats is not None:
            stats.consolidation_calls += 1
            if result is None:
                stats.consolidation_failures += 1
        return result

    memory_session.consolidate = wrapper
    try:
        yield
    finally:
        memory_session.consolidate = original


class _AnchoredSession(MemorySession):
    """A MemorySession whose "today" is the BEAM session's time anchor."""

    def __init__(
        self,
        user_id: str,
        language_code: str | None,
        day: date | None,
        neutral: bool = False,
    ):
        super().__init__(user_id, language_code)
        self._day = day
        self._neutral = neutral

    def _today(self) -> date:
        return self._day or super()._today()

    def facts_block(self) -> str:
        if not self._neutral or not self.facts:
            return super().facts_block()
        lines = "\n".join(f"- {fact.content}" for fact in self.facts)
        return f"WHAT YOU KNOW ABOUT THIS USER:\n{lines}"

    def opening_brief_block(self) -> str:
        if not self._neutral or not self.opening_brief:
            return super().opening_brief_block()
        return f"WHAT YOU REMEMBER FROM YOUR LAST CONVERSATIONS WITH THIS USER:\n{self.opening_brief}"


# ── ingest ───────────────────────────────────────────────────────────────────


async def ingest_conversation(
    conversation: Conversation, fake: FakeStore, neutral: bool = False
) -> dict:
    """Run every session through memory; return what the next session would see."""
    stats = Stats()
    _current.set(stats)
    user_id = f"beam-{conversation.conv_id}"

    for session in conversation.sessions:
        memory = _AnchoredSession(user_id, "en-US", session.day, neutral)
        memory.chat_group_id = f"{user_id}-s{session.index + 1}"
        await memory.acquire()
        for turn in session.turns:
            stats.turns += 1
            if privacy.holds_sensitive_number(turn.user_text) or privacy.holds_sensitive_number(
                turn.agent_reply
            ):
                stats.turns_dropped_by_privacy += 1
            memory.enqueue(turn)
        await memory.release()
        await memory.wait_for_consolidation()

    final = _AnchoredSession(user_id, "en-US", conversation.last_day, neutral)
    await final._begin_session()
    preamble = final.prompt_preamble()

    record = fake.user(user_id)
    return {
        "conv_id": conversation.conv_id,
        "title": conversation.title,
        "preamble": preamble,
        "active_facts": [f.content for f in final.facts],
        "all_facts": [
            {
                "id": f.fact_id,
                "content": f.content,
                "session": f.chat_group_id,
                "superseded_by": f.superseded_by,
            }
            for f in record.facts
        ],
        "segments": [
            {"session": s.chat_group_id, "turns": [s.from_turn, s.to_turn], "summary": s.summary}
            for s in record.segments
        ],
        "stats": {
            **stats.__dict__,
            "sessions": len(conversation.sessions),
            "facts_written": len(record.facts),
            "facts_superseded": sum(1 for f in record.facts if f.superseded_by),
            "facts_active": sum(1 for f in record.facts if not f.superseded_by),
            "facts_in_prompt": len(final.facts),
            "segments_written": len(record.segments),
            "preamble_chars": len(preamble),
        },
    }


async def ingest(
    conversations: list[Conversation], config: str, out_dir: Path, concurrency: int = 4
) -> None:
    """Ingest every conversation not already saved under out_dir/memory/<config>/."""
    folder = out_dir / "memory" / config
    folder.mkdir(parents=True, exist_ok=True)
    todo = [c for c in conversations if not (folder / f"{c.conv_id}.json").exists()]
    if not todo:
        print(f"  ingest[{config}]: nothing to do")
        return

    fake = FakeStore()
    gate = asyncio.Semaphore(concurrency)

    async def one(conversation: Conversation) -> None:
        async with gate:
            result = await ingest_conversation(conversation, fake, config in NEUTRAL_HEADINGS)
            result["config"] = config
            path = folder / f"{conversation.conv_id}.json"
            path.write_text(json.dumps(result, ensure_ascii=False, indent=2))
            s = result["stats"]
            print(
                f"  ingest[{config}] conv {conversation.conv_id}: "
                f"{s['consolidation_calls']} calls ({s['consolidation_failures']} failed), "
                f"{s['facts_active']} active facts, {s['facts_superseded']} superseded, "
                f"{s['segments_written']} segments, preamble {s['preamble_chars']} chars"
            )

    with applied(config), patched_store(fake), counted_consolidation():
        # One task per conversation, so each gets its own context for Stats.
        await asyncio.gather(*(asyncio.create_task(one(c)) for c in todo))

"""Behaviour tests for the always-ready half of memory.

The properties worth pinning here are the ones whose failure is silent. A
missing opening brief does not raise -- the toy simply greets a child it has
known for a month as a stranger, and nothing in the logs looks wrong unless you
already know what to grep for. Same for the history window: trimming without
the running summary to cover it would read as the toy getting vaguer the longer
you talk to it.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipecat.frames.frames import (  # noqa: E402
    InterimTranscriptionFrame,
    TranscriptionFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext  # noqa: E402
from pipecat.tests.utils import run_test  # noqa: E402

from memory import session as memory_session  # noqa: E402
from memory import store  # noqa: E402
from memory.processors import MemoryProcessor  # noqa: E402
from memory.session import MemorySession, PendingTurn  # noqa: E402


class FakeMemory:
    """Stands in for MemorySession where only the prompt blocks matter."""

    def __init__(self, running="", result=""):
        self.running = running
        self.result = result
        self.chat_group_id = "session-1"

    def session_block(self):
        return self.running

    async def search(self, text):
        return self.result

    def enqueue(self, turn):
        pass


def transcription(text, final=True):
    cls = TranscriptionFrame if final else InterimTranscriptionFrame
    return cls(text=text, user_id="u", timestamp="t")


def turn(user_text, agent_reply="ok"):
    return PendingTurn(
        user_text=user_text,
        agent_reply=agent_reply,
        personality_key=None,
        observed_at="2026-09-09T00:00:00",
    )


# ── the history window ───────────────────────────────────────────────────────


async def test_history_window_keeps_the_last_exchanges():
    memory = FakeMemory()
    context = LLMContext()
    context.set_messages(
        [{"role": "developer", "content": "say hello"}]
        + [
            {"role": role, "content": f"line {index}"}
            for index in range(6)
            for role in ("user", "assistant")
        ]
    )
    processor = MemoryProcessor(memory, context, max_history_turns=2)

    await run_test(
        processor,
        frames_to_send=[transcription("and then")],
        expected_down_frames=[TranscriptionFrame],
    )

    messages = context.get_messages()
    history = [m for m in messages if m.get("role") in ("user", "assistant")]
    assert len(history) == 4, f"expected 2 exchanges, got {len(history)}"
    assert history[0]["content"] == "line 4", history[0]
    print("  ok: only the last exchanges survive the window")


async def test_history_window_keeps_the_greeting_instruction():
    """The connect-time developer message is not history and must not be cut."""
    memory = FakeMemory()
    context = LLMContext()
    context.set_messages(
        [{"role": "developer", "content": "start by introducing yourself"}]
        + [
            {"role": role, "content": f"line {index}"}
            for index in range(6)
            for role in ("user", "assistant")
        ]
    )
    processor = MemoryProcessor(memory, context, max_history_turns=1)

    await run_test(
        processor,
        frames_to_send=[transcription("hello again")],
        expected_down_frames=[TranscriptionFrame],
    )

    kept = [m for m in context.get_messages() if m.get("role") == "developer"]
    assert any("introducing yourself" in m["content"] for m in kept), kept
    print("  ok: the greeting instruction outlives the window")


async def test_window_of_zero_keeps_everything():
    memory = FakeMemory()
    context = LLMContext()
    context.set_messages(
        [
            {"role": role, "content": f"line {index}"}
            for index in range(6)
            for role in ("user", "assistant")
        ]
    )
    processor = MemoryProcessor(memory, context, max_history_turns=0)

    await run_test(
        processor,
        frames_to_send=[transcription("keep it all")],
        expected_down_frames=[TranscriptionFrame],
    )

    history = [m for m in context.get_messages() if m.get("role") in ("user", "assistant")]
    assert len(history) == 12, len(history)
    print("  ok: trimming can be turned off")


# ── the running summary ──────────────────────────────────────────────────────


async def test_running_summary_is_injected_without_any_search_hit():
    """The half that costs nothing must land even when retrieval finds nothing.

    This is the case the deployment actually hits: VOICEMEM_SEARCH_BLOCK_MS is
    0, so most turns get no search result at all.
    """
    memory = FakeMemory(running="EARLIER IN THIS CONVERSATION:\nWe talked about jellyfish.")
    context = LLMContext()
    processor = MemoryProcessor(memory, context)

    await run_test(
        processor,
        frames_to_send=[transcription("what else")],
        expected_down_frames=[TranscriptionFrame],
    )

    injected = [
        m for m in context.get_messages() if "<<voicemem>>" in str(m.get("content", ""))
    ]
    assert len(injected) == 1, injected
    assert "jellyfish" in injected[0]["content"]
    print("  ok: the running summary is injected with no search hit")


async def test_nothing_to_say_writes_no_memory_message():
    memory = FakeMemory(running="", result="")
    context = LLMContext()
    processor = MemoryProcessor(memory, context)

    await run_test(
        processor,
        frames_to_send=[transcription("hello")],
        expected_down_frames=[TranscriptionFrame],
    )

    injected = [
        m for m in context.get_messages() if "<<voicemem>>" in str(m.get("content", ""))
    ]
    assert not injected, injected
    print("  ok: an empty block leaves the prompt alone")


# ── segments ─────────────────────────────────────────────────────────────────


class RecordingStore:
    """Captures what would have gone to Supabase."""

    def __init__(self, recent=()):
        self.recent = list(recent)
        self.inserted = []

    async def fetch_recent_segments(self, user_id, limit=2):
        return self.recent[-limit:] if limit else []

    async def insert_segment(self, user_id, chat_group_id, from_turn, to_turn, summary):
        self.inserted.append((user_id, chat_group_id, from_turn, to_turn, summary))
        return True


def patch_store(monkey, fake):
    for name in ("fetch_recent_segments", "insert_segment"):
        monkey.append((name, getattr(store, name)))
        setattr(store, name, getattr(fake, name))


def restore_store(monkey):
    for name, original in monkey:
        setattr(store, name, original)


async def test_a_boundary_writes_a_segment_and_updates_the_running_summary():
    fake = RecordingStore()
    saved = []
    patch_store(saved, fake)
    original_summarise = memory_session.summarise
    memory_session.summarise = lambda turns, language=None: _immediate("Talked about jellyfish.")
    try:
        session = MemorySession("child-1")
        session.chat_group_id = "group-1"
        session._pending_episodes = [turn("i like jellyfish"), turn("they glow")]
        session._turns_seen = 2

        await session._summarise_pending(reason="test")

        assert fake.inserted == [("child-1", "group-1", 0, 2, "Talked about jellyfish.")], (
            fake.inserted
        )
        assert "jellyfish" in session.session_block()
        assert session._pending_episodes == []
        print("  ok: a boundary writes a segment and updates the running summary")
    finally:
        memory_session.summarise = original_summarise
        restore_store(saved)


async def test_a_failed_summary_does_not_replay_the_same_turns():
    """A dropped summary must not make every later one cover a longer stretch."""
    fake = RecordingStore()
    saved = []
    patch_store(saved, fake)
    original_summarise = memory_session.summarise
    memory_session.summarise = lambda turns, language=None: _immediate("")
    try:
        session = MemorySession("child-1")
        session._pending_episodes = [turn("one"), turn("two")]
        session._turns_seen = 2
        await session._summarise_pending(reason="test")

        assert fake.inserted == [], fake.inserted
        assert session._pending_episodes == []
        assert session._summarised_through == 2
        print("  ok: a failed summary drops its turns instead of replaying them")
    finally:
        memory_session.summarise = original_summarise
        restore_store(saved)


async def test_a_broken_vector_store_still_counts_the_turn():
    """The two halves of memory must fail independently.

    Found by running a session with a VoiceMem that had no API key: `ingest()`
    raised, and because the turn accounting sat after it in the same function,
    the turn was never counted and no summary was ever built. The toy lost both
    halves of its memory to one broken one.
    """

    class ExplodingVoiceMem:
        def ingest(self, *args, **kwargs):
            raise RuntimeError("no api key")

    fake = RecordingStore()
    saved = []
    patch_store(saved, fake)
    original_upsert = store.upsert_memories
    original_insert = store.insert_conversation_turn
    store.upsert_memories = lambda *a, **k: _immediate(0)
    store.insert_conversation_turn = lambda *a, **k: _immediate(False)
    try:
        session = MemorySession("child-1")
        session._vm = ExplodingVoiceMem()

        await session._write_turn(turn("i like jellyfish"))

        assert session._turns_seen == 1, session._turns_seen
        assert len(session._pending_episodes) == 1, session._pending_episodes
        print("  ok: a failing ingest still leaves the turn counted")
    finally:
        store.upsert_memories = original_upsert
        store.insert_conversation_turn = original_insert
        restore_store(saved)


async def test_a_restart_does_not_wipe_the_segments():
    """A fresh process must not read a standing revision as a fresh delete.

    `memories_revision` never goes back down, so any child whose parent has
    ever deleted a memory has a revision above zero forever. An instance is
    born believing the revision is 0, so keying the segment wipe off that value
    deletes every summary on the first connection after each restart -- which
    is exactly the state this was found in: "revision changed (0 -> 1)" logged
    by a server that had been up for eighteen seconds.
    """
    fake = RecordingStore()
    deleted = []

    async def fetch_revision(user_id):
        return 1

    async def delete_segments(user_id):
        deleted.append(user_id)
        return True

    saved = []
    patch_store(saved, fake)
    originals = {
        name: getattr(store, name)
        for name in ("fetch_memories_revision", "delete_segments")
    }
    store.fetch_memories_revision = fetch_revision
    store.delete_segments = delete_segments
    original_available = memory_session.retrieval_available
    memory_session.retrieval_available = lambda: False
    try:
        session = MemorySession("child-1")

        await session._build()
        assert deleted == [], "a first build must not delete anything"

        # Same instance, nothing changed remotely: still nothing to delete.
        await session._build()
        assert deleted == [], deleted

        # Now the parent really does delete something.
        store.fetch_memories_revision = lambda user_id: _immediate(2)
        await session._build()
        assert deleted == ["child-1"], deleted
        print("  ok: only a real revision change discards the summaries")
    finally:
        memory_session.retrieval_available = original_available
        for name, original in originals.items():
            setattr(store, name, original)
        restore_store(saved)


async def test_the_opening_brief_is_loaded_at_session_start():
    fake = RecordingStore(
        recent=[
            store.Segment(summary="Built a rocket out of blocks.", from_turn=0, to_turn=6),
            store.Segment(
                summary="Promised to hear about the dog next time.", from_turn=6, to_turn=9
            ),
        ]
    )
    saved = []
    patch_store(saved, fake)
    try:
        session = MemorySession("child-1")
        await session._begin_session()

        block = session.opening_brief_block()
        assert "rocket" in block and "dog" in block, block
        assert "WHAT YOU REMEMBER" in block
        # A fresh session must not inherit the last one's running summary.
        assert session.session_block() == ""
        print("  ok: the opening brief is loaded before the first turn")
    finally:
        restore_store(saved)


async def test_no_history_means_no_brief_block():
    fake = RecordingStore(recent=[])
    saved = []
    patch_store(saved, fake)
    try:
        session = MemorySession("child-1")
        await session._begin_session()
        assert session.opening_brief_block() == ""
        print("  ok: a first session gets no brief and no empty heading")
    finally:
        restore_store(saved)


async def _immediate(value):
    return value


async def main():
    tests = [
        test_history_window_keeps_the_last_exchanges,
        test_history_window_keeps_the_greeting_instruction,
        test_window_of_zero_keeps_everything,
        test_running_summary_is_injected_without_any_search_hit,
        test_nothing_to_say_writes_no_memory_message,
        test_a_boundary_writes_a_segment_and_updates_the_running_summary,
        test_a_failed_summary_does_not_replay_the_same_turns,
        test_a_broken_vector_store_still_counts_the_turn,
        test_a_restart_does_not_wipe_the_segments,
        test_the_opening_brief_is_loaded_at_session_start,
        test_no_history_means_no_brief_block,
    ]
    failed = 0
    for test in tests:
        print(f"{test.__name__}:")
        try:
            await test()
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL: {exc}")
        except Exception as exc:
            failed += 1
            import traceback
            print(f"  ERROR: {type(exc).__name__}: {exc}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return failed


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

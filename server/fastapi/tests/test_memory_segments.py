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


async def test_a_long_number_is_transcribed_but_not_remembered():
    """Both memory writes are gated, and the transcript still gets the turn.

    Gating one of the two would be worse than gating neither: the number would
    live in the running VoiceMem store until the next restart, so the toy would
    say it back today and have forgotten it tomorrow.
    """
    fake = RecordingStore()
    saved = []
    patch_store(saved, fake)

    upserted, conversation_rows = [], []
    original_upsert = store.upsert_memories
    original_insert = store.insert_conversation_turn
    store.upsert_memories = lambda user_id, rows: _record(upserted, rows, 0)
    store.insert_conversation_turn = lambda user_id, role, content, *a: _record(
        conversation_rows, (role, content), True
    )

    ingested = []

    class RecordingVoiceMem:
        def ingest(self, *args, **kwargs):
            ingested.append(args)

    try:
        session = MemorySession("child-1")
        session._vm = RecordingVoiceMem()

        await session._write_turn(turn("我的电话是13812345678", "好的，我记住了"))
        assert upserted == [], upserted
        assert ingested == [], ingested
        assert session._turns_seen == 0, session._turns_seen
        assert len(conversation_rows) == 2, conversation_rows

        # An ordinary turn is unaffected.
        await session._write_turn(turn("我最喜欢的动物是水母", "水母会发光呢"))
        assert len(upserted) == 1, upserted
        assert len(ingested) == 1, ingested
        assert session._turns_seen == 1, session._turns_seen
        print("  ok: a long number is transcribed but never remembered")
    finally:
        store.upsert_memories = original_upsert
        store.insert_conversation_turn = original_insert
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


class _StoreBuildHarness:
    """Drive MemorySession._build with every expensive step stubbed out.

    Records whether the local store was thrown away and whether the replay --
    the minutes-long path -- was entered.
    """

    def __init__(self, session, remote_revision):
        self.session = session
        self.remote_revision = remote_revision
        self.snapshot_deleted = []
        self.replayed = 0
        self.snapshots_pushed = 0
        self.restore_result = False
        self._originals = {}

    def __enter__(self):
        for name in ("fetch_memories_revision", "delete_snapshot", "delete_segments"):
            self._originals[name] = getattr(store, name)
        store.fetch_memories_revision = lambda user_id: _immediate(self.remote_revision)
        store.delete_snapshot = lambda user_id: self._deleted(user_id)
        store.delete_segments = lambda user_id: _immediate(True)

        self._available = memory_session.retrieval_available
        memory_session.retrieval_available = lambda: True

        self.session._restore_snapshot = self._restore
        self.session._rebuild_from_supabase = self._replay
        self.session._construct = lambda: object()
        self.session._push_snapshot = self._push
        return self

    def __exit__(self, *exc):
        for name, original in self._originals.items():
            setattr(store, name, original)
        memory_session.retrieval_available = self._available
        return False

    async def _deleted(self, user_id):
        self.snapshot_deleted.append(user_id)
        return True

    async def _restore(self):
        return self.restore_result

    async def _replay(self):
        self.replayed += 1

    async def _push(self):
        self.snapshots_pushed += 1

    async def finish(self):
        """Wait for the background replay, if _build started one.

        The replay is deliberately off the critical path now, so a test that
        asserts on its results has to say when it wants them.
        """
        task = self.session._warmup_task
        if task is not None:
            await asyncio.wait_for(task, timeout=10)


def _store_dir(session, revision=None):
    """Create the on-disk store, optionally recording a revision in it."""
    session.root.mkdir(parents=True, exist_ok=True)
    (session.root / "qdrant").mkdir(exist_ok=True)
    if revision is not None:
        session._write_stored_revision(revision)


async def test_a_restart_does_not_replay_the_whole_store():
    """The expensive sibling of test_a_restart_does_not_wipe_the_segments.

    Discarding the store also deletes the snapshot, which forces the replay
    path: one fact-extraction call per remembered utterance. Measured at 200
    seconds for seven rows, and it happens before the pipeline is built, so the
    toy is silent for that whole time. Because the snapshot is only pushed when
    a session ends cleanly, a client that gave up left nothing behind and the
    next connection paid it again -- indistinguishable, from the outside, from
    a toy that had simply stopped working.
    """
    import shutil

    session = MemorySession("child-restart")
    shutil.rmtree(session.root, ignore_errors=True)
    try:
        # The store on disk was built when the revision was already 1.
        _store_dir(session, revision=1)
        with _StoreBuildHarness(session, remote_revision=1) as h:
            await session._build()
            assert h.replayed == 0, "a cold start replayed a store that was already current"
            assert h.snapshot_deleted == [], h.snapshot_deleted
        print("  ok: a standing revision is not read as a fresh delete")
    finally:
        shutil.rmtree(session.root, ignore_errors=True)


async def test_a_real_deletion_still_discards_the_store():
    """The invariant the fix above must not break.

    A parent removing a memory has to win over every cache. If this ever stops
    holding, the toy keeps talking about something a parent deliberately
    deleted -- the one failure this feature cannot have.
    """
    import shutil

    session = MemorySession("child-deleted")
    shutil.rmtree(session.root, ignore_errors=True)
    try:
        _store_dir(session, revision=1)
        with _StoreBuildHarness(session, remote_revision=2) as h:
            await session._build()
            # The discard is synchronous -- a parent's delete must take effect
            # before the session serves anything.
            assert h.snapshot_deleted == ["child-deleted"], h.snapshot_deleted
            await h.finish()
            assert h.replayed == 1, "a discarded store must be replayed"
        print("  ok: a real deletion still wipes the store")
    finally:
        shutil.rmtree(session.root, ignore_errors=True)


async def test_a_store_that_does_not_record_a_revision_is_replayed():
    """Stores written before .revision existed have to keep the old behaviour.

    Guessing "probably current" here would serve a deleted memory, so an
    unreadable or absent marker deliberately falls back to discarding.
    """
    import shutil

    session = MemorySession("child-legacy")
    shutil.rmtree(session.root, ignore_errors=True)
    try:
        _store_dir(session, revision=None)
        with _StoreBuildHarness(session, remote_revision=1) as h:
            await session._build()
            assert h.snapshot_deleted == ["child-legacy"], h.snapshot_deleted
        print("  ok: a store with no revision marker is discarded, not trusted")
    finally:
        shutil.rmtree(session.root, ignore_errors=True)


async def test_a_stale_snapshot_is_not_restored_over_a_deletion():
    """A snapshot packed before a delete must not resurrect it.

    The snapshot carries .revision inside the tarball, so this is checkable
    after restoring but before the store is used.
    """
    import shutil

    session = MemorySession("child-stale-snap")
    shutil.rmtree(session.root, ignore_errors=True)
    try:
        with _StoreBuildHarness(session, remote_revision=3) as h:
            # No local store, and the snapshot restores as revision 1.
            async def restore():
                _store_dir(session, revision=1)
                return True

            session._restore_snapshot = restore
            await session._build()
            assert h.snapshot_deleted == ["child-stale-snap"], h.snapshot_deleted
            await h.finish()
            assert h.replayed == 1, "a stale snapshot must fall through to a replay"
        print("  ok: a snapshot predating a deletion is thrown away")
    finally:
        shutil.rmtree(session.root, ignore_errors=True)


async def test_a_current_snapshot_is_used_without_replaying():
    import shutil

    session = MemorySession("child-fresh-snap")
    shutil.rmtree(session.root, ignore_errors=True)
    try:
        with _StoreBuildHarness(session, remote_revision=3) as h:
            async def restore():
                _store_dir(session, revision=3)
                return True

            session._restore_snapshot = restore
            await session._build()
            assert h.replayed == 0, "replayed despite a current snapshot"
            assert h.snapshot_deleted == [], h.snapshot_deleted
        print("  ok: a current snapshot skips the replay")
    finally:
        shutil.rmtree(session.root, ignore_errors=True)


async def test_a_replay_is_snapshotted_immediately():
    """So an impatient client does not leave the work to be done again.

    close() only pushes at a clean teardown. A replay costs minutes; the
    session that pays for it is exactly the one most likely to be abandoned.
    """
    import shutil

    session = MemorySession("child-replay-push")
    shutil.rmtree(session.root, ignore_errors=True)
    try:
        with _StoreBuildHarness(session, remote_revision=1) as h:
            await session._build()
            await h.finish()
            assert h.replayed == 1, "expected the replay path"
            assert h.snapshots_pushed == 1, "a replay was not persisted immediately"
        print("  ok: a replay is uploaded as soon as it finishes")
    finally:
        shutil.rmtree(session.root, ignore_errors=True)


async def test_the_revision_marker_is_recorded_after_a_build():
    import shutil

    session = MemorySession("child-marker")
    shutil.rmtree(session.root, ignore_errors=True)
    try:
        with _StoreBuildHarness(session, remote_revision=7) as h:
            await session._build()
            await h.finish()
        assert session._read_stored_revision() == 7, session._read_stored_revision()
        print("  ok: the store records the revision it reflects")
    finally:
        shutil.rmtree(session.root, ignore_errors=True)


async def test_the_replay_does_not_hold_up_the_greeting():
    """The measured symptom: 287s of silence before the toy said anything.

    _build used to await the replay, and server.py awaits _build before the
    pipeline is built, so the whole thing sat in front of the first word. It
    must now return with the session usable and the replay still running.
    """
    import shutil

    session = MemorySession("child-nonblocking")
    shutil.rmtree(session.root, ignore_errors=True)
    gate = asyncio.Event()
    try:
        with _StoreBuildHarness(session, remote_revision=1) as h:
            async def slow_replay():
                await gate.wait()
                h.replayed += 1

            session._rebuild_from_supabase = slow_replay

            await asyncio.wait_for(session._build(), timeout=2)
            assert session._built is True, "the session was not usable"
            assert session._warming is True, "the replay was not backgrounded"
            assert h.replayed == 0, "_build waited for the replay after all"

            gate.set()
            await h.finish()
            assert session._warming is False
            assert session._vm is not None, "the store never attached"
        print("  ok: the session starts while the replay runs behind it")
    finally:
        gate.set()
        shutil.rmtree(session.root, ignore_errors=True)


async def test_a_turn_said_during_the_replay_still_reaches_the_index():
    """The gap backgrounding introduces, and the reason for the buffer.

    The replay works from a list of rows fetched before the session started, so
    a turn spoken while it runs is in Supabase but not in that list. Without
    buffering, the replay would finish, write its marker -- and that turn would
    never be indexed, because a matching marker means no future replay.
    """
    import shutil

    session = MemorySession("child-midreplay")
    shutil.rmtree(session.root, ignore_errors=True)
    gate = asyncio.Event()
    ingested = []
    try:
        with _StoreBuildHarness(session, remote_revision=1) as h:
            async def slow_replay():
                await gate.wait()

            class RecordingVm:
                def ingest(self, text, agent_reply=None, session_id=None):
                    ingested.append(text)

            session._rebuild_from_supabase = slow_replay
            session._construct = RecordingVm

            await session._build()
            assert session._warming is True

            # The child says something while the replay is still going.
            await session._write_turn(turn("i like jellyfish", "Me too!"))
            assert ingested == [], "ingested into a store that does not exist yet"
            assert len(session._warmup_turns) == 1, session._warmup_turns

            gate.set()
            await h.finish()
            assert ingested == ["i like jellyfish"], ingested
            assert session._warmup_turns == [], "the buffer was not drained"
        print("  ok: a turn said mid-replay is buffered and then indexed")
    finally:
        gate.set()
        shutil.rmtree(session.root, ignore_errors=True)


async def test_a_failed_replay_leaves_no_marker_so_it_is_retried():
    """A marker written on a failed replay would make the failure permanent."""
    import shutil

    session = MemorySession("child-failed-replay")
    shutil.rmtree(session.root, ignore_errors=True)
    try:
        with _StoreBuildHarness(session, remote_revision=4) as h:
            async def boom():
                raise RuntimeError("openrouter said no")

            session._rebuild_from_supabase = boom
            await session._build()
            await h.finish()

            assert session._warming is False, "left stuck in the warming state"
            assert session._read_stored_revision() is None, (
                "a failed replay recorded a marker, so it will never be retried"
            )
            assert h.snapshots_pushed == 0, "uploaded a store that was never built"
        print("  ok: a failed replay is retried on the next connection")
    finally:
        shutil.rmtree(session.root, ignore_errors=True)


async def test_closing_mid_replay_does_not_overwrite_the_snapshot():
    """close() must not pack a half-built store over the replay's own upload."""
    import shutil

    session = MemorySession("child-close-midreplay")
    shutil.rmtree(session.root, ignore_errors=True)
    gate = asyncio.Event()
    try:
        with _StoreBuildHarness(session, remote_revision=1) as h:
            async def slow_replay():
                await gate.wait()

            session._rebuild_from_supabase = slow_replay
            await session._build()
            session._dirty = True

            await session.close()
            assert h.snapshots_pushed == 0, "close() uploaded a store mid-replay"

            gate.set()
            await h.finish()
            assert h.snapshots_pushed == 1, "the replay did not persist itself"
        print("  ok: an abandoned session leaves the replay to finish and save")
    finally:
        gate.set()
        shutil.rmtree(session.root, ignore_errors=True)


async def _immediate(value):
    return value


async def _record(sink, item, result):
    sink.append(item)
    return result


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
        test_a_restart_does_not_replay_the_whole_store,
        test_a_real_deletion_still_discards_the_store,
        test_a_store_that_does_not_record_a_revision_is_replayed,
        test_a_stale_snapshot_is_not_restored_over_a_deletion,
        test_a_current_snapshot_is_used_without_replaying,
        test_a_replay_is_snapshotted_immediately,
        test_the_revision_marker_is_recorded_after_a_build,
        test_the_replay_does_not_hold_up_the_greeting,
        test_a_turn_said_during_the_replay_still_reaches_the_index,
        test_a_failed_replay_leaves_no_marker_so_it_is_retried,
        test_closing_mid_replay_does_not_overwrite_the_snapshot,
        test_a_long_number_is_transcribed_but_not_remembered,
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

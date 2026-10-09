"""Memory per board, and a cleared memory stays cleared (P1-12).

Every write the voice server makes names its board and is stamped with the
`devices.memories_revision` its session started under; the database refuses a
stamp older than the board's (migration 20261009140000). These check the
server's half: that every write carries both, that each board on an account is
its own memory, and that a connection made after a clear does not join a
session that started before it.

Nothing leaves the machine; the store and the registry are stubbed.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from test_memory_segments import consolidating, turn  # noqa: E402

from memory import session as memory_session  # noqa: E402
from memory import store  # noqa: E402
from memory.session import MemorySession, _Stretch  # noqa: E402
from memory.summarise import NewFact  # noqa: E402

# ── store: writes name the board and carry the stamp ────────────────────────


async def _rows_posted(monkeypatch, call):
    posted = []

    async def post(url, payload, **kwargs):
        posted.extend(payload)
        return True

    async def post_returning(url, payload, **kwargs):
        posted.extend(payload)
        return [{"fact_id": "f1"}]

    monkeypatch.setattr(store, "configured", lambda: True)
    monkeypatch.setattr(store, "_post_json", post)
    monkeypatch.setattr(store, "_post_json_returning", post_returning)
    await call()
    return posted


async def test_every_write_names_its_board_and_carries_the_revision(monkeypatch):
    async def writes():
        await store.insert_conversation_turn(
            "u", "board-1", "house", "user", "hi", None, "g", revision=3
        )
        await store.insert_segment("u", "board-1", "house", "g", 0, 2, "talked", revision=3)
        await store.insert_fact("u", "board-1", "house", "g", "has a dog", revision=3)

    rows = await _rows_posted(monkeypatch, writes)
    assert len(rows) == 3
    assert all(row["memories_revision"] == 3 for row in rows), rows
    assert all(row["device_id"] == "board-1" for row in rows), rows


async def test_no_revision_writes_unstamped(monkeypatch):
    async def writes():
        await store.insert_conversation_turn("u", "board-1", "house", "user", "hi", None, "g")

    rows = await _rows_posted(monkeypatch, writes)
    assert "memories_revision" not in rows[0]


async def test_nothing_is_written_without_a_board(monkeypatch):
    async def writes():
        await store.insert_conversation_turn("u", "", "house", "user", "hi", None, "g")
        await store.insert_segment("u", "", "house", "g", 0, 2, "talked")
        await store.insert_fact("u", "", "house", "g", "has a dog")

    assert await _rows_posted(monkeypatch, writes) == []


# ── store: reads are per board ──────────────────────────────────────────────


async def test_reads_ask_for_one_board_only(monkeypatch):
    seen = []

    async def capture(url, **kwargs):
        seen.append(url)
        return []

    monkeypatch.setattr(store, "configured", lambda: True)
    monkeypatch.setattr(store, "_get_json", capture)
    await store.fetch_recent_segments("u", "board-1", "house")
    await store.fetch_active_facts("u", "board-1", "house")
    assert len(seen) == 2
    assert all("user_id=eq.u" in url and "device_id=eq.board-1" in url for url in seen), seen


# ── session: it stamps with the revision it started under ───────────────────


async def test_session_writes_with_its_board_and_starting_revision(monkeypatch):
    seen = []

    async def record(user_id, device_id, *args, revision=None, **kwargs):
        seen.append((device_id, revision))
        return "f1"

    monkeypatch.setattr(store, "insert_conversation_turn", record)
    monkeypatch.setattr(store, "insert_segment", record)
    monkeypatch.setattr(store, "insert_fact", record)

    async def no_facts(*args, **kwargs):
        return []

    monkeypatch.setattr(store, "fetch_active_facts", no_facts)
    monkeypatch.setattr(
        memory_session,
        "consolidate",
        consolidating("talked about the dog", [NewFact("has a dog", None)]),
    )

    session = MemorySession("child-1", "board-1", "house", revision=4)
    session.chat_group_id = "g"
    await session._write_turn(turn("我有隻狗", "好可愛"))
    await session._consolidate(
        _Stretch(turns=[turn("我有隻狗")], from_turn=0, to_turn=1, chat_group_id="g", reason="t")
    )
    # Two transcript rows, one segment, one fact.
    assert seen == [("board-1", 4)] * 4, seen


# ── registry ────────────────────────────────────────────────────────────────


def _no_reads(monkeypatch):
    monkeypatch.setattr(memory_session, "enabled", lambda: True)
    monkeypatch.setattr(store, "configured", lambda: True)

    async def nothing(*args, **kwargs):
        return []

    monkeypatch.setattr(store, "fetch_recent_segments", nothing)
    monkeypatch.setattr(store, "fetch_active_facts", nothing)
    monkeypatch.setattr(memory_session, "_sessions", {})


async def test_no_board_means_no_memory(monkeypatch):
    _no_reads(monkeypatch)
    # The web playground: an account, but no board.
    assert await memory_session.acquire("child-1", None, "house") is None


async def test_two_boards_on_one_account_are_two_memories(monkeypatch):
    _no_reads(monkeypatch)
    first = await memory_session.acquire("child-1", "board-1", "house", None, 0)
    second = await memory_session.acquire("child-1", "board-2", "house", None, 0)
    assert first is not second
    assert (first.device_id, second.device_id) == ("board-1", "board-2")
    await memory_session.release(first)
    await memory_session.release(second)


async def test_a_connection_after_a_clear_gets_its_own_session(monkeypatch):
    _no_reads(monkeypatch)
    key = ("child-1", "board-1", "house")

    before = await memory_session.acquire(*key, None, 0)
    same = await memory_session.acquire(*key, None, 0)
    assert same is before, "two connections from before the clear share one session"

    after = await memory_session.acquire(*key, None, 1)
    assert after is not before, "a session from before the clear would have its writes refused"
    assert after.revision == 1

    # The old session's holders leave; it must not take the new one out of
    # the registry on its way.
    await memory_session.release(before)
    await memory_session.release(same)
    assert memory_session._sessions[key] is after
    await memory_session.release(after)
    assert key not in memory_session._sessions

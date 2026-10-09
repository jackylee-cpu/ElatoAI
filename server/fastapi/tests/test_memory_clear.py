"""A cleared memory stays cleared (P1-12).

Every write the voice server makes is stamped with the `users.memories_revision`
its session started under, and the database refuses a stamp older than the
account's (migration 20261009120000). These check the server's half: that the
stamp is on every write, and that a connection made after a clear does not join
a session that started before it.

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


# ── store: the stamp goes on the row ────────────────────────────────────────


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


async def test_every_write_carries_the_revision(monkeypatch):
    async def writes():
        await store.insert_conversation_turn("u", "house", "user", "hi", None, "g", revision=3)
        await store.insert_segment("u", "house", "g", 0, 2, "talked", revision=3)
        await store.insert_fact("u", "house", "g", "has a dog", revision=3)

    rows = await _rows_posted(monkeypatch, writes)
    assert len(rows) == 3
    assert all(row["memories_revision"] == 3 for row in rows), rows


async def test_no_revision_writes_unstamped(monkeypatch):
    async def writes():
        await store.insert_conversation_turn("u", "house", "user", "hi", None, "g")

    rows = await _rows_posted(monkeypatch, writes)
    assert "memories_revision" not in rows[0]


# ── session: it stamps with the revision it started under ───────────────────


async def test_session_writes_with_its_starting_revision(monkeypatch):
    seen = []

    async def record(*args, revision=None, **kwargs):
        seen.append(revision)
        return "f1"

    monkeypatch.setattr(store, "insert_conversation_turn", record)
    monkeypatch.setattr(store, "insert_segment", record)
    monkeypatch.setattr(store, "insert_fact", record)
    monkeypatch.setattr(store, "supersede_fact", record)

    async def no_facts(*args, **kwargs):
        return []

    monkeypatch.setattr(store, "fetch_active_facts", no_facts)
    monkeypatch.setattr(
        memory_session,
        "consolidate",
        consolidating("talked about the dog", [NewFact("has a dog", None)]),
    )

    session = MemorySession("child-1", "house", revision=4)
    session.chat_group_id = "g"
    await session._write_turn(turn("我有隻狗", "好可愛"))
    await session._consolidate(
        _Stretch(turns=[turn("我有隻狗")], from_turn=0, to_turn=1, chat_group_id="g", reason="t")
    )
    # Two transcript rows, one segment, one fact.
    assert seen == [4, 4, 4, 4], seen


# ── registry: a clear splits the live session ───────────────────────────────


async def _acquire(monkeypatch, revision):
    return await memory_session.acquire("child-1", "house", None, revision)


async def test_a_connection_after_a_clear_gets_its_own_session(monkeypatch):
    monkeypatch.setattr(memory_session, "enabled", lambda: True)
    monkeypatch.setattr(store, "configured", lambda: True)

    async def nothing(*args, **kwargs):
        return []

    monkeypatch.setattr(store, "fetch_recent_segments", nothing)
    monkeypatch.setattr(store, "fetch_active_facts", nothing)
    monkeypatch.setattr(memory_session, "_sessions", {})

    before = await _acquire(monkeypatch, 0)
    same = await _acquire(monkeypatch, 0)
    assert same is before, "two connections from before the clear share one session"

    after = await _acquire(monkeypatch, 1)
    assert after is not before, "a session from before the clear would have its writes refused"
    assert after.revision == 1

    # The old session's holders leave; it must not take the new one out of
    # the registry on its way.
    await memory_session.release(before)
    await memory_session.release(same)
    assert memory_session._sessions[("child-1", "house")] is after
    await memory_session.release(after)
    assert ("child-1", "house") not in memory_session._sessions

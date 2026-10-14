"""The facts layer: extraction parsing, recording, replacement, and the prompt.

Standalone like the other tests here: `.venv/bin/python tests/test_memory_facts.py`.
Nothing leaves the machine; the store and the LLM call are both stubbed.
"""

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from test_memory_segments import (  # noqa: E402
    RecordingStore,
    consolidating,
    patch_store,
    restore_store,
    turn,
)

from memory import session as memory_session  # noqa: E402
from memory import store, summarise  # noqa: E402
from memory.session import MemorySession, choose_brief  # noqa: E402
from memory.summarise import Consolidation, NewFact  # noqa: E402


def seg(summary, group, to_turn, from_turn=0):
    return store.Segment(
        summary=summary, from_turn=from_turn, to_turn=to_turn, chat_group_id=group
    )


# ── parsing the model's reply ────────────────────────────────────────────────


async def test_a_reply_is_parsed_into_a_summary_and_facts():
    raw = (
        '```json\n{"summary": "Talked about dinosaurs.", "facts": ['
        '{"text": "Has a shiba called 豆豆.", "replaces": null},'
        '{"text": "豆豆 is four.", "replaces": 2},'
        '{"text": "Loves jellyfish.", "replaces": 9},'
        '{"text": "Likes Lego.", "replaces": true},'
        '"Best friend is Ethan.",'
        '{"text": "Has a shiba called 豆豆.", "replaces": null},'
        '{"text": ""}]}\n```'
    )
    result = summarise.parse(raw, known_count=3)
    assert result is not None
    assert result.summary == "Talked about dinosaurs."
    assert result.facts == [
        NewFact("Has a shiba called 豆豆.", None),
        NewFact("豆豆 is four.", 1),
        # Out of range and a bool are additions, never a guess at a target.
        NewFact("Loves jellyfish.", None),
        NewFact("Likes Lego.", None),
        NewFact("Best friend is Ethan.", None),
    ], result.facts
    print("  ok: a reply is parsed, with bad replace targets made additions")


async def test_an_unparseable_reply_is_a_failure_not_an_empty_success():
    assert summarise.parse("Sure! Here is the summary: ...", 0) is None
    assert summarise.parse('["not", "an", "object"]', 0) is None
    empty = summarise.parse('{"summary": "NOTHING", "facts": []}', 0)
    assert empty == Consolidation(), empty
    print("  ok: garbage is a failure; NOTHING is an empty success")


async def test_long_output_is_cut_at_a_sentence_never_inside_one():
    assert summarise._cut("短句。", 10) == "短句。"
    assert summarise._cut("第一句話。第二句話很長很長很長。", 8) == "第一句話。"
    # No sentence end inside the limit: drop it rather than keep half.
    assert summarise._cut("一句沒有標點而且非常非常長的話", 5) == ""
    print("  ok: output is cut at a sentence boundary")


async def test_reasoning_is_turned_off_only_for_a_chosen_model():
    keys = ("OPENROUTER_API_KEY", "OPENROUTER_MODEL", "MEMORY_SUMMARY_MODEL")
    saved = {key: os.environ.get(key) for key in keys}
    try:
        os.environ["OPENROUTER_API_KEY"] = "test"
        os.environ["OPENROUTER_MODEL"] = "minimax/minimax-m2.7"
        os.environ.pop("MEMORY_SUMMARY_MODEL", None)
        assert summarise._endpoint()[2:] == ("minimax/minimax-m2.7", False)
        os.environ["MEMORY_SUMMARY_MODEL"] = "deepseek/deepseek-v4-flash"
        assert summarise._endpoint()[2:] == ("deepseek/deepseek-v4-flash", True)
        print("  ok: reasoning is off only for a model chosen for memory")
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


# ── recording ────────────────────────────────────────────────────────────────


async def test_facts_are_recorded_and_a_replacement_retires_the_old_one():
    old = store.Fact(fact_id="fact-1", content="豆豆三歲。")
    fake = RecordingStore(facts=[old])
    saved = []
    patch_store(saved, fake)
    original = memory_session.consolidate
    memory_session.consolidate = consolidating(
        "Talked about 豆豆's birthday.",
        [
            NewFact("豆豆四歲。", replaces=0),
            NewFact("最鍾意水母。"),
            # Already known, and a phone number: neither may be written.
            NewFact("豆豆三歲。"),
            NewFact("電話係 13812345678。"),
        ],
    )
    try:
        session = MemorySession("child-1", "board-1", "house")
        session.chat_group_id = "group-1"
        session.facts = [old]
        session._pending_episodes = [turn("豆豆今日四歲生日")]
        session._turns_seen = 1
        await session._summarise_pending(reason="test")

        assert fake.facts_inserted == [("group-1", "豆豆四歲。"), ("group-1", "最鍾意水母。")], (
            fake.facts_inserted
        )
        assert fake.superseded == [("fact-1", "fact-100")], fake.superseded
        assert [f.content for f in session.facts] == ["豆豆四歲。", "最鍾意水母。"], session.facts
        assert len(fake.inserted) == 1, "the segment went missing alongside the facts"
        print("  ok: new facts are written and a replaced one is retired")
    finally:
        memory_session.consolidate = original
        restore_store(saved)


async def test_a_failed_consolidation_is_retried_once():
    fake = RecordingStore()
    saved = []
    patch_store(saved, fake)
    original = memory_session.consolidate
    original_delay = memory_session.CONSOLIDATE_RETRY_SECONDS
    memory_session.CONSOLIDATE_RETRY_SECONDS = 0
    calls = []

    async def flaky(turns, known, today, language=None, on_usage=None):
        calls.append(today)
        return None if len(calls) == 1 else Consolidation(summary="Built a rocket.")

    memory_session.consolidate = flaky
    try:
        session = MemorySession("child-1", "board-1", "house")
        session._pending_episodes = [turn("i built a rocket")]
        session._turns_seen = 1
        await session._summarise_pending(reason="test")
        assert len(calls) == 2, calls
        assert [row[-1] for row in fake.inserted] == ["Built a rocket."], fake.inserted
        print("  ok: one failed call is retried before the turns are given up")
    finally:
        memory_session.consolidate = original
        memory_session.CONSOLIDATE_RETRY_SECONDS = original_delay
        restore_store(saved)


class _FakeResponse:
    status = 200

    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        return self._payload

    async def text(self):
        return ""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeClientSession:
    payload = {}

    def __init__(self, *args, **kwargs):
        pass

    def post(self, *args, **kwargs):
        return _FakeResponse(self.payload)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


async def test_a_consolidation_reports_its_tokens_even_when_the_reply_is_junk():
    """OpenRouter bills the call whether or not the JSON parses."""
    keys = ("OPENROUTER_API_KEY", "OPENROUTER_MODEL", "MEMORY_SUMMARY_MODEL")
    saved = {key: os.environ.get(key) for key in keys}
    original_session = summarise.aiohttp.ClientSession
    heard = []
    try:
        os.environ["OPENROUTER_API_KEY"] = "test"
        os.environ["OPENROUTER_MODEL"] = "deepseek/deepseek-v4-flash"
        os.environ.pop("MEMORY_SUMMARY_MODEL", None)
        _FakeClientSession.payload = {
            "choices": [{"message": {"content": "not json at all"}}],
            "usage": {"prompt_tokens": 930, "completion_tokens": 41},
        }
        summarise.aiohttp.ClientSession = _FakeClientSession
        result = await summarise.consolidate(
            [turn("今日去咗公園")], [], __import__("datetime").date(2026, 10, 14),
            on_usage=lambda model, usage: heard.append((model, usage)),
        )
        assert result is None, "junk must still read as a failure"
        assert heard == [("deepseek/deepseek-v4-flash",
                          {"prompt_tokens": 930, "completion_tokens": 41})], heard
        print("  ok: the tokens of a billed call are reported before parsing")
    finally:
        summarise.aiohttp.ClientSession = original_session
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


async def test_a_consolidation_call_is_billed_to_the_board():
    """It runs outside the voice pipeline, so the turn observer never sees it."""
    fake = RecordingStore(facts=[])
    saved = []
    patch_store(saved, fake)
    original = memory_session.consolidate
    original_record = memory_session.metrics_store.record_turn
    rows = []

    async def billed(turns, known, today, language=None, on_usage=None):
        on_usage("deepseek/deepseek-v4-flash", {"prompt_tokens": 900, "completion_tokens": 60})
        return Consolidation(summary="Talked about the park.")

    memory_session.consolidate = billed
    memory_session.metrics_store.record_turn = rows.append
    try:
        session = MemorySession("child-1", "board-1", "house")
        session.chat_group_id = "group-1"
        session._pending_episodes = [turn("今日去咗公園")]
        session._turns_seen = 1
        await session._summarise_pending(reason="test")

        assert len(rows) == 1, rows
        row = rows[0]
        assert row["row_kind"] == "memory"
        assert (row["device_id"], row["user_id"], row["chat_group_id"]) == (
            "board-1", "child-1", "group-1"), row
        assert (row["prompt_tokens"], row["completion_tokens"]) == (900, 60)
        assert row["llm_model"] == "deepseek/deepseek-v4-flash"
        print("  ok: each consolidation call is a memory row on the board")
    finally:
        memory_session.consolidate = original
        memory_session.metrics_store.record_turn = original_record
        restore_store(saved)


async def test_the_session_end_stretch_survives_close_and_the_next_session():
    """The last stretch is most sessions' only one. It must outlive close()."""
    fake = RecordingStore()
    saved = []
    patch_store(saved, fake)
    original = memory_session.consolidate
    gate = asyncio.Event()

    async def slow(turns, known, today, language=None, on_usage=None):
        await gate.wait()
        return Consolidation(summary="Asked about the moon.", facts=[NewFact("Wants to be an astronaut.")])

    memory_session.consolidate = slow
    try:
        session = MemorySession("child-1", "board-1", "house")
        session.chat_group_id = "group-1"
        session._pending_episodes = [turn("i want to go to the moon")]
        session._turns_seen = 1

        await asyncio.wait_for(session.close(), timeout=2)
        assert session._consolidate_worker is not None, "close() did not hand it off"

        # The next connection starts before the stretch is done.
        session.chat_group_id = "group-2"
        gate.set()
        await asyncio.wait_for(session.wait_for_consolidation(), timeout=5)

        assert fake.inserted[0][1] == "group-1", "filed under the wrong conversation"
        assert fake.facts_inserted == [("group-1", "Wants to be an astronaut.")]
        assert session.session_block() == "", "leaked into the next session's summary"
        print("  ok: the session-end stretch finishes after close, under its own session")
    finally:
        gate.set()
        memory_session.consolidate = original
        restore_store(saved)


async def test_a_boundary_does_not_hold_up_the_next_write():
    """Consolidation is an LLM call; the write queue must not wait on it."""
    fake = RecordingStore()
    saved = []
    patch_store(saved, fake)
    original = memory_session.consolidate
    original_insert = store.insert_conversation_turn
    store.insert_conversation_turn = lambda *a, **k: _immediate(True)
    gate = asyncio.Event()

    async def blocked(turns, known, today, language=None, on_usage=None):
        await gate.wait()
        return Consolidation()

    memory_session.consolidate = blocked
    original_every = memory_session.SUMMARY_EVERY_TURNS
    memory_session.SUMMARY_EVERY_TURNS = 2
    try:
        session = MemorySession("child-1", "board-1", "house")
        for index in range(3):
            await asyncio.wait_for(session._write_turn(turn(f"turn {index}")), timeout=1)
        assert session._turns_seen == 3
        print("  ok: a summary boundary does not block the turns after it")
    finally:
        gate.set()
        await session.wait_for_consolidation()
        memory_session.SUMMARY_EVERY_TURNS = original_every
        memory_session.consolidate = original
        store.insert_conversation_turn = original_insert
        restore_store(saved)


# ── what reaches the prompt ──────────────────────────────────────────────────


async def test_the_brief_skips_sessions_that_only_asked_the_time():
    segments = [
        seg("Went to medieval Europe; she asked to be called Maya.", "a", 6),
        seg("Built a castle and met a knight.", "a", 8, from_turn=6),
        seg("Asked what time it was.", "b", 1),
        seg("Asked what time it was.", "c", 1),
    ]
    chosen = choose_brief(segments, count=2, min_turns=3)
    assert [s.chat_group_id for s in chosen] == ["a", "a"], chosen

    # Nothing substantial: fall back to the latest rather than to nothing.
    short = segments[2:]
    assert choose_brief(short, count=2, min_turns=3) == short
    assert choose_brief(segments, count=0, min_turns=3) == []
    print("  ok: the brief prefers sessions with substance")


async def test_facts_and_brief_go_into_the_system_prompt_in_that_order():
    fake = RecordingStore(
        recent=[seg("Went to medieval Europe.", "a", 6)],
        facts=[
            store.Fact(fact_id="f1", content="希望被叫 Mia。"),
            store.Fact(fact_id="f2", content="有隻柴犬叫豆豆。"),
        ],
    )
    saved = []
    patch_store(saved, fake)
    try:
        session = MemorySession("child-1", "board-1", "house")
        await session._begin_session()
        preamble = session.prompt_preamble()
        assert "- 希望被叫 Mia。" in preamble and "- 有隻柴犬叫豆豆。" in preamble, preamble
        assert preamble.index("WHAT YOU KNOW") < preamble.index("WHAT YOU REMEMBER"), preamble
        print("  ok: facts, then the brief, are in the system prompt")
    finally:
        restore_store(saved)


async def test_no_facts_means_no_heading():
    session = MemorySession("child-1", "board-1", "house")
    assert session.facts_block() == ""
    assert session.prompt_preamble() == ""
    print("  ok: no facts, no empty heading")


async def _immediate(value):
    return value


async def main():
    tests = [
        test_a_reply_is_parsed_into_a_summary_and_facts,
        test_an_unparseable_reply_is_a_failure_not_an_empty_success,
        test_long_output_is_cut_at_a_sentence_never_inside_one,
        test_reasoning_is_turned_off_only_for_a_chosen_model,
        test_facts_are_recorded_and_a_replacement_retires_the_old_one,
        test_a_failed_consolidation_is_retried_once,
        test_a_consolidation_reports_its_tokens_even_when_the_reply_is_junk,
        test_a_consolidation_call_is_billed_to_the_board,
        test_the_session_end_stretch_survives_close_and_the_next_session,
        test_a_boundary_does_not_hold_up_the_next_write,
        test_the_brief_skips_sessions_that_only_asked_the_time,
        test_facts_and_brief_go_into_the_system_prompt_in_that_order,
        test_no_facts_means_no_heading,
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

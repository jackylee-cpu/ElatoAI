"""The BEAM harness (evals/beam): parsing, scoring, and ingest through real memory.

Standalone like the other tests here: `.venv/bin/python tests/test_beam_eval.py`.
Nothing leaves the machine; the LLM call is stubbed.
"""

import asyncio
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from evals.beam import data, ingest, llm  # noqa: E402
from evals.beam.answer import fit_transcript  # noqa: E402
from evals.beam.judge import ordering_score, retention_targets  # noqa: E402
from memory import session as memory_session  # noqa: E402
from memory import summarise  # noqa: E402
from memory.summarise import Consolidation, NewFact  # noqa: E402


def msg(role, content, anchor=None):
    m = {"role": role, "content": content}
    if anchor:
        m["time_anchor"] = anchor
    return m


# ── parsing ──────────────────────────────────────────────────────────────────


async def test_sessions_become_turns_with_the_index_marker_stripped():
    turns = data.session_turns(
        [
            msg("user", "I need a schedule by March 15 ->-> 1,1"),
            msg("assistant", "Sure."),
            msg("user", "one more ->-> 1,2"),
            msg("user", "and another"),
            msg("assistant", "a"),
            msg("assistant", "b"),
            msg("user", "left hanging"),
        ]
    )
    assert [(t.user_text, t.agent_reply) for t in turns] == [
        ("I need a schedule by March 15", "Sure."),
        ("one more\n\nand another", "a\n\nb"),
        ("left hanging", ""),
    ], turns
    print("  ok: user/assistant pairs, markers stripped, runs joined")


async def test_anchors_parse_and_a_missing_one_inherits_the_last():
    assert data.parse_anchor("March-15-2024") == date(2024, 3, 15)
    assert data.parse_anchor("Sept-99-2024") is None
    sessions = data.parse_sessions(
        [
            [msg("user", "a", "March-15-2024"), msg("assistant", "b")],
            [msg("user", "c"), msg("assistant", "d")],
            [msg("user", "e", "garbage"), msg("assistant", "f")],
            [msg("user", "g", "April-05-2024")],
        ]
    )
    assert [s.day for s in sessions] == [
        date(2024, 3, 15),
        date(2024, 3, 15),
        date(2024, 3, 15),
        date(2024, 4, 5),
    ], [s.day for s in sessions]
    print("  ok: anchors parsed; missing or unreadable ones inherit")


async def test_probing_questions_parse_from_the_python_literal_string():
    raw = str(
        {
            "knowledge_update": [
                {"question": "Response time?", "answer": "250ms", "rubric": ["LLM response should state: 250ms"]}
            ],
            "summarization": [{"question": "Summarise", "ideal_summary": "It went well.", "rubric": ["a", "b"]}],
            "abstention": [{"question": "X?", "ideal_response": "No info.", "rubric": "No info"}],
        }
    )
    questions = data.parse_questions("7", raw)
    by_cat = {q.category: q for q in questions}
    assert by_cat["knowledge_update"].reference == "250ms"
    assert by_cat["summarization"].reference == "It went well."
    assert by_cat["abstention"].rubric == ["No info"]
    assert by_cat["knowledge_update"].key == "7/knowledge_update/0"
    print("  ok: probing questions parsed, reference field found per category")


async def test_full_transcript_keeps_the_newest_part():
    text, cut = fit_transcript(["a" * 10, "b" * 10, "c" * 10], 25)
    assert cut == 12 and text.endswith("b" * 10 + "\n\n" + "c" * 10), (text, cut)
    assert text.startswith("[... the oldest part")
    whole, none_cut = fit_transcript(["x", "y"], 100)
    assert none_cut == 0 and whole == "x\n\ny"
    print("  ok: the transcript is cut from the oldest end, and says so")


# ── scoring ──────────────────────────────────────────────────────────────────


async def test_judge_replies_parse_and_garbage_is_an_error_not_a_zero():
    assert llm.parse_json('```json\n{"score": 1.0, "reason": "ok"}\n```')["score"] == 1.0
    assert llm.parse_json('Here: {"score": 0.5} done')["score"] == 0.5
    try:
        llm.parse_json("I think it deserves full marks")
    except ValueError:
        pass
    else:
        raise AssertionError("an unreadable reply must raise")
    print("  ok: fenced and chatty JSON parse; prose raises")


async def test_ordering_score_matches_beam():
    ref = ["A", "B", "C"]
    perfect = ordering_score(ref, ["1) a", "2) b", "3) c"], [0, 1, 2])
    assert perfect["f1"] == 1.0 and perfect["tau_norm"] == 1.0, perfect
    reversed_ = ordering_score(ref, ["c", "b", "a"], [2, 1, 0])
    assert reversed_["f1"] == 1.0 and reversed_["tau_norm"] == 0.0, reversed_
    # A line matching an already-used event is an unmatched line, as in BEAM.
    dup = ordering_score(ref, ["a", "a again", "b"], [0, 0, 1])
    assert abs(dup["precision"] - 2 / 3) < 1e-9 and abs(dup["recall"] - 2 / 3) < 1e-9, dup
    empty = ordering_score(ref, [], [])
    assert empty["ordering_score"] == 0.0, empty
    print("  ok: tau-b x F1 on perfect, reversed, duplicate and empty orderings")


async def test_retention_targets_ask_for_the_information_not_the_behaviour():
    q = data.Question(
        "1",
        "contradiction_resolution",
        0,
        "?",
        "",
        [
            "LLM response should state: there is contradictory information",
            "LLM response should mention: You said you never wrote a route",
        ],
    )
    assert retention_targets(q) == ["You said you never wrote a route"], retention_targets(q)
    pref = data.Question("1", "preference_following", 0, "?", "", ["x"], raw={"preference_being_tested": "Minimal deps"})
    assert retention_targets(pref) == ["Minimal deps"]
    abst = data.Question("1", "abstention", 0, "?", "", ["No info"])
    assert retention_targets(abst) == []
    print("  ok: retention targets strip rubric boilerplate and skip abstention")


# ── ingest through the real MemorySession ────────────────────────────────────


async def test_ingest_carries_facts_across_sessions_on_each_anchor_day():
    seen_days = []
    calls = {"n": 0}

    async def fake_consolidate(turns, known, today, language=None, on_usage=None):
        seen_days.append(today)
        calls["n"] += 1
        if calls["n"] == 1:
            return Consolidation(summary="Planned the budget app.", facts=[NewFact("Response time is 400ms.")])
        if calls["n"] == 2:
            index = known.index("Response time is 400ms.")
            return Consolidation(
                summary="Tuned caching.", facts=[NewFact("Response time is 250ms after caching.", index)]
            )
        return None  # a failure, counted

    conversation = data.Conversation(
        conv_id="t1",
        title="test",
        sessions=[
            data.Session(0, date(2024, 3, 15), data.session_turns([msg("user", "hi"), msg("assistant", "hello")])),
            data.Session(1, date(2024, 4, 5), data.session_turns([msg("user", "faster now"), msg("assistant", "nice")])),
            data.Session(2, date(2024, 4, 25), data.session_turns([msg("user", "bye"), msg("assistant", "bye")])),
        ],
        questions=[],
    )
    original = summarise.consolidate
    saved_session_consolidate = memory_session.consolidate
    saved_retry = memory_session.CONSOLIDATE_RETRY_SECONDS
    memory_session.consolidate = fake_consolidate
    memory_session.CONSOLIDATE_RETRY_SECONDS = 0
    try:
        fake = ingest.FakeStore()
        with ingest.patched_store(fake), ingest.counted_consolidation():
            result = await asyncio.create_task(ingest.ingest_conversation(conversation, fake))
    finally:
        memory_session.consolidate = saved_session_consolidate
        memory_session.CONSOLIDATE_RETRY_SECONDS = saved_retry
        summarise.consolidate = original

    # The last day twice: its stretch is retried once.
    assert seen_days == [date(2024, 3, 15), date(2024, 4, 5), date(2024, 4, 25), date(2024, 4, 25)], seen_days
    assert result["active_facts"] == ["Response time is 250ms after caching."], result["active_facts"]
    assert result["stats"]["facts_superseded"] == 1
    # Two good stretches, then the last one fails twice (one retry) and is given up.
    assert result["stats"]["consolidation_calls"] == 4, result["stats"]
    assert result["stats"]["consolidation_failures"] == 2, result["stats"]
    assert "250ms" in result["preamble"] and "400ms" not in result["preamble"], result["preamble"]
    assert "Tuned caching." in result["preamble"], result["preamble"]
    print("  ok: anchors reach consolidate, replacements carry over, failures are counted")


async def test_configs_patch_and_restore():
    before = (summarise._SYSTEM, summarise.FACT_MAX_CHARS, memory_session.BRIEF_SEGMENTS)
    with ingest.applied("adult"):
        assert summarise.FACT_MAX_CHARS == 300
        assert "young child" not in summarise._SYSTEM
        assert memory_session.BRIEF_LOOKBACK_SEGMENTS == 200
    assert (summarise._SYSTEM, summarise.FACT_MAX_CHARS, memory_session.BRIEF_SEGMENTS) == before
    with ingest.applied("prod"):
        assert summarise._SYSTEM == before[0]
    print("  ok: the adult config patches and restores; prod keeps the prompt")


async def main():
    tests = [
        test_sessions_become_turns_with_the_index_marker_stripped,
        test_anchors_parse_and_a_missing_one_inherits_the_last,
        test_probing_questions_parse_from_the_python_literal_string,
        test_full_transcript_keeps_the_newest_part,
        test_judge_replies_parse_and_garbage_is_an_error_not_a_zero,
        test_ordering_score_matches_beam,
        test_retention_targets_ask_for_the_information_not_the_behaviour,
        test_ingest_carries_facts_across_sessions_on_each_anchor_day,
        test_configs_patch_and_restore,
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

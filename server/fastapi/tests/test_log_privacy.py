"""What a child said must not reach a log at INFO or above (P1-02).

Each test captures loguru at INFO -- what production runs at -- while the
server does something with a child's words, then searches the capture for
them. The same flow at DEBUG must still show the words, so these tests also
prove the content was moved, not lost.

Standalone like the other tests here: `.venv/bin/python tests/test_log_privacy.py`.
"""

import asyncio
import json
import os
import sys
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from loguru import logger  # noqa: E402

from test_memory_segments import (  # noqa: E402
    RecordingStore,
    consolidating,
    patch_store,
    restore_store,
    turn,
)

import log_setup  # noqa: E402
from memory import session as memory_session  # noqa: E402
from memory import store, summarise  # noqa: E402
from memory.session import MemorySession  # noqa: E402
from memory.summarise import NewFact  # noqa: E402

CHILD_FACT = "有隻狗叫豆豆PROBE"
CHILD_SUMMARY = "講咗佢隻狗豆豆PROBE嘅生日"


@contextmanager
def captured(level):
    lines = []
    handler = logger.add(lambda message: lines.append(str(message)), level=level)
    try:
        yield lines
    finally:
        logger.remove(handler)


async def _learn_and_summarise():
    fake = RecordingStore(facts=[])
    saved = []
    patch_store(saved, fake)
    original = memory_session.consolidate
    memory_session.consolidate = consolidating(CHILD_SUMMARY, [NewFact(CHILD_FACT)])
    try:
        session = MemorySession("child-1", "board-1", "house")
        session.chat_group_id = "group-1"
        session._pending_episodes = [turn("我隻狗叫豆豆PROBE")]
        session._turns_seen = 1
        await session._summarise_pending(reason="test")
    finally:
        memory_session.consolidate = original
        restore_store(saved)


async def test_facts_and_summaries_are_not_logged_at_info():
    with captured("INFO") as info:
        await _learn_and_summarise()
    text = "\n".join(info)
    assert "Learned a fact" in text and "Wrote a session summary" in text, text
    assert "PROBE" not in text, text
    print("  ok: INFO says a fact and a summary were written, not what they say")


async def test_the_content_is_still_there_at_debug():
    with captured("DEBUG") as debug:
        await _learn_and_summarise()
    text = "\n".join(debug)
    assert CHILD_FACT in text and CHILD_SUMMARY in text, text
    print("  ok: DEBUG still shows the fact and the summary for local work")


async def test_a_refused_write_logs_the_constraint_not_the_row():
    """Postgres puts the whole row in `details`: the transcript itself."""
    body = json.dumps({
        "code": "23514",
        "message": 'new row for relation "memory_facts" violates check constraint "x"',
        "details": f"Failing row contains (id, {CHILD_FACT}).",
        "hint": None,
    })
    with captured("INFO") as info:
        summary = store._error_summary(body)
        logger.warning("Write of fact failed: HTTP 400 {}", summary)
    text = "\n".join(info)
    assert "23514" in text and "check constraint" in text, text
    assert "PROBE" not in text and "Failing row" not in text, text
    assert "(non-JSON body, 9 chars)" == store._error_summary("not json!")
    print("  ok: a refused write names the constraint, never the row")


async def test_a_moderation_refusal_does_not_log_the_flagged_words():
    body = json.dumps({"error": {
        "code": 403,
        "message": "Input was flagged by moderation",
        "metadata": {"reasons": ["violence"], "flagged_input": CHILD_FACT},
    }})
    with captured("INFO") as info:
        logger.warning("Memory consolidation failed: HTTP 403 {}", summarise._error_summary(body))
    text = "\n".join(info)
    assert "flagged by moderation" in text and "PROBE" not in text, text
    print("  ok: OpenRouter's flagged_input stays out of the log")


async def test_an_unparseable_reply_is_logged_by_length():
    """The real consolidate() call, answered by a fake OpenRouter with junk."""
    from datetime import date

    from test_memory_facts import _FakeClientSession

    keys = ("OPENROUTER_API_KEY", "OPENROUTER_MODEL", "MEMORY_SUMMARY_MODEL")
    saved = {key: os.environ.get(key) for key in keys}
    original_session = summarise.aiohttp.ClientSession
    try:
        os.environ["OPENROUTER_API_KEY"] = "test"
        os.environ["OPENROUTER_MODEL"] = "deepseek/deepseek-v4-flash"
        os.environ.pop("MEMORY_SUMMARY_MODEL", None)
        _FakeClientSession.payload = {"choices": [{"message": {"content": f"not json {CHILD_FACT}"}}]}
        summarise.aiohttp.ClientSession = _FakeClientSession
        with captured("INFO") as info:
            result = await summarise.consolidate([turn("我隻狗叫豆豆PROBE")], [], date(2026, 10, 14))
        text = "\n".join(info)
        assert result is None
        assert "not valid JSON" in text and "PROBE" not in text, text
    finally:
        summarise.aiohttp.ClientSession = original_session
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
    print("  ok: a reply that is not JSON is logged by its length")


async def test_the_default_level_is_info_and_tracebacks_hold_no_values():
    saved = {key: os.environ.get(key) for key in ("LOG_LEVEL", "LOG_DIAGNOSE")}
    original_load = log_setup.load_dotenv
    # The developer's own .env must not decide what this test sees.
    log_setup.load_dotenv = lambda **kwargs: None
    lines = []
    try:
        os.environ.pop("LOG_LEVEL", None)
        os.environ.pop("LOG_DIAGNOSE", None)
        log_setup.configure()
        assert log_setup.level() == "INFO"
        # configure() owns stderr; listen beside it at the same level.
        handler = logger.add(lambda m: lines.append(str(m)), level="INFO", diagnose=False)
        logger.debug("child said {}", CHILD_FACT)
        secret = CHILD_FACT  # noqa: F841 - what diagnose=True would print
        try:
            raise ValueError("boom")
        except ValueError:
            logger.exception("a failure while writing")
        logger.remove(handler)
        text = "\n".join(lines)
        assert "boom" in text and "PROBE" not in text, text
        print("  ok: INFO by default, and a traceback shows no variable values")
    finally:
        log_setup.load_dotenv = original_load
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        # Leave the process logging the way the other tests expect.
        logger.remove()
        logger.add(sys.stderr, level="DEBUG")


async def main():
    tests = [
        test_facts_and_summaries_are_not_logged_at_info,
        test_the_content_is_still_there_at_debug,
        test_a_refused_write_logs_the_constraint_not_the_row,
        test_a_moderation_refusal_does_not_log_the_flagged_words,
        test_an_unparseable_reply_is_logged_by_length,
        test_the_default_level_is_info_and_tracebacks_hold_no_values,
    ]
    failed = 0
    for test in tests:
        print(f"{test.__name__}:")
        try:
            await test()
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL: {exc}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return failed


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

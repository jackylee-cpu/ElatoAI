"""Checks on how a turn is timed.

The one that matters is the push-to-talk anchor. Both clients close their own
turn with an explicit end_of_speech, and the VAD frame for the same turn shows
up several hundred milliseconds later, once the synthetic silence has run past
stop_secs. Anchoring on the VAD frame -- which is what pipecat's own
UserBotLatencyObserver does -- would silently shorten every measurement, and
nothing about the symptom would point at this file.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipecat.frames.frames import (  # noqa: E402
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    MetricsFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.metrics.metrics import (  # noqa: E402
    LLMTokenUsage,
    LLMUsageMetricsData,
    TTFBMetricsData,
)
from pipecat.frames.frames import LLMContextFrame  # noqa: E402
from pipecat.observers.base_observer import FramePushed  # noqa: E402
from pipecat.processors.frame_processor import FrameDirection  # noqa: E402

from metrics import store  # noqa: E402
from metrics.turn_metrics import TurnMetricsObserver  # noqa: E402

MS = 1_000_000  # the pipeline clock counts nanoseconds


def make_observer(rows):
    return TurnMetricsObserver(
        transport="browser",
        llm_model="openai/gpt-4o-mini",
        stt_provider="azure",
        llm_provider="openrouter",
        tts_provider="minimax",
        sink=rows.append,
    )


def push(observer, frame, at_ms, direction=FrameDirection.DOWNSTREAM):
    """Hand one frame to the observer as the pipeline would."""
    asyncio.run(
        observer.on_push_frame(
            FramePushed(
                source=None,
                destination=None,
                frame=frame,
                direction=direction,
                timestamp=at_ms * MS,
            )
        )
    )


def a_complete_turn(observer, *, start=0, user_stop=100, transcript=340,
                    llm_first=690, llm_end=1450, bot_start=980, bot_stop=3200):
    push(observer, UserStartedSpeakingFrame(), start)
    push(observer, UserStoppedSpeakingFrame(), user_stop)
    push(observer, TranscriptionFrame(text="hello there", user_id="u", timestamp=""), transcript)
    push(observer, LLMFullResponseStartFrame(), llm_first - 10)
    push(observer, LLMTextFrame(text="Hi!"), llm_first)
    push(observer, BotStartedSpeakingFrame(), bot_start)
    push(observer, LLMFullResponseEndFrame(), llm_end)
    push(observer, BotStoppedSpeakingFrame(), bot_stop)


def test_a_complete_turn_measures_every_span():
    rows = []
    observer = make_observer(rows)
    a_complete_turn(observer)

    assert len(rows) == 1, f"expected one row, got {len(rows)}"
    row = rows[0]
    assert row["stt_ms"] == 240, row["stt_ms"]           # 340 - 100
    assert row["llm_ttfb_ms"] == 350, row["llm_ttfb_ms"]  # 690 - 340
    assert row["tts_ttfb_ms"] == 290, row["tts_ttfb_ms"]  # 980 - 690
    assert row["llm_total_ms"] == 760, row["llm_total_ms"]  # 1450 - 690
    assert row["total_ms"] == 880, row["total_ms"]        # 980 - 100
    assert row["interrupted"] is False
    assert row["transcript_chars"] == len("hello there")
    assert row["response_chars"] == len("Hi!")
    print("  ok: all four spans and the total come out of the frame stream")



def test_the_moment_stt_finished_is_recorded_as_wall_clock():
    """The pipeline clock means nothing once the row is in the table."""
    rows = []
    observer = make_observer(rows)
    a_complete_turn(observer)

    stamp = rows[0]["stt_done_at"]
    assert stamp is not None, "the moment STT finished was not recorded"
    # ISO8601, UTC, parseable -- this is what lines a turn up against the log.
    from datetime import datetime

    parsed = datetime.fromisoformat(stamp)
    assert parsed.tzinfo is not None, stamp
    print("  ok: the instant STT finished is written as wall clock")


def test_the_wait_between_stt_and_the_llm_is_measured_not_billed_to_the_model():
    """ExternalUserTurnStopStrategy holds the turn open on a merge timer.

    That wait sits between the final transcript and the context reaching the
    LLM. Until it had its own span it was inside llm_ttfb_ms, which made the
    model look 500ms slower than it is.
    """
    rows = []
    observer = make_observer(rows)
    push(observer, UserStartedSpeakingFrame(), 0)
    push(observer, UserStoppedSpeakingFrame(), 100)
    push(observer, TranscriptionFrame(text="hello", user_id="u", timestamp=""), 340)
    push(observer, LLMContextFrame(context=None), 842)   # the merge timer expires
    push(observer, LLMTextFrame(text="Hi!"), 990)
    push(observer, BotStartedSpeakingFrame(), 1200)
    push(observer, BotStoppedSpeakingFrame(), 2000)

    row = rows[0]
    assert row["turn_close_ms"] == 502, row["turn_close_ms"]   # 842 - 340
    # llm_ttfb_ms is deliberately left spanning the whole thing, so rows
    # written before this column stay comparable.
    assert row["llm_ttfb_ms"] == 650, row["llm_ttfb_ms"]       # 990 - 340
    print("  ok: the merge-timer wait is measured on its own")


def test_a_turn_the_llm_never_reached_has_no_close_span():
    """A turn cut short before the context went out must not invent a number."""
    rows = []
    observer = make_observer(rows)
    push(observer, UserStartedSpeakingFrame(), 0)
    push(observer, UserStoppedSpeakingFrame(), 100)
    push(observer, TranscriptionFrame(text="hello", user_id="u", timestamp=""), 340)
    push(observer, LLMTextFrame(text="Hi!"), 700)
    push(observer, BotStartedSpeakingFrame(), 900)
    push(observer, BotStoppedSpeakingFrame(), 1800)

    assert rows[0]["turn_close_ms"] is None, rows[0]["turn_close_ms"]
    print("  ok: no context frame means no close span, not a zero")


def test_the_greeting_turn_records_no_stt_moment():
    """Nobody spoke, so there is no instant for STT to have finished at."""
    rows = []
    observer = make_observer(rows)
    push(observer, LLMContextFrame(context=None), 10)
    push(observer, LLMTextFrame(text="Hello!"), 200)
    push(observer, BotStartedSpeakingFrame(), 400)
    push(observer, BotStoppedSpeakingFrame(), 1500)

    row = rows[0]
    assert row["stt_done_at"] is None, row["stt_done_at"]
    assert row["turn_close_ms"] is None, row["turn_close_ms"]
    print("  ok: the greeting turn carries no STT instant")

def test_the_push_to_talk_frame_wins_over_the_later_vad_frame():
    """The button coming up is the anchor, not the VAD deciding so 600ms later."""
    rows = []
    observer = make_observer(rows)
    push(observer, UserStartedSpeakingFrame(), 0)
    push(observer, UserStoppedSpeakingFrame(), 100)
    push(observer, VADUserStoppedSpeakingFrame(), 700)  # synthetic silence ran out
    push(observer, TranscriptionFrame(text="hi", user_id="u", timestamp=""), 340)
    push(observer, LLMTextFrame(text="Hi!"), 690)
    push(observer, BotStartedSpeakingFrame(), 980)
    push(observer, BotStoppedSpeakingFrame(), 3200)

    assert rows[0]["stt_ms"] == 240, rows[0]["stt_ms"]
    assert rows[0]["total_ms"] == 880, rows[0]["total_ms"]
    print("  ok: the anchor is whichever stop frame arrived first")


def test_a_vad_only_turn_still_anchors():
    """An open-mic client never sends end_of_speech; VAD is all there is."""
    rows = []
    observer = make_observer(rows)
    push(observer, UserStartedSpeakingFrame(), 0)
    push(observer, VADUserStoppedSpeakingFrame(), 700)
    push(observer, TranscriptionFrame(text="hi", user_id="u", timestamp=""), 900)
    push(observer, LLMTextFrame(text="Hi!"), 1200)
    push(observer, BotStartedSpeakingFrame(), 1500)
    push(observer, BotStoppedSpeakingFrame(), 3000)

    assert rows[0]["stt_ms"] == 200, rows[0]["stt_ms"]
    assert rows[0]["total_ms"] == 800, rows[0]["total_ms"]
    print("  ok: a hands-free turn is measured from the VAD stop")


def test_the_same_frame_is_only_counted_at_its_first_hop():
    """A frame is pushed once per processor pair; later hops must not move a mark."""
    rows = []
    observer = make_observer(rows)
    stop = UserStoppedSpeakingFrame()
    push(observer, UserStartedSpeakingFrame(), 0)
    push(observer, stop, 100)
    push(observer, stop, 160)  # same frame, next hop
    push(observer, TranscriptionFrame(text="hi", user_id="u", timestamp=""), 340)
    push(observer, LLMTextFrame(text="Hi!"), 690)
    push(observer, BotStartedSpeakingFrame(), 980)
    push(observer, BotStoppedSpeakingFrame(), 3200)

    assert rows[0]["stt_ms"] == 240, rows[0]["stt_ms"]
    print("  ok: de-duplication keeps the first sighting")


def test_upstream_frames_are_ignored():
    """BotStoppedSpeakingFrame is pushed both ways; only one of them is a turn end."""
    rows = []
    observer = make_observer(rows)
    push(observer, UserStartedSpeakingFrame(), 0)
    push(observer, UserStoppedSpeakingFrame(), 100)
    push(observer, TranscriptionFrame(text="hi", user_id="u", timestamp=""), 340)
    push(observer, LLMTextFrame(text="Hi!"), 690)
    push(observer, BotStartedSpeakingFrame(), 980)
    push(observer, BotStoppedSpeakingFrame(), 3200, direction=FrameDirection.UPSTREAM)
    assert rows == [], "an upstream frame closed the turn"
    push(observer, BotStoppedSpeakingFrame(), 3250)
    assert len(rows) == 1
    print("  ok: only downstream frames count")


def test_the_last_transcript_before_the_llm_is_the_one_timed():
    """A segmenting recognizer splits a sentence; the turn is not read until the last."""
    rows = []
    observer = make_observer(rows)
    push(observer, UserStartedSpeakingFrame(), 0)
    push(observer, UserStoppedSpeakingFrame(), 100)
    push(observer, TranscriptionFrame(text="hello", user_id="u", timestamp=""), 300)
    push(observer, TranscriptionFrame(text="there", user_id="u", timestamp=""), 400)
    push(observer, LLMTextFrame(text="Hi!"), 690)
    push(observer, BotStartedSpeakingFrame(), 980)
    push(observer, BotStoppedSpeakingFrame(), 3200)

    assert rows[0]["stt_ms"] == 300, rows[0]["stt_ms"]        # 400 - 100
    assert rows[0]["llm_ttfb_ms"] == 290, rows[0]["llm_ttfb_ms"]  # 690 - 400
    assert rows[0]["transcript_chars"] == len("hello there")
    print("  ok: a split transcript is timed from its last frame")


def test_barge_in_is_recorded_and_the_turn_still_written():
    rows = []
    observer = make_observer(rows)
    push(observer, UserStartedSpeakingFrame(), 0)
    push(observer, UserStoppedSpeakingFrame(), 100)
    push(observer, TranscriptionFrame(text="hi", user_id="u", timestamp=""), 340)
    push(observer, LLMTextFrame(text="Hi there, I was going to say a lot"), 690)
    push(observer, BotStartedSpeakingFrame(), 980)
    push(observer, InterruptionFrame(), 1500)
    push(observer, BotStoppedSpeakingFrame(), 1520)

    assert len(rows) == 1
    assert rows[0]["interrupted"] is True
    assert rows[0]["total_ms"] == 880
    print("  ok: an interrupted turn is kept, and flagged")


def test_speaking_over_an_unclosed_turn_counts_as_barge_in():
    """If the child starts talking before the turn closed, that is a barge-in --
    whichever of UserStartedSpeaking and InterruptionFrame the observer sees first."""
    rows = []
    observer = make_observer(rows)
    push(observer, UserStartedSpeakingFrame(), 0)
    push(observer, UserStoppedSpeakingFrame(), 100)
    push(observer, TranscriptionFrame(text="hi", user_id="u", timestamp=""), 340)
    push(observer, LLMTextFrame(text="Hi!"), 690)
    push(observer, BotStartedSpeakingFrame(), 980)
    push(observer, UserStartedSpeakingFrame(), 1400)  # no BotStoppedSpeaking yet

    assert len(rows) == 1, "the open turn was not flushed"
    assert rows[0]["interrupted"] is True
    print("  ok: an unclosed turn is flushed and flagged when the child cuts in")


def test_the_greeting_turn_is_kept_without_a_user_stop():
    """The opening line has no user speech at all, and is still worth timing."""
    rows = []
    observer = make_observer(rows)
    push(observer, LLMFullResponseStartFrame(), 40)
    push(observer, LLMTextFrame(text="Hello!"), 500)
    push(observer, BotStartedSpeakingFrame(), 820)
    push(observer, LLMFullResponseEndFrame(), 900)
    push(observer, BotStoppedSpeakingFrame(), 2000)

    assert len(rows) == 1
    row = rows[0]
    assert row["stt_ms"] is None and row["total_ms"] is None
    assert row["tts_ttfb_ms"] == 320, row["tts_ttfb_ms"]
    print("  ok: the greeting is recorded with the spans it does have")


def test_a_turn_with_nothing_in_it_is_not_written():
    rows = []
    observer = make_observer(rows)
    push(observer, UserStartedSpeakingFrame(), 0)
    push(observer, UserStoppedSpeakingFrame(), 100)
    push(observer, BotStoppedSpeakingFrame(), 200)
    assert rows == [], "wrote a row for a turn where nothing happened"
    print("  ok: an empty turn is dropped")


def test_service_reported_metrics_and_tokens_are_kept():
    rows = []
    observer = make_observer(rows)
    push(observer, UserStartedSpeakingFrame(), 0)
    push(observer, UserStoppedSpeakingFrame(), 100)
    push(observer, TranscriptionFrame(text="hi", user_id="u", timestamp=""), 340)
    push(observer, LLMTextFrame(text="Hi!"), 690)
    push(
        observer,
        MetricsFrame(data=[
            TTFBMetricsData(processor="MiniMaxHttpTTSService", model="speech-2.6-turbo", value=0.29),
            LLMUsageMetricsData(
                processor="RoutedOpenRouterLLMService",
                model="openai/gpt-4o-mini",
                value=LLMTokenUsage(prompt_tokens=812, completion_tokens=24, total_tokens=836),
            ),
        ]),
        700,
    )
    push(observer, BotStartedSpeakingFrame(), 980)
    push(observer, BotStoppedSpeakingFrame(), 3200)

    row = rows[0]
    assert row["prompt_tokens"] == 812 and row["completion_tokens"] == 24
    assert row["detail"]["ttfb"][0]["processor"] == "MiniMaxHttpTTSService"
    assert row["detail"]["ttfb"][0]["secs"] == 0.29
    print("  ok: the vendors' own numbers are kept next to ours")


def test_turns_are_numbered_in_order():
    rows = []
    observer = make_observer(rows)
    a_complete_turn(observer)
    a_complete_turn(observer, start=4000, user_stop=4100, transcript=4340,
                    llm_first=4690, llm_end=5450, bot_start=4980, bot_stop=7200)
    assert [row["turn_index"] for row in rows] == [1, 2]
    print("  ok: turn_index counts up within a session")


def test_a_clock_that_runs_backwards_yields_none_not_zero():
    """A negative span means the frame order was not what this observer assumes.
    Reporting None says so; clamping to 0 would hide it inside an average."""
    rows = []
    observer = make_observer(rows)
    push(observer, UserStartedSpeakingFrame(), 0)
    push(observer, UserStoppedSpeakingFrame(), 500)
    push(observer, TranscriptionFrame(text="hi", user_id="u", timestamp=""), 300)
    push(observer, LLMTextFrame(text="Hi!"), 690)
    push(observer, BotStartedSpeakingFrame(), 980)
    push(observer, BotStoppedSpeakingFrame(), 3200)

    assert rows[0]["stt_ms"] is None, rows[0]["stt_ms"]
    assert rows[0]["total_ms"] == 480
    print("  ok: an impossible span is reported as missing")


def test_the_store_reads_the_environment_lazily():
    """Same regression as test_app_settings: a module-level os.getenv here runs
    before bot.py's load_dotenv() and comes back empty, after which
    configured() is False forever and every row is dropped in silence."""
    saved = {k: os.environ.get(k) for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")}
    try:
        os.environ["SUPABASE_URL"] = ""
        os.environ["SUPABASE_SERVICE_ROLE_KEY"] = ""
        assert store.configured() is False
        os.environ["SUPABASE_URL"] = "http://127.0.0.1:54321"
        os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "a-real-looking-key"
        assert store.configured() is True, (
            "the environment was captured at import time, not read at call time"
        )
    finally:
        for key, old in saved.items():
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old
    print("  ok: env set after import is still seen")


def main():
    tests = [
        test_a_complete_turn_measures_every_span,
        test_the_push_to_talk_frame_wins_over_the_later_vad_frame,
        test_a_vad_only_turn_still_anchors,
        test_the_same_frame_is_only_counted_at_its_first_hop,
        test_upstream_frames_are_ignored,
        test_the_last_transcript_before_the_llm_is_the_one_timed,
        test_barge_in_is_recorded_and_the_turn_still_written,
        test_speaking_over_an_unclosed_turn_counts_as_barge_in,
        test_the_greeting_turn_is_kept_without_a_user_stop,
        test_a_turn_with_nothing_in_it_is_not_written,
        test_service_reported_metrics_and_tokens_are_kept,
        test_turns_are_numbered_in_order,
        test_a_clock_that_runs_backwards_yields_none_not_zero,
        test_the_store_reads_the_environment_lazily,
    ]
    failed = 0
    for test in tests:
        print(f"{test.__name__}:")
        try:
            test()
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
    sys.exit(main())

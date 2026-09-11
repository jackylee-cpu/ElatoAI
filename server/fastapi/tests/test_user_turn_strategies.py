"""Does an explicit `end_of_speech` actually close a user turn?

A push-to-talk client shuts its mic the moment it commits, so the audio the
smart-turn analyzer needs to decide a turn is over never arrives. With pipecat's
default stop strategies the turn then stays open forever: no aggregation, no LLM
run, no answer, and a client stuck showing "listening". These tests pin the
configuration that fixes it, against the same builder the server uses.
"""
import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipecat.frames.frames import (
    TranscriptionFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
)
from pipecat.turns.user_turn_controller import UserTurnController
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.utils.asyncio.task_manager import TaskManager

from voice_pipeline import PTT_TRANSCRIPT_MERGE_SECS, build_user_turn_strategies

# ExternalUserTurnStopStrategy merges consecutive transcripts on a short timer
# after commit (PTT_TRANSCRIPT_MERGE_SECS). A commit that lands before the
# transcript finalizes takes that long, plus the helper's 0.2s "STT lag".
TIMER_ALLOWANCE = 0.4


async def _run_turn(strategies, *, commit, commit_first=False, settle=2.0):
    """Play one user turn through a controller; return ms until the turn stopped."""
    controller = UserTurnController(user_turn_strategies=strategies)
    stops = []

    @controller.event_handler("on_user_turn_stopped")
    async def _on_stop(controller, strategy, params):
        stops.append(time.monotonic())

    await controller.setup(TaskManager())
    await controller.process_frame(VADUserStartedSpeakingFrame(start_secs=0.2))
    await asyncio.sleep(0.2)  # the user says something

    started_at = time.monotonic()
    if commit_first and commit:
        await controller.process_frame(UserStoppedSpeakingFrame())
        await asyncio.sleep(0.2)  # STT still finalizing when the button came up

    await controller.process_frame(
        TranscriptionFrame(text="你好嗎", user_id="", timestamp="")
    )
    if commit and not commit_first:
        await controller.process_frame(UserStoppedSpeakingFrame())

    # No further audio: the mic is shut, so nothing else can close this turn.
    await asyncio.sleep(settle)
    await controller.cleanup()
    return (stops[0] - started_at) * 1000 if stops else None


async def test_pipecat_defaults_never_close_a_pushed_turn():
    """The regression itself: without our config the commit is simply ignored."""
    elapsed = await _run_turn(UserTurnStrategies(), commit=True)
    assert elapsed is None, f"defaults closed the turn after {elapsed:.0f}ms -- pipecat changed"


async def test_commit_after_transcript_closes_immediately():
    elapsed = await _run_turn(build_user_turn_strategies(), commit=True)
    assert elapsed is not None, "end_of_speech did not close the turn"
    assert elapsed < 100, f"took {elapsed:.0f}ms, expected an immediate close"


async def test_commit_before_transcript_still_closes():
    """Releasing the button before STT finalizes must not lose the turn."""
    elapsed = await _run_turn(
        build_user_turn_strategies(),
        commit=True,
        commit_first=True,
        settle=0.5,
    )
    assert elapsed is not None, "a commit that arrived before the transcript lost the turn"
    # 200ms of fake STT lag in the helper, then the short merge window.
    assert elapsed < TIMER_ALLOWANCE * 1000, f"took {elapsed:.0f}ms"
    # The old 500ms merge would land around 700ms here. If this is over 450ms
    # the timeout was not wired through.
    assert elapsed < 450, (
        f"took {elapsed:.0f}ms after commit+transcript; merge looks like 500ms "
        f"(expected ~{200 + PTT_TRANSCRIPT_MERGE_SECS * 1000:.0f}ms)"
    )


async def test_open_mic_turn_is_not_closed_by_the_external_strategy():
    """Hands-free has no commit; only the analyzer may end its turns."""
    elapsed = await _run_turn(build_user_turn_strategies(), commit=False)
    assert elapsed is None, f"turn closed after {elapsed:.0f}ms without any commit"


async def main():
    tests = [
        test_pipecat_defaults_never_close_a_pushed_turn,
        test_commit_after_transcript_closes_immediately,
        test_commit_before_transcript_still_closes,
        test_open_mic_turn_is_not_closed_by_the_external_strategy,
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

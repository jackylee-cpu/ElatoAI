"""Push-to-talk commit must force-finalize Azure, not wait out silence."""

import asyncio
import os
import sys
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipecat.frames.frames import (  # noqa: E402
    InputTransportMessageFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.tests.utils import run_test  # noqa: E402

from bot import RealtimeInputControlProcessor  # noqa: E402
from models.stt.azure import (  # noqa: E402
    FinalizingAzureSTTService,
    flush_silence_ms,
)
from models.stt.finalize import STTFinalizeFrame  # noqa: E402


def test_azure_declares_no_silence_flush():
    """PTT commit force-finalizes; synthetic silence would re-pay the timeout."""
    assert flush_silence_ms() == 0


async def test_finalize_closes_the_push_stream_then_restarts():
    """Closing the stream is Azure's end-of-audio; restart keeps the next turn alive."""
    os.environ.setdefault("AZURE_SPEECH_API_KEY", "test-key")
    service = FinalizingAzureSTTService(api_key="test-key", region="eastasia")
    stream = MagicMock()
    recognizer = MagicMock()
    service._audio_stream = stream
    service._speech_recognizer = recognizer

    reconnected = []

    async def _connect():
        reconnected.append(True)
        service._audio_stream = MagicMock()
        service._speech_recognizer = MagicMock()

    service._connect = _connect  # type: ignore[method-assign]

    await service.finalize_utterance()

    stream.close.assert_called_once()
    recognizer.stop_continuous_recognition.assert_called_once()
    assert reconnected == [True]


async def test_finalize_is_a_no_op_without_a_live_recognizer():
    os.environ.setdefault("AZURE_SPEECH_API_KEY", "test-key")
    service = FinalizingAzureSTTService(api_key="test-key", region="eastasia")
    service._audio_stream = None
    service._speech_recognizer = None
    await service.finalize_utterance()  # must not raise


async def test_end_of_speech_sends_finalize_not_silence():
    """The client's commit must reach STT as finalize, not 2.9s of zeros."""
    processor = RealtimeInputControlProcessor("classic")
    processor.set_flush_silence_ms(0)
    _, _ = await run_test(
        processor,
        frames_to_send=[
            InputTransportMessageFrame(
                message={"type": "instruction", "msg": "end_of_speech"}
            ),
        ],
        expected_down_frames=[STTFinalizeFrame, UserStoppedSpeakingFrame],
    )


async def test_close_is_called_before_stop():
    """Regression: stop-without-close waits out Azure's silence timeout again."""
    os.environ.setdefault("AZURE_SPEECH_API_KEY", "test-key")
    service = FinalizingAzureSTTService(api_key="test-key", region="eastasia")
    order = []

    stream = MagicMock()
    stream.close.side_effect = lambda: order.append("close")
    recognizer = MagicMock()
    recognizer.stop_continuous_recognition.side_effect = lambda: order.append("stop")
    service._audio_stream = stream
    service._speech_recognizer = recognizer

    async def _connect():
        service._audio_stream = MagicMock()
        service._speech_recognizer = MagicMock()

    service._connect = _connect  # type: ignore[method-assign]
    await service.finalize_utterance()
    assert order == ["close", "stop"], order


async def main():
    tests = [
        test_azure_declares_no_silence_flush,
        test_finalize_closes_the_push_stream_then_restarts,
        test_finalize_is_a_no_op_without_a_live_recognizer,
        test_end_of_speech_sends_finalize_not_silence,
        test_close_is_called_before_stop,
    ]
    failed = 0
    for test in tests:
        print(f"{test.__name__}:")
        try:
            result = test()
            if asyncio.iscoroutine(result):
                await result
            print("  ok")
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

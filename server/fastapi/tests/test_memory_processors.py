"""Behaviour tests for the memory processors.

The property the whole design rests on is that the frame path never stalls and
never reorders; the capture tests pin the one bug that silently emptied every
memory write (the aggregator swallowing the transcript).
"""
import asyncio
import os
import sys
import time

# Run from anywhere: the server's modules are flat imports off its own root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipecat.frames.frames import (  # noqa: F401
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TranscriptionFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.tests.utils import run_test

from memory.processors import (
    AssistantTurnCaptureProcessor,
    MemoryProcessor,
    UserTurnRelay,
)
from memory.session import PendingTurn


class FakeMemory:
    """Only what the processors touch: the running summary and the write queue."""

    def __init__(self, running="EARLIER IN THIS CONVERSATION:\nWe talked about whales."):
        self.running = running
        self.enqueued = []
        self.chat_group_id = "session-1"

    def session_block(self):
        return self.running

    def enqueue(self, turn):
        self.enqueued.append(turn)


def transcription(text):
    return TranscriptionFrame(text=text, user_id="u", timestamp="t")


async def test_only_one_memory_message_survives():
    """Turn after turn, the prompt must not accumulate memory blocks."""
    memory = FakeMemory()
    context = LLMContext()
    processor = MemoryProcessor(memory, context)
    frames = [transcription(f"question number {i}") for i in range(3)]

    await run_test(
        processor,
        frames_to_send=frames,
        expected_down_frames=[TranscriptionFrame] * 3,
    )
    injected = [m for m in context.messages if "<<memory>>" in str(m.get("content", ""))]
    assert len(injected) == 1, f"memory blocks accumulated: {len(injected)}"
    # And it sits last, where the next user line will follow it.
    assert "<<memory>>" in str(context.messages[-1]["content"])
    assert "whales" in str(context.messages[-1]["content"])
    print("  ok: exactly one memory message, at the end")


async def drive(processor, frames):
    """Feed frames in exact order.

    run_test cannot be used for interruption ordering: InterruptionFrame is a
    SystemFrame, so Pipecat delivers it out of band ahead of anything queued.
    That is correct behaviour for the real pipeline -- an interruption must not
    wait behind queued audio -- but it means a test that needs a specific
    interleaving has to drive the processor directly.
    """
    pushed = []

    async def capture(frame, direction=None):
        pushed.append(frame)

    processor.push_frame = capture
    for frame in frames:
        await processor.process_frame(frame, FrameDirection.DOWNSTREAM)
    return pushed


async def test_frames_pass_through_in_order():
    memory = FakeMemory()
    processor = MemoryProcessor(memory, LLMContext())
    pushed = await drive(processor, [
        transcription("tell me about"),
        InterruptionFrame(),
        transcription("something else entirely"),
    ])
    # FrameProcessor's own interruption handling wants a TaskManager we do not
    # have when driving it directly, and emits an ErrorFrame saying so. That is
    # the harness, not the code under test, so filter it out.
    forwarded = [type(f).__name__ for f in pushed if type(f).__name__ != "ErrorFrame"]
    assert forwarded == [
        "TranscriptionFrame",
        "InterruptionFrame",
        "TranscriptionFrame",
    ], f"frames were reordered or swallowed: {forwarded}"
    print("  ok: frames pass through in order")


async def test_exchange_is_captured_as_a_pair():
    memory = FakeMemory()
    processor = AssistantTurnCaptureProcessor(memory, personality_key="phoenyx")

    await run_test(
        processor,
        frames_to_send=[
            transcription("my favourite colour is blue"),
            LLMFullResponseStartFrame(),
            LLMTextFrame(text="Blue is "),
            LLMTextFrame(text="a lovely colour!"),
            LLMFullResponseEndFrame(),
        ],
        expected_down_frames=[TranscriptionFrame, LLMFullResponseStartFrame,
                              LLMTextFrame, LLMTextFrame, LLMFullResponseEndFrame],
    )
    assert len(memory.enqueued) == 1, memory.enqueued
    turn: PendingTurn = memory.enqueued[0]
    assert turn.user_text == "my favourite colour is blue"
    assert turn.agent_reply == "Blue is a lovely colour!"
    assert turn.personality_key == "phoenyx"
    print("  ok: the exchange is captured as a pair")


async def test_interrupted_reply_is_not_remembered():
    """Half a sentence the child never heard is not a memory."""
    memory = FakeMemory()
    processor = AssistantTurnCaptureProcessor(memory)

    await drive(processor, [
        transcription("tell me a long story"),
        LLMFullResponseStartFrame(),
        LLMTextFrame(text="Once upon a "),
        InterruptionFrame(),
        LLMFullResponseEndFrame(),
    ])
    assert len(memory.enqueued) == 1, memory.enqueued
    assert memory.enqueued[0].agent_reply == "", memory.enqueued[0]
    print("  ok: an interrupted reply is stored without the partial answer")


async def test_capture_survives_the_aggregator_swallowing_the_transcript():
    """The whole chain, with the real aggregator in the middle.

    Every other test here drives the capture processor directly, which is what
    hid the bug this test exists for: `LLMUserAggregator` consumes
    TranscriptionFrame and never pushes it downstream, so the capture processor
    saw no user line and silently stored nothing -- memory recorded nothing at
    all, on both transports.

    The shape matters as much as the assertion. The reply frames have to be
    produced *between* the aggregator and the capture processor, because that is
    where the LLM service sits; sending them from the top of the pipeline
    instead makes the aggregator swallow them too and tests nothing real.
    """
    from pipecat.processors.aggregators.llm_response_universal import (
        LLMUserAggregator,
    )

    class FakeLLM(FrameProcessor):
        """Stands in for the LLM service: answers whatever the aggregator ran."""

        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            await self.push_frame(frame, direction)
            if isinstance(frame, LLMContextFrame):
                await self.push_frame(LLMFullResponseStartFrame(), direction)
                await self.push_frame(LLMTextFrame("蓝鲸好棒！"), direction)
                await self.push_frame(LLMFullResponseEndFrame(), direction)

    memory = FakeMemory()
    context = LLMContext()
    relay = UserTurnRelay()

    await run_test(
        Pipeline([
            MemoryProcessor(memory, context, relay),
            LLMUserAggregator(context),
            FakeLLM(),
            AssistantTurnCaptureProcessor(memory, "default", relay),
        ]),
        frames_to_send=[TranscriptionFrame("我最喜欢的动物是蓝鲸", "user", time.time())],
        expected_down_frames=None,
        send_end_frame=True,
    )

    assert len(memory.enqueued) == 1, (
        f"expected one stored turn, got {memory.enqueued} -- the transcript did "
        "not survive the aggregator"
    )
    stored = memory.enqueued[0]
    assert stored.user_text == "我最喜欢的动物是蓝鲸", stored.user_text
    assert stored.agent_reply == "蓝鲸好棒！", stored.agent_reply
    print("  ok: the exchange is captured across the real aggregator")


async def main():
    tests = [
        test_only_one_memory_message_survives,
        test_frames_pass_through_in_order,
        test_exchange_is_captured_as_a_pair,
        test_interrupted_reply_is_not_remembered,
        test_capture_survives_the_aggregator_swallowing_the_transcript,
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

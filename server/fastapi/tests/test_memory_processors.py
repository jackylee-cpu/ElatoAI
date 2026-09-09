"""Behaviour tests for the memory processors.

The one that matters is `test_final_transcript_is_never_delayed`: the whole
design rests on the frame path never stalling, and that is exactly the property
a future edit could quietly break.
"""
import asyncio
import os
import sys
import time

# Run from anywhere: the server's modules are flat imports off its own root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# voicemem is never touched here -- MemorySession is stubbed, and memory.session
# only imports voicemem inside functions, so there is nothing to fake.

from pipecat.frames.frames import (  # noqa: F401
    LLMContextFrame,
    InterimTranscriptionFrame,
    InterruptionFrame,
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
    """A store whose search takes as long as we say it does."""

    def __init__(self, delay=0.0, result="MEMORY CONTEXT:\n- likes blue", running=""):
        self.delay = delay
        self.result = result
        self.running = running
        self.searches = []
        self.enqueued = []
        self.chat_group_id = "session-1"

    def session_block(self):
        """The free half of a memory block: what this session already covered."""
        return self.running

    async def search(self, text):
        self.searches.append(text)
        if self.delay:
            await asyncio.sleep(self.delay)
        return self.result

    def enqueue(self, turn):
        self.enqueued.append(turn)


def transcription(text, final=True):
    cls = TranscriptionFrame if final else InterimTranscriptionFrame
    return cls(text=text, user_id="u", timestamp="t")


async def test_final_transcript_is_never_delayed():
    """A slow lookup must not hold the frame path for even a moment."""
    memory = FakeMemory(delay=5.0)          # far longer than any turn
    context = LLMContext()
    processor = MemoryProcessor(memory, context)

    started = time.monotonic()
    await run_test(
        processor,
        frames_to_send=[transcription("what colour do I like", final=False),
                        transcription("what colour do I like")],
        expected_down_frames=[InterimTranscriptionFrame, TranscriptionFrame],
    )
    elapsed = time.monotonic() - started
    assert elapsed < 1.0, f"frame path was held for {elapsed:.1f}s"
    # Nothing was injected, because the lookup was not ready -- that is the
    # intended trade, not a failure.
    assert not any("<<voicemem>>" in str(m.get("content", "")) for m in context.messages)
    print(f"  ok: slow lookup did not stall the path ({elapsed*1000:.0f}ms)")


async def test_ready_prefetch_is_injected():
    memory = FakeMemory(delay=0.0)
    context = LLMContext()
    processor = MemoryProcessor(memory, context)

    class Slow(MemoryProcessor):
        """Give the prefetch a moment to land, as a real interim gap would."""
        async def process_frame(self, frame, direction):
            if isinstance(frame, TranscriptionFrame):
                await asyncio.sleep(0.05)
            await super().process_frame(frame, direction)

    processor = Slow(memory, context)
    await run_test(
        processor,
        frames_to_send=[transcription("what colour do I like", final=False),
                        transcription("what colour do I like")],
        expected_down_frames=[InterimTranscriptionFrame, TranscriptionFrame],
    )
    injected = [m for m in context.messages
                if "<<voicemem>>" in str(m.get("content", ""))]
    assert len(injected) == 1, f"expected one memory message, got {injected}"
    assert "likes blue" in injected[0]["content"]
    print("  ok: a ready prefetch is injected")


async def test_only_one_memory_message_survives():
    """Turn after turn, the prompt must not accumulate memory blocks."""
    memory = FakeMemory(delay=0.0)
    context = LLMContext()

    class Slow(MemoryProcessor):
        async def process_frame(self, frame, direction):
            if isinstance(frame, TranscriptionFrame):
                await asyncio.sleep(0.05)
            await super().process_frame(frame, direction)

    processor = Slow(memory, context)
    frames = []
    for i in range(3):
        frames.append(transcription(f"question number {i}", final=False))
        frames.append(transcription(f"question number {i}"))

    await run_test(
        processor,
        frames_to_send=frames,
        expected_down_frames=[type(f) for f in frames],
    )
    injected = [m for m in context.messages
                if "<<voicemem>>" in str(m.get("content", ""))]
    assert len(injected) == 1, f"memory blocks accumulated: {len(injected)}"
    # And it sits last, where the next user line will follow it.
    assert "<<voicemem>>" in str(context.messages[-1]["content"])
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


async def test_interruption_drops_the_in_flight_lookup():
    memory = FakeMemory(delay=5.0, result="MEMORY CONTEXT:\n- stale")
    context = LLMContext()
    processor = MemoryProcessor(memory, context)

    pushed = await drive(processor, [
        transcription("tell me about", final=False),
        InterruptionFrame(),
        transcription("something else entirely"),
    ])

    # FrameProcessor's own interruption handling wants a TaskManager we do not
    # have when driving it directly, and emits an ErrorFrame saying so. That is
    # the harness, not the code under test, so filter it out.
    forwarded = [type(f).__name__ for f in pushed if type(f).__name__ != "ErrorFrame"]
    assert forwarded == [
        "InterimTranscriptionFrame",
        "InterruptionFrame",
        "TranscriptionFrame",
    ], f"frames were reordered or swallowed: {forwarded}"
    assert not any("<<voicemem>>" in str(m.get("content", ""))
                   for m in context.messages), "stale lookup leaked across turns"
    # The lookup started for the abandoned turn must actually be cancelled, not
    # merely ignored -- otherwise a slow search keeps a thread busy per barge-in.
    assert processor._pending is None, "an in-flight lookup outlived its turn"
    print("  ok: an interruption drops the in-flight lookup")


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
        test_final_transcript_is_never_delayed,
        test_ready_prefetch_is_injected,
        test_only_one_memory_message_survives,
        test_interruption_drops_the_in_flight_lookup,
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

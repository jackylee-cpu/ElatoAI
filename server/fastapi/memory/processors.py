"""Pipecat processors that read and write long-term memory.

The governing rule here is that **neither processor ever holds a frame**.

Barge-in on this pipeline already drops audio on roughly one turn in three, and
the cause is a frame-ordering and STT-mute-latch race around interruption --
see the comments in bot.py around InterruptionFrame. Pipecat processes frames in
order, one at a time, so an `await` inside `process_frame` stalls everything
queued behind it, including the InterruptionFrame itself.

Nothing here needs to wait anyway. What a turn gets from memory -- the running
summary of this session -- is a string already sitting on the MemorySession,
and what gets written is handed to a queue. Who the child is and what the last
sessions were about are in the system prompt, put there once at connect.

What gets injected is the shared LLMContext, not a frame, so injection cannot
perturb frame ordering at all.
"""

from __future__ import annotations

import os
import time

from loguru import logger
from pipecat.frames.frames import (
    Frame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TranscriptionFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from memory.session import MemorySession, PendingTurn

# How many completed exchanges stay in the prompt verbatim. Pipecat's context
# otherwise grows for the whole session, and on a toy that is left connected
# that is both the cost and the reason late turns start drifting: the character
# instructions end up a long way behind an hour of chatter.
#
# Trimming is only safe because MemorySession.session_block() covers what falls
# out -- the two are one mechanism and changing this without reading that is how
# the window becomes a memory hole. 0 disables trimming.
MAX_HISTORY_TURNS = max(0, min(int(os.getenv("MEMORY_MAX_HISTORY_TURNS", "8")), 40))

# The one context message memory ever writes. Kept as a marker so each turn
# rewrites the same message instead of appending a new one -- appending would
# grow the prompt by a memory block per turn and re-state stale summaries.
_MEMORY_MARKER = "<<memory>>"


class UserTurnRelay:
    """Carries the child's line across the aggregator that swallows it.

    `LLMUserAggregator` consumes TranscriptionFrame and deliberately does not
    push it downstream (pipecat/processors/aggregators/llm_response_universal.py:
    "not pushed downstream, same as final TranscriptionFrame"). Everything after
    the LLM therefore never learns what the child said -- which silently emptied
    every memory write, because AssistantTurnCaptureProcessor sits there to wait
    for the reply and found no user text to pair it with.

    MemoryProcessor runs before the aggregator and does see that frame, so it
    hands the line over here rather than the capture processor guessing.
    """

    def __init__(self):
        self.text = ""
        self.observed_at = ""

    def set(self, text: str) -> None:
        self.text = text
        self.observed_at = time.strftime("%Y-%m-%dT%H:%M:%S")

    def take(self) -> tuple[str, str]:
        """Read the pending line and clear it, so no turn is stored twice."""
        text, observed_at = self.text, self.observed_at
        self.text = ""
        self.observed_at = ""
        return text, observed_at


def _memory_message(block: str) -> dict:
    return {"role": "developer", "content": f"{_MEMORY_MARKER}\n{block}"}


def _role_of(message: object) -> str | None:
    """The role of a context message, whatever shape the aggregator used.

    Pipecat's universal context stores plain dicts today, but the trim below
    must degrade to "leave it alone" rather than to "drop everything" if that
    ever changes.
    """
    role = message.get("role") if isinstance(message, dict) else getattr(message, "role", None)
    return role if isinstance(role, str) else None


def _is_memory_message(message: object) -> bool:
    if not isinstance(message, dict):
        return False
    content = message.get("content")
    return isinstance(content, str) and content.startswith(_MEMORY_MARKER)


class MemoryProcessor(FrameProcessor):
    """On each final transcript: trim the history, refresh the memory message."""

    def __init__(
        self,
        memory: MemorySession,
        context: LLMContext,
        relay: "UserTurnRelay | None" = None,
        max_history_turns: int = MAX_HISTORY_TURNS,
    ):
        super().__init__()
        self._memory = memory
        self._context = context
        self._relay = relay
        self._max_history_turns = max_history_turns

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, TranscriptionFrame):
            text = (frame.text or "").strip()
            if text:
                # Rewritten even when the summary is empty: the trim has to run
                # on every turn, not only on the turns with something to add.
                self._rewrite_context(self._memory.session_block())
                # Hand the line to the capture processor downstream: the
                # aggregator between us is about to consume this frame.
                if self._relay is not None:
                    self._relay.set(text)

        await self.push_frame(frame, direction)

    def _rewrite_context(self, block: str) -> None:
        """Trim the history window, then put one fresh memory message at the end.

        Two things matter about the memory message. Exactly one may exist, or
        the prompt grows by a block per turn and carries stale memories
        forward. And it belongs at the end: this runs before the user
        aggregator appends the child's line, so appending now puts memory
        immediately ahead of it. Rewriting the old entry in place would instead
        leave it stranded near the top as the conversation grows.
        """
        try:
            messages = self._context.get_messages()
        except Exception as exc:  # noqa: BLE001 - never break a turn over this
            logger.warning("Could not read LLM context to inject memory: {}", exc)
            return

        kept = self._trim_history(
            [message for message in messages if not _is_memory_message(message)]
        )
        if block:
            kept.append(_memory_message(block))

        try:
            self._context.set_messages(kept)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not write memory into the LLM context: {}", exc)

    def _trim_history(self, messages: list) -> list:
        """Keep only the last N exchanges, and everything that is not history.

        Non-conversational messages are kept wherever they are: the greeting
        instruction bot.py queues on connect is a `developer` message, and
        dropping it because it is old would change how the toy opens.

        Whatever this drops is not lost -- MemorySession's running summary
        covers it, and `memories` has the utterances themselves. Without that
        pairing this would just be forgetting, which is why the two landed in
        the same change.
        """
        if self._max_history_turns <= 0:
            return list(messages)

        limit = self._max_history_turns * 2
        history = [
            index
            for index, message in enumerate(messages)
            if _role_of(message) in ("user", "assistant")
        ]
        if len(history) <= limit:
            return list(messages)

        dropped = set(history[:-limit])
        logger.debug(
            "History window: dropping {} message(s), keeping the last {} exchange(s)",
            len(dropped),
            self._max_history_turns,
        )
        return [
            message for index, message in enumerate(messages) if index not in dropped
        ]


class AssistantTurnCaptureProcessor(FrameProcessor):
    """Pair each user line with the toy's answer and hand both to memory.

    Memory wants the exchange, not the two halves separately: the transcript
    stores both, and consolidation reads the reply to understand what the
    child meant ("yes" means nothing without the question). So the write waits
    until the answer is complete -- which is also comfortably off the critical
    path.

    The delta accumulation mirrors what bot.py already does for the browser
    transcript, rather than inventing a second shape for the same thing.
    """

    def __init__(
        self,
        memory: MemorySession,
        personality_key: str | None = None,
        relay: "UserTurnRelay | None" = None,
    ):
        super().__init__()
        self._memory = memory
        self._personality_key = personality_key
        self._relay = relay
        self._user_text = ""
        self._reply_parts: list[str] = []
        self._observed_at = ""

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, TranscriptionFrame):
            text = (frame.text or "").strip()
            if text:
                # A new user line supersedes any half-captured previous turn:
                # if the last one produced no reply, it was interrupted, and an
                # interrupted turn is not something to remember.
                self._user_text = text
                self._reply_parts = []
                self._observed_at = time.strftime("%Y-%m-%dT%H:%M:%S")

        elif isinstance(frame, LLMFullResponseStartFrame):
            self._reply_parts = []

        elif isinstance(frame, LLMTextFrame):
            if frame.text:
                self._reply_parts.append(frame.text)

        elif isinstance(frame, LLMFullResponseEndFrame):
            self._commit()

        elif isinstance(frame, InterruptionFrame):
            # Half a sentence the child never heard is not a memory. Only the
            # reply is dropped: the child's own line still deserves to be
            # remembered, and the aggregator broadcasts an interruption while
            # handling the very transcript that produced it -- clearing the
            # relay here threw away every turn.
            self._reply_parts = []

        await self.push_frame(frame, direction)

    def _commit(self) -> None:
        reply = "".join(self._reply_parts).strip()
        user_text = self._user_text.strip()
        observed_at = self._observed_at
        self._reply_parts = []
        self._user_text = ""
        if not user_text and self._relay is not None:
            # In the real pipeline this is the only source: the aggregator
            # upstream consumes TranscriptionFrame, so one never reaches us.
            user_text, relayed_at = self._relay.take()
            observed_at = relayed_at or observed_at
        if not user_text:
            return
        self._memory.enqueue(
            PendingTurn(
                user_text=user_text,
                agent_reply=reply,
                personality_key=self._personality_key,
                observed_at=observed_at,
            )
        )

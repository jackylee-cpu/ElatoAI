"""Per-turn STT -> LLM -> TTS latency, measured from the frames themselves.

The pipeline has been running with `enable_metrics=True` since it was written,
producing a MetricsFrame per service that nothing ever read. This observer
reads them, and adds the wall-clock spans pipecat does not measure: how long
after the child let go of the button the words arrived, and how long after that
the toy made a sound.

Why an observer and not another FrameProcessor: an observer is not in the
pipeline. It cannot hold, reorder or delay a frame, so it cannot distort the
very numbers it is here to record. `on_push_frame` hands it the pipeline
clock's timestamp for every hop, which is all the timing it needs.

Why not pipecat's own UserBotLatencyObserver: it anchors the turn on
VADUserStoppedSpeakingFrame (user_bot_latency_observer.py:244). Both clients
here are push-to-talk -- the client sends `end_of_speech`, and
RealtimeInputControlProcessor pushes UserStoppedSpeakingFrame straight away.
The VAD frame is a different event: Silero fires it after `stop_secs` of
quiet, which on a held button is a mid-sentence pause, and after the mic
closes is several hundred milliseconds later than the release. Anchoring
there would either start the clock too early (a pause while holding) or too
late (VAD catching up after commit). The PTT frame is the start when it
exists; VAD is only the fallback for hands-free.

Every span is milliseconds, and every one of them is allowed to be None: a turn
can be cut short by barge-in, a dropped socket or an LLM error, and a
half-measured turn is still worth having.
"""

from __future__ import annotations

from collections import deque
from typing import Any, Callable

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    CancelFrame,
    EndFrame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    MetricsFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.utils.time import time_now_iso8601

from pipecat.metrics.metrics import (
    LLMUsageMetricsData,
    ProcessingMetricsData,
    TTFAMetricsData,
    TTFBMetricsData,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.processors.frame_processor import FrameDirection

from metrics import store

# The pipeline clock counts nanoseconds since the task started.
_NS_PER_MS = 1_000_000


def _ms(start: int | None, end: int | None) -> int | None:
    """Span between two pipeline-clock readings, or None if either is missing.

    Negative spans are dropped rather than clamped. A negative number here means
    the frame ordering was not what this observer assumes, and a silent 0 would
    hide that in an average.
    """
    if start is None or end is None:
        return None
    delta = (end - start) // _NS_PER_MS
    return int(delta) if delta >= 0 else None


class _Turn:
    """Timestamps and text for one conversational turn, all in pipeline-clock ns."""

    def __init__(self) -> None:
        self.user_stop: int | None = None
        self.transcript: int | None = None
        self.stt_done_at: str | None = None
        self.turn_closed: int | None = None
        self.llm_start: int | None = None
        self.llm_first_text: int | None = None
        self.llm_end: int | None = None
        self.bot_start: int | None = None
        self.transcript_text: str = ""
        self.response_text: str = ""
        self.interrupted: bool = False
        self.prompt_tokens: int | None = None
        self.completion_tokens: int | None = None
        self.ttfb: list[dict[str, Any]] = []
        self.ttfa: list[dict[str, Any]] = []
        self.processing: list[dict[str, Any]] = []

    def has_anything(self) -> bool:
        """Is there a measurement here worth a row?

        The opening greeting has no user speech at all, so `user_stop` being
        None is not on its own a reason to drop a turn -- but a turn where the
        LLM never ran and the bot never spoke is just noise.
        """
        return self.llm_first_text is not None or self.bot_start is not None


class TurnMetricsObserver(BaseObserver):
    """Writes one turn_metrics row per turn.

    Args:
        user_id: Account the session belongs to, or None for an unclaimed
            device or an anonymous browser session.
        chat_group_id: The session's uuid, shared with `conversations` and
            `memory_segments` so a slow turn can be read next to what was said.
        transport: "browser" or "esp32".
        personality_key / stt_provider / llm_provider / tts_provider / llm_model:
            recorded on every row, because the whole point is comparing them.
        sink: where finished rows go. Defaults to the Supabase writer; tests
            pass a list's append.
        max_frames: how many frame ids to remember for de-duplication. A frame
            is pushed once per processor hop and must only be counted at its
            first sighting.
    """

    def __init__(
        self,
        *,
        user_id: str | None = None,
        chat_group_id: str | None = None,
        transport: str | None = None,
        personality_key: str | None = None,
        stt_provider: str | None = None,
        llm_provider: str | None = None,
        tts_provider: str | None = None,
        llm_model: str | None = None,
        sink: Callable[[dict[str, Any]], None] | None = None,
        max_frames: int = 200,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._user_id = user_id
        self._chat_group_id = chat_group_id
        self._transport = transport
        self._personality_key = personality_key
        self._stt_provider = stt_provider
        self._llm_provider = llm_provider
        self._tts_provider = tts_provider
        self._llm_model = llm_model
        self._sink = sink or store.record_turn

        self._turn = _Turn()
        self._turn_index = 0

        # Bounded deque + set, the same pattern pipecat's own observers use: the
        # set answers "seen it?" in O(1), the deque bounds how much is kept.
        self._seen: set[int] = set()
        self._history: deque = deque(maxlen=max_frames)

    async def on_push_frame(self, data: FramePushed):
        """Accumulate one frame into the turn in progress."""
        if data.direction != FrameDirection.DOWNSTREAM:
            return

        frame = data.frame
        if frame.id in self._seen:
            return
        self._seen.add(frame.id)
        self._history.append(frame.id)
        if len(self._seen) > len(self._history):
            self._seen = set(self._history)

        try:
            self._observe(frame, data.timestamp)
        except Exception as exc:  # noqa: BLE001 - measuring must not break the call
            logger.warning("Turn metrics observer errored: {}", exc)

    def _observe(self, frame, timestamp: int) -> None:
        turn = self._turn

        if isinstance(frame, (UserStartedSpeakingFrame, VADUserStartedSpeakingFrame)):
            # The child speaking while the previous turn is still open *is* a
            # barge-in. Recording it here rather than waiting for
            # InterruptionFrame makes the flag independent of which of the two
            # arrives first, which is not something this observer can rely on.
            if turn.has_anything():
                turn.interrupted = True
                self._flush()
            else:
                self._turn = _Turn()
            return

        if isinstance(frame, UserStoppedSpeakingFrame):
            # The client's commit is the PTT clock start, even if VAD already
            # fired on a pause while the button was still down. First-wins
            # with VAD would bill the rest of the utterance to STT.
            turn.user_stop = timestamp
            return

        if isinstance(frame, VADUserStoppedSpeakingFrame):
            # Hands-free never sends end_of_speech; VAD is all there is.
            # After an explicit commit this frame is a late echo and must
            # not move the mark.
            if turn.user_stop is None:
                turn.user_stop = timestamp
            return

        if isinstance(frame, TranscriptionFrame):
            # Last transcript before the LLM runs. A segmenting recognizer can
            # split one sentence across several frames, and the turn is not
            # transcribed until the last of them.
            if turn.llm_first_text is None:
                turn.transcript = timestamp
                # The pipeline clock only counts nanoseconds since the task
                # started, which says nothing once the row is in the table. The
                # wall clock is what lets the moment STT finished be lined up
                # against the conversation, the server log and the device.
                turn.stt_done_at = time_now_iso8601()
                text = (frame.text or "").strip()
                if text:
                    turn.transcript_text = f"{turn.transcript_text} {text}".strip()
            return

        if isinstance(frame, LLMContextFrame):
            # The user aggregator pushes the context the instant the turn
            # closes, which is the instant the LLM may begin. Between this and
            # the final transcript sits ExternalUserTurnStopStrategy's
            # transcript-merge timer (PTT_TRANSCRIPT_MERGE_SECS, 80ms) --
            # without this anchor that wait is billed to the LLM, which
            # never saw it.
            if turn.turn_closed is None:
                turn.turn_closed = timestamp
            return

        if isinstance(frame, LLMFullResponseStartFrame):
            if turn.llm_start is None:
                turn.llm_start = timestamp
            return

        if isinstance(frame, LLMTextFrame):
            if turn.llm_first_text is None:
                turn.llm_first_text = timestamp
            turn.response_text += frame.text or ""
            return

        if isinstance(frame, LLMFullResponseEndFrame):
            turn.llm_end = timestamp
            return

        if isinstance(frame, BotStartedSpeakingFrame):
            if turn.bot_start is None:
                turn.bot_start = timestamp
            return

        if isinstance(frame, BotStoppedSpeakingFrame):
            # The turn is only fully measured here, not at BotStartedSpeaking:
            # TTS begins on the first sentence, so the LLM is usually still
            # generating when the toy starts talking.
            self._flush()
            return

        if isinstance(frame, InterruptionFrame):
            turn.interrupted = True
            return

        if isinstance(frame, (EndFrame, CancelFrame)):
            self._flush()
            return

        if isinstance(frame, MetricsFrame):
            self._collect_metrics(frame)
            return

    def _collect_metrics(self, frame: MetricsFrame) -> None:
        """Keep what each service says about itself, alongside what we measured.

        These are the vendor's own numbers. When they disagree with the
        wall-clock spans the difference is time spent in the pipeline rather
        than at the far end of an API call -- which is the distinction you need
        before blaming a model for being slow.
        """
        turn = self._turn
        for item in frame.data:
            if isinstance(item, TTFBMetricsData):
                turn.ttfb.append(
                    {"processor": item.processor, "model": item.model, "secs": item.value}
                )
            elif isinstance(item, TTFAMetricsData):
                turn.ttfa.append(
                    {
                        "processor": item.processor,
                        "model": item.model,
                        "secs": item.ttfa,
                        # How much of the wait was the service padding silence
                        # onto the front rather than taking time to respond.
                        "leading_silence_secs": item.leading_silence,
                    }
                )
            elif isinstance(item, ProcessingMetricsData):
                turn.processing.append(
                    {"processor": item.processor, "model": item.model, "secs": item.value}
                )
            elif isinstance(item, LLMUsageMetricsData):
                turn.prompt_tokens = item.value.prompt_tokens
                turn.completion_tokens = item.value.completion_tokens

    def _flush(self) -> None:
        turn = self._turn
        self._turn = _Turn()
        if not turn.has_anything():
            return

        self._turn_index += 1
        row: dict[str, Any] = {
            "turn_index": self._turn_index,
            "transport": self._transport,
            "personality_key": self._personality_key,
            "stt_provider": self._stt_provider,
            "llm_provider": self._llm_provider,
            "tts_provider": self._tts_provider,
            "llm_model": self._llm_model,
            "stt_ms": _ms(turn.user_stop, turn.transcript),
            "stt_done_at": turn.stt_done_at,
            # Dead time between STT finishing and the LLM being allowed to
            # start. Still inside llm_ttfb_ms, which is left alone so rows
            # written before this column stay comparable -- subtract it to get
            # the model's own time to first token.
            "turn_close_ms": _ms(turn.transcript, turn.turn_closed),
            "llm_ttfb_ms": _ms(turn.transcript, turn.llm_first_text),
            "llm_total_ms": _ms(turn.llm_first_text, turn.llm_end),
            "tts_ttfb_ms": _ms(turn.llm_first_text, turn.bot_start),
            "total_ms": _ms(turn.user_stop, turn.bot_start),
            "prompt_tokens": turn.prompt_tokens,
            "completion_tokens": turn.completion_tokens,
            "transcript_chars": len(turn.transcript_text),
            "response_chars": len(turn.response_text),
            "interrupted": turn.interrupted,
            "detail": {
                "ttfb": turn.ttfb,
                "ttfa": turn.ttfa,
                "processing": turn.processing,
            },
        }
        # PostgREST rejects an empty string where a uuid is expected, so these
        # are omitted rather than sent blank.
        if self._user_id:
            row["user_id"] = self._user_id
        if self._chat_group_id:
            row["chat_group_id"] = self._chat_group_id

        logger.info(
            "Turn {} metrics: stt={}ms turn_close={}ms llm_ttfb={}ms tts_ttfb={}ms "
            "total={}ms model={}",
            self._turn_index,
            row["stt_ms"],
            row["turn_close_ms"],
            row["llm_ttfb_ms"],
            row["tts_ttfb_ms"],
            row["total_ms"],
            self._llm_model or "default",
        )
        self._sink(row)

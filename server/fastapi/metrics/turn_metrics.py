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

Where the clock starts. Both clients here are push-to-talk, and the button
coming up is the only honest start for `stt_ms`: the child has finished
speaking and is now waiting. That moment reaches the server as the
`end_of_speech` websocket message, and the transport pushes it as an
InputTransportMessageFrame before anything else in the pipeline reacts to it
-- ahead of the trailing silence, the finalize, and the UserStoppedSpeakingFrame
RealtimeInputControlProcessor derives from it. So that frame is the anchor,
and the frames downstream of it can only fill a mark it left empty.

Why not pipecat's own UserBotLatencyObserver: it anchors on
VADUserStoppedSpeakingFrame (user_bot_latency_observer.py:244). The VAD stop is
a different event -- Silero fires it after `stop_secs` of quiet, which on a held
button is a mid-sentence pause, and after the mic closes is several hundred
milliseconds later than the release. It is the fallback for hands-free and
nothing more.

A mark is only ever taken from the turn the release arrived in, and never
after that turn has been transcribed. Without that rule a child who says
something short and then keeps holding the button gets their release billed
to whatever turn happened to be open when their thumb came up -- which, once
the answer had played and the turn had been flushed, was the *next* turn.
That is how a nine second STT gets into the table on a streaming recognizer
that finalizes in under half a second. Every row now carries the anchor it
used in `detail.stt_anchor`, so a number like that can be read rather than
guessed at.

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
    InputTransportMessageFrame,
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
    STTUsageMetricsData,
    TTFAMetricsData,
    TTFBMetricsData,
    TTSUsageMetricsData,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.processors.frame_processor import FrameDirection

from metrics import store

# The pipeline clock counts nanoseconds since the task started.
_NS_PER_MS = 1_000_000

# How faithful each anchor is to the button actually coming up. The client's
# own end_of_speech is the button; the UserStoppedSpeakingFrame derived from
# it is a few pipeline hops later; the VAD stop is a different event
# altogether and only stands in for hands-free. A better source may replace
# a worse one, never the other way round, and never itself.
_RELEASE_RANK = {None: -1, "vad": 0, "stopped": 1, "commit": 2}


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
        self.user_stop_source: str | None = None
        self.speech_started: bool = False
        self.late_release: bool = False
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
        device_id: The board, from its verified token, so cost can be summed
            per toy. None for the web playground.
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
        device_id: str | None = None,
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
        self._device_id = device_id
        self._transport = transport
        self._personality_key = personality_key
        self._stt_provider = stt_provider
        self._llm_provider = llm_provider
        self._tts_provider = tts_provider
        self._llm_model = llm_model
        self._sink = sink or store.record_turn

        self._turn = _Turn()
        self._turn_index = 0

        # What the STT and TTS vendors bill on, since the last row was written.
        # Kept here rather than on the turn: usage reports arrive on their own
        # schedule (Azure's on each final phrase, TTS per sentence), often
        # after the turn they belong to has been flushed, and a press where
        # nothing was said is billed without ever becoming a turn. Each row
        # takes what has accumulated, so the sum over a session is right even
        # where a single row's share is a little early or late.
        self._stt_audio_s = 0.0
        self._tts_chars = 0

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
            # Whether the child was ever heard in this turn. A release that
            # lands on a turn nobody spoke in is a stray, and a turn that is
            # transcribed without one is an anomaly worth seeing on the row
            # rather than silently averaging in.
            self._turn.speech_started = True
            return

        if isinstance(frame, InputTransportMessageFrame):
            # The button coming up, as early as the server can see it. The
            # transport pushes this the instant it reads the websocket text
            # frame -- ahead of the trailing silence, the finalize, and the
            # UserStoppedSpeakingFrame that RealtimeInputControlProcessor
            # derives from it further down. Anchoring here is what makes
            # stt_ms "since the child let go" rather than "since some frame
            # the pipeline got round to emitting afterwards".
            message = frame.message if isinstance(frame.message, dict) else {}
            if message.get("type") == "instruction" and message.get("msg") == "end_of_speech":
                self._mark_release(timestamp, "commit")
            return

        if isinstance(frame, UserStoppedSpeakingFrame):
            # The commit's own frame, or -- for a client that closes turns some
            # other way -- the only stop there is. Either way it is a worse
            # mark than the message above and cannot displace it.
            self._mark_release(timestamp, "stopped")
            return

        if isinstance(frame, VADUserStoppedSpeakingFrame):
            # Hands-free never sends end_of_speech; VAD is all there is.
            # On a held button this frame is either a mid-sentence pause or a
            # late echo of the commit, so it only ever fills an empty mark.
            self._mark_release(timestamp, "vad")
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
            self._flush(final=True)
            return

        if isinstance(frame, MetricsFrame):
            self._collect_metrics(frame)
            return

    def _mark_release(self, timestamp: int, source: str) -> None:
        """Put the STT clock's start mark down -- or refuse to move it.

        The refusal is the half that matters. A release that arrives when this
        turn has already been transcribed does not belong to it: the VAD closed
        the turn on a pause, the answer is already on its way, and the child is
        only now taking their thumb off the button. Letting it through dated a
        turn to a moment after its own transcript, which `_ms` then threw away
        as negative -- and once the answer had finished and the turn had been
        flushed, the same stray release landed on the *next*, empty turn and sat
        there until somebody spoke again. That turn was then timed from a button
        press several seconds before its own speech: the nine second STT that
        started this. A mark is only ever taken from the turn it arrived in.
        """
        turn = self._turn
        if not turn.speech_started:
            # Nobody has been heard in this turn yet, so nothing in it can have
            # been released. This is the thumb coming up long after the VAD
            # closed the last turn and the answer finished playing: the mark
            # would sit in the empty turn unclaimed and then date whatever the
            # child said next. Leaving stt_ms missing says that; keeping the
            # mark would have said nine seconds.
            turn.late_release = True
            return
        if turn.transcript is not None:
            # Whoever let go, they let go of a turn that was already read.
            turn.late_release = True
            return
        if _RELEASE_RANK[source] <= _RELEASE_RANK[turn.user_stop_source]:
            # Same source twice is the frame being re-emitted downstream, and a
            # worse source cannot displace a better one. The first sighting of
            # the best source available is the mark.
            return
        turn.user_stop = timestamp
        turn.user_stop_source = source

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
                # Summed: a turn whose LLM ran twice was billed twice.
                turn.prompt_tokens = (turn.prompt_tokens or 0) + (item.value.prompt_tokens or 0)
                turn.completion_tokens = (turn.completion_tokens or 0) + (
                    item.value.completion_tokens or 0
                )
            elif isinstance(item, STTUsageMetricsData):
                self._stt_audio_s += item.value.audio_seconds or 0.0
            elif isinstance(item, TTSUsageMetricsData):
                self._tts_chars += item.value or 0

    def _take_usage(self) -> dict[str, Any]:
        """The STT and TTS usage accumulated since the last row, and reset it."""
        usage = {
            "stt_audio_ms": round(self._stt_audio_s * 1000),
            "tts_chars": self._tts_chars,
        }
        self._stt_audio_s = 0.0
        self._tts_chars = 0
        return usage

    def _identity(self, row: dict[str, Any]) -> dict[str, Any]:
        # PostgREST rejects an empty string where a uuid is expected, so these
        # are omitted rather than sent blank.
        if self._user_id:
            row["user_id"] = self._user_id
        if self._chat_group_id:
            row["chat_group_id"] = self._chat_group_id
        if self._device_id:
            row["device_id"] = self._device_id
        return row

    def _flush(self, final: bool = False) -> None:
        turn = self._turn
        self._turn = _Turn()
        if not turn.has_anything():
            # Nothing to time, but possibly something billed: audio from a
            # press that produced no answer, or the recognizer's last report.
            # Only written as the session ends; until then it rides along on
            # the next real turn.
            if final and (self._stt_audio_s > 0 or self._tts_chars > 0):
                self._sink(
                    self._identity(
                        {
                            "row_kind": "usage",
                            "turn_index": self._turn_index,
                            "transport": self._transport,
                            "personality_key": self._personality_key,
                            "stt_provider": self._stt_provider,
                            "llm_provider": self._llm_provider,
                            "tts_provider": self._tts_provider,
                            "llm_model": self._llm_model,
                            **self._take_usage(),
                        }
                    )
                )
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
            **self._take_usage(),
            "interrupted": turn.interrupted,
            "detail": {
                "ttfb": turn.ttfb,
                "ttfa": turn.ttfa,
                "processing": turn.processing,
                # What stt_ms is actually measured from, so a surprising row can
                # be read instead of guessed at. "commit" is the client's own
                # end_of_speech -- the button. "stopped" is the frame derived
                # from it, "vad" is the recognizer's silence detector standing
                # in for a client that never said it was done, and None is a
                # turn with no start mark at all.
                "stt_anchor": turn.user_stop_source,
                # A turn transcribed without the child ever being heard to
                # start, or a release for a turn already read. Neither is
                # normal, and both change what the number above means.
                "speech_started": turn.speech_started,
                "late_release": turn.late_release,
            },
        }
        self._identity(row)

        logger.info(
            "Turn {} metrics: stt={}ms (from {}) turn_close={}ms llm_ttfb={}ms "
            "tts_ttfb={}ms total={}ms model={}",
            self._turn_index,
            row["stt_ms"],
            turn.user_stop_source or "nothing",
            row["turn_close_ms"],
            row["llm_ttfb_ms"],
            row["tts_ttfb_ms"],
            row["total_ms"],
            self._llm_model or "default",
        )
        if turn.late_release or (turn.transcript is not None and not turn.speech_started):
            # Say it once, on the turn it happened to, with the numbers next to
            # it. An anchor that came from the wrong event is invisible in an
            # average and obvious here.
            logger.warning(
                "Turn {} anchor is suspect: anchor={} speech_started={} late_release={} "
                "stt={}ms -- the release and the speech may belong to different turns",
                self._turn_index,
                turn.user_stop_source,
                turn.speech_started,
                turn.late_release,
                row["stt_ms"],
            )
        self._sink(row)

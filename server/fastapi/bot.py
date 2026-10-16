#
# Copyright (c) 2024-2026, Daily
#
# SPDX-License-Identifier: BSD 2-Clause License
#

"""Shared Pipecat bot logic for the local multi-transport server."""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from typing import Any, Literal

from app_settings import fetch_voice_settings
from models.stt.finalize import STTFinalizeFrame
from voice_pipeline import build_voice_pipeline, resolve_voice_stack
from world_context import fetch_world_block
from dotenv import load_dotenv
from metrics.turn_metrics import TurnMetricsObserver
from gem_live_route import build_gem_live_route
from grok_route import build_grok_route
from loguru import logger

logger.info("Loading Silero VAD model...")

logger.info("Silero VAD model loaded")

from pipecat.frames.frames import (
    BotStoppedSpeakingFrame,
    ErrorFrame,
    Frame,
    InputAudioRawFrame,
    InputTransportMessageFrame,
    InterruptionFrame,
    InterimTranscriptionFrame,
    LLMContextFrame,
    LLMFullResponseStartFrame,
    LLMRunFrame,
    LLMTextFrame,
    OutputAudioRawFrame,
    OutputTransportMessageFrame,
    OutputTransportMessageUrgentFrame,
    StartFrame,
    STTMuteFrame,
    TranscriptionFrame,
    TTSStoppedFrame,
    TTSTextFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.transports.base_transport import BaseTransport

logger.info("All components loaded successfully")

load_dotenv(override=True)
CURRENT_VOICE_ROUTE = os.getenv("CURRENT_VOICE_ROUTE", "classic").strip().lower()
AUDIO_IN_SAMPLE_RATE = int(os.getenv("PIPELINE_AUDIO_IN_SAMPLE_RATE", "16000"))
AUDIO_OUT_SAMPLE_RATE = int(os.getenv("PIPELINE_AUDIO_OUT_SAMPLE_RATE", "24000"))


def _new_item_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:16]}"


def _ticks_to_ms(value: Any) -> int | None:
    if isinstance(value, (int, float)):
        return int(value / 10_000)
    return None


def _azure_timing(frame: Frame) -> dict[str, Any]:
    """Pull Azure SDK latency off a Pipecat STT frame."""
    event = getattr(frame, "result", None)
    result = getattr(event, "result", None)
    if result is None:
        return {}

    payload: dict[str, Any] = {}
    offset_ms = _ticks_to_ms(getattr(result, "offset", None))
    duration_ms = _ticks_to_ms(getattr(result, "duration", None))
    if offset_ms is not None:
        payload["offset_ms"] = offset_ms
    if duration_ms is not None:
        payload["duration_ms"] = duration_ms

    properties = getattr(result, "properties", None)
    if properties is not None:
        try:
            from azure.cognitiveservices.speech import PropertyId

            raw_latency = properties.get_property(
                PropertyId.SpeechServiceResponse_RecognitionLatencyMs
            )
            if raw_latency:
                payload["latency_ms"] = int(float(raw_latency))
        except Exception:
            pass
    return payload


def _user_transcript_payload(state: TranscriptSessionState, frame: Frame, *, final: bool) -> dict:
    payload = {
        "type": "server",
        "msg": "USER.TRANSCRIPT",
        "item_id": state.ensure_user_item(),
        "text": getattr(frame, "text", None) or "",
        "final": final,
    }
    elapsed_ms = state.elapsed_ms()
    if elapsed_ms is not None:
        payload["elapsed_ms"] = elapsed_ms
    payload.update(_azure_timing(frame))
    # Do not copy elapsed_ms into latency_ms. elapsed is speech-start → now
    # (utterance duration included). latency_ms is Azure's own
    # RecognitionLatencyMs (last audio → result). Mixing them made the
    # transcript bubble's 「首字」 look like STT when Azure omitted the
    # property, usually on interims.
    return payload


class TranscriptSessionState:
    """Shared turn IDs so STT/LLM/TTS processors emit one bubble per utterance."""

    def __init__(self):
        self.user_item_id: str | None = None
        self.bot_item_id: str | None = None
        self.emitted_llm_text = False
        self.user_turn_open = False
        self.user_speech_started_at: float | None = None
        self.seen_frame_ids: set[int] = set()

    def mark_user_speech_start(self) -> None:
        self.user_speech_started_at = time.monotonic()

    def elapsed_ms(self) -> int | None:
        if self.user_speech_started_at is None:
            return None
        return int((time.monotonic() - self.user_speech_started_at) * 1000)

    def remember(self, frame: Frame) -> bool:
        frame_id = getattr(frame, "id", None)
        if not isinstance(frame_id, int):
            return True
        if frame_id in self.seen_frame_ids:
            return False
        self.seen_frame_ids.add(frame_id)
        return True

    def ensure_user_item(self) -> str:
        if not self.user_item_id:
            self.user_item_id = _new_item_id("user")
        return self.user_item_id

    def ensure_bot_item(self) -> str:
        if not self.bot_item_id:
            self.bot_item_id = _new_item_id("bot")
        return self.bot_item_id


async def _emit_browser_message(
    processor: FrameProcessor,
    direction: FrameDirection,
    payload: dict,
) -> None:
    """Send transcript JSON immediately, without waiting behind TTS audio."""
    await processor.push_frame(
        OutputTransportMessageUrgentFrame(message=payload),
        direction,
    )


async def forward_transcript_frame(
    processor: FrameProcessor,
    state: TranscriptSessionState,
    frame: Frame,
    direction: FrameDirection,
    *,
    include_tts_text: bool = False,
) -> None:
    """Emit browser transcript events without consuming the original frame."""
    if direction is not FrameDirection.DOWNSTREAM:
        return
    frame_types: tuple[type, ...] = (
            UserStartedSpeakingFrame,
            VADUserStartedSpeakingFrame,
            InterimTranscriptionFrame,
            TranscriptionFrame,
        LLMFullResponseStartFrame,
        LLMTextFrame,
    )
    if include_tts_text:
        frame_types = (*frame_types, TTSTextFrame)
    if not isinstance(frame, frame_types):
        return
    if not state.remember(frame):
        return

    if isinstance(frame, VADUserStartedSpeakingFrame):
        if state.user_turn_open:
            # VAD re-fires whenever someone pauses mid-sentence, and the button
            # is still held, so this is the same utterance. Minting a new item
            # id here started a second bubble in the web app -- one sentence
            # arriving as three, each restarting the first-word timer -- even
            # though the recognizer and the LLM correctly saw one turn.
            return
        state.user_item_id = _new_item_id("user")
        state.user_turn_open = True
        state.mark_user_speech_start()
        logger.info("Forwarding USER.STARTED item_id={}", state.user_item_id)
        await _emit_browser_message(
            processor,
            direction,
            {"type": "server", "msg": "USER.STARTED", "item_id": state.user_item_id},
        )
        return

    if isinstance(frame, UserStartedSpeakingFrame):
        if state.user_turn_open:
            return
        state.user_turn_open = True
        state.user_item_id = _new_item_id("user")
        state.mark_user_speech_start()
        logger.info("Forwarding USER.STARTED item_id={}", state.user_item_id)
        await _emit_browser_message(
            processor,
            direction,
            {"type": "server", "msg": "USER.STARTED", "item_id": state.user_item_id},
        )
        return

    if isinstance(frame, InterimTranscriptionFrame):
        text = frame.text or ""
        if text.strip():
            if state.user_speech_started_at is None:
                state.mark_user_speech_start()
            await _emit_browser_message(
                processor,
                direction,
                _user_transcript_payload(state, frame, final=False),
            )
        return

    if isinstance(frame, TranscriptionFrame):
        text = frame.text or ""
        if text.strip():
            if state.user_speech_started_at is None:
                state.mark_user_speech_start()
            payload = _user_transcript_payload(state, frame, final=True)
            # What the child said is DEBUG only (P1-02, log_setup.py).
            logger.info(
                "Forwarding USER.TRANSCRIPT final chars={} latency_ms={} elapsed_ms={}",
                len(text.strip()),
                payload.get("latency_ms"),
                payload.get("elapsed_ms"),
            )
            logger.debug("USER.TRANSCRIPT text={}", text.strip())
            await _emit_browser_message(processor, direction, payload)
            state.user_turn_open = False
        else:
            logger.warning("Whisper returned an empty transcription")
        return

    if isinstance(frame, LLMFullResponseStartFrame):
        state.bot_item_id = _new_item_id("bot")
        state.emitted_llm_text = False
        return

    if isinstance(frame, LLMTextFrame):
        text = frame.text or ""
        if text:
            state.emitted_llm_text = True
            await _emit_browser_message(
                processor,
                direction,
                {
                    "type": "server",
                    "msg": "BOT.TRANSCRIPT",
                    "item_id": state.ensure_bot_item(),
                    "text": text,
                    "delta": True,
                },
            )
        return

    if include_tts_text and isinstance(frame, TTSTextFrame) and not state.emitted_llm_text:
        text = frame.text or ""
        if text:
            await _emit_browser_message(
                processor,
                direction,
                {
                    "type": "server",
                    "msg": "BOT.TRANSCRIPT",
                    "item_id": state.ensure_bot_item(),
                    "text": text,
                    "delta": True,
                },
            )


class TranscriptForwardProcessor(FrameProcessor):
    """Forward STT and LLM text to the browser as websocket JSON."""

    def __init__(self, state: TranscriptSessionState):
        super().__init__()
        self._state = state

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        await forward_transcript_frame(self, self._state, frame, direction)
        await self.push_frame(frame, direction)


# Silence pushed into STT when a push-to-talk client commits, for recognizers
# that have no explicit "finish now". Azure does (STTFinalizeFrame closes the
# push stream), so its provider declares flush_silence_ms=0 and this loop is
# skipped. Deepgram / Whisper still need the zeros.
#
# How much is a property of the recognizer, so the STT provider declares it
# (models/stt/flush_silence_ms) and the pipeline hands the number over. This is
# only the fallback for a session built without one, and the override knob.
STT_FLUSH_SILENCE_MS = int(os.getenv("STT_FLUSH_SILENCE_MS", "1500"))
_FLUSH_CHUNK_MS = 20


class RealtimeInputControlProcessor(FrameProcessor):
    """Bridge incoming websocket control messages into Pipecat frames."""

    def __init__(self, voice_route: str):
        super().__init__()
        self._voice_route = voice_route
        self._audio_in_sample_rate: int | None = None
        self._flush_silence_ms = STT_FLUSH_SILENCE_MS

    def set_flush_silence_ms(self, milliseconds: int) -> None:
        """Told by the pipeline what this session's recognizer needs."""
        if os.getenv("STT_FLUSH_SILENCE_MS"):
            return  # an explicit override wins over the provider's own number
        self._flush_silence_ms = max(0, int(milliseconds))

    async def _flush_stt_with_silence(self):
        """Give the recognizer the trailing silence the client stopped sending."""
        rate = self._audio_in_sample_rate
        if not rate or self._flush_silence_ms <= 0:
            return
        samples = int(rate * _FLUSH_CHUNK_MS / 1000)
        chunk = b"\x00" * (samples * 2)  # 16-bit mono
        for _ in range(self._flush_silence_ms // _FLUSH_CHUNK_MS):
            await self.push_frame(
                InputAudioRawFrame(audio=chunk, sample_rate=rate, num_channels=1),
                FrameDirection.DOWNSTREAM,
            )

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, StartFrame):
            self._audio_in_sample_rate = frame.audio_in_sample_rate

        if isinstance(frame, InputTransportMessageFrame):
            message = frame.message if isinstance(frame.message, dict) else {}
            msg_type = message.get("type")
            msg = message.get("msg")

            if msg_type == "instruction" and msg == "end_of_speech":
                if self._voice_route == "gem_live":
                    await self.push_frame(VADUserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
                else:
                    # Pipecat 1.7 removed EmulateUserStoppedSpeakingFrame; the
                    # end-of-speech signal now maps to UserStoppedSpeakingFrame.
                    #
                    # No STTMuteFrame(mute=True) follows it. Muting here raced
                    # the recognizer: Azure emits its final transcript a beat
                    # after the audio stops, and a mute that lands first drops
                    # it. The turn then has no transcript, the aggregator never
                    # runs the LLM, and the device sits in PROCESSING until
                    # something else unmutes STT -- which in practice meant the
                    # user pressing interrupt, at which point the answer they
                    # had given up on finally played. Measured on hardware
                    # 2026-09-08: three of four turns died this way.
                    #
                    # Nothing is lost by dropping it. The mute existed to stop
                    # trailing audio reopening the turn, but a push-to-talk
                    # client closes its own mic on release, so no trailing audio
                    # arrives. What the mute did instead, on a turn that
                    # produced no transcript, was latch: the only unmute runs
                    # when a bot turn actually starts, so every later turn died
                    # silently. Both clients now commit the instant the button
                    # comes up instead of holding the mic open for the VAD.
                    #
                    # Order matters: any trailing silence, then the explicit
                    # finalize, then the frame that closes the turn. Azure
                    # handles STTFinalizeFrame by closing its push stream so
                    # the current phrase emits without waiting out the
                    # silence timeout. The aggregator still has to wait for
                    # that transcript; ExternalUserTurnStopStrategy does.
                    await self._flush_stt_with_silence()
                    await self.push_frame(STTFinalizeFrame(), FrameDirection.DOWNSTREAM)
                    await self.push_frame(UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
                return

            if msg_type == "instruction" and msg == "INTERRUPT":
                await self.push_frame(InterruptionFrame(), FrameDirection.DOWNSTREAM)
                if self._voice_route != "gem_live":
                    await self.push_frame(STTMuteFrame(mute=False), FrameDirection.DOWNSTREAM)
                return

        await self.push_frame(frame, direction)


class RealtimeOutputControlProcessor(FrameProcessor):
    """Translate pipeline state changes into the old websocket control protocol."""

    def __init__(
        self,
        transcript_state: TranscriptSessionState | None = None,
        mute_stt_while_speaking: bool = True,
    ):
        super().__init__()
        self._response_started = False
        self._completed_for_turn = False
        self._bot_turn_active = False
        self._user_turn_committed = False
        self._transcript_state = transcript_state
        self._mute_stt_while_speaking = mute_stt_while_speaking

    async def _finish_response(self, reason: str, urgent: bool = False):
        """Unmute STT and emit RESPONSE.COMPLETE at most once per bot turn."""
        if self._completed_for_turn:
            return
        self._completed_for_turn = True
        self._response_started = False
        self._bot_turn_active = False

        bot_item_id = None
        if self._transcript_state is not None:
            bot_item_id = self._transcript_state.bot_item_id
            self._transcript_state.bot_item_id = None
            self._transcript_state.emitted_llm_text = False

        logger.debug("Sending RESPONSE.COMPLETE ({})", reason)
        if self._mute_stt_while_speaking:
            await self.push_frame(STTMuteFrame(mute=False), FrameDirection.UPSTREAM)

        message = {"type": "server", "msg": "RESPONSE.COMPLETE"}
        if bot_item_id:
            message["item_id"] = bot_item_id
        # An interruption flushes the output transport queue, so the completion
        # has to go out urgently or the client never learns the turn ended.
        frame_cls = OutputTransportMessageUrgentFrame if urgent else OutputTransportMessageFrame
        await self.push_frame(frame_cls(message=message), FrameDirection.DOWNSTREAM)

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        # base_output pushes BotStoppedSpeakingFrame UPSTREAM when an interruption
        # kills playback, and that is the only "the bot really stopped" signal we
        # get on that path.
        if direction is FrameDirection.UPSTREAM:
            await self.push_frame(frame, direction)
            if isinstance(frame, BotStoppedSpeakingFrame) and self._bot_turn_active:
                await self._finish_response("bot stopped speaking", urgent=True)
            return

        if self._transcript_state is not None:
            await forward_transcript_frame(
                self,
                self._transcript_state,
                frame,
                direction,
                include_tts_text=True,
            )

        if isinstance(frame, InterruptionFrame):
            # Pipecat broadcasts this on every user turn start, so only treat it
            # as a barge-in when a bot turn is actually in flight. Forward it
            # first so TTS and the output transport flush their audio, then tell
            # the client the turn is over: pipecat does not push a
            # TTSStoppedFrame on interruption, so without this the STT mute
            # below would stay latched and the turn would silently die.
            await self.push_frame(frame, direction)
            if self._bot_turn_active:
                await self._finish_response("interrupted", urgent=True)
            return

        if isinstance(frame, LLMFullResponseStartFrame):
            self._completed_for_turn = False
            self._bot_turn_active = True
        elif isinstance(frame, (UserStartedSpeakingFrame, VADUserStartedSpeakingFrame)):
            self._user_turn_committed = False
        elif isinstance(frame, (UserStoppedSpeakingFrame, VADUserStoppedSpeakingFrame)):
            # A push-to-talk client shuts its mic the instant it sends
            # end_of_speech, and pipecat's VAD forces a stop of its own 1s after
            # audio stops arriving (vad_controller audio_idle_timeout). So every
            # explicit commit is followed by a VAD stop for the same user turn,
            # usually after the answer has already started playing. Emitting a
            # second AUDIO.COMMITTED there drops the ESP32 out of SPEAKING and
            # truncates that answer, so only the first stop of a user turn
            # counts. An explicit commit always counts: a speaker quiet enough
            # that VAD never fired has no started-frame to re-arm on.
            if isinstance(frame, VADUserStoppedSpeakingFrame) and self._user_turn_committed:
                logger.debug("Ignoring VAD stop for a turn the client already committed")
            else:
                self._user_turn_committed = True
                # A new user turn ended, so a new bot turn is on its way: re-arm
                # the completion even if the previous one produced no audio.
                self._completed_for_turn = False
                # Close the display turn on the client's own commit, never on
                # a VAD stop: VAD stops at every mid-sentence pause, and closing
                # there is what made one sentence arrive as three bubbles. The
                # explicit commit covers the press that produced no transcript,
                # which the final-transcript path cannot.
                #
                # Hands-free sends no commit, so there the final transcript is
                # what closes the turn, as before.
                if self._transcript_state is not None and not isinstance(
                    frame, VADUserStoppedSpeakingFrame
                ):
                    self._transcript_state.user_turn_open = False
                await self.push_frame(
                    OutputTransportMessageFrame(
                        message={"type": "server", "msg": "AUDIO.COMMITTED"}
                    ),
                    direction,
                )
        elif isinstance(frame, OutputAudioRawFrame) and not self._response_started:
            self._response_started = True
            self._completed_for_turn = False
            self._bot_turn_active = True
            logger.debug("Sending RESPONSE.CREATED before first audio packet")
            # STT sits upstream of this processor, so mute/unmute has to
            # travel UPSTREAM to reach it. Pushing it downstream made the
            # mute a no-op and left the ESP32 end_of_speech mute latched
            # forever, which silently killed every following turn.
            if self._mute_stt_while_speaking:
                await self.push_frame(STTMuteFrame(mute=True), FrameDirection.UPSTREAM)
            created_message = {"type": "server", "msg": "RESPONSE.CREATED"}
            if self._transcript_state and self._transcript_state.bot_item_id:
                created_message["item_id"] = self._transcript_state.bot_item_id
            await self.push_frame(
                OutputTransportMessageFrame(message=created_message),
                direction,
            )
        elif isinstance(frame, (TTSStoppedFrame, BotStoppedSpeakingFrame)):
            await self.push_frame(frame, direction)
            await self._finish_response("tts stopped")
            return
        elif isinstance(frame, ErrorFrame):
            self._response_started = False
            self._completed_for_turn = True
            self._bot_turn_active = False
            if self._transcript_state is not None:
                self._transcript_state.bot_item_id = None
                self._transcript_state.emitted_llm_text = False
            await self.push_frame(STTMuteFrame(mute=False), FrameDirection.UPSTREAM)
            await self.push_frame(
                OutputTransportMessageFrame(message={"type": "server", "msg": "RESPONSE.ERROR"}),
                direction,
            )

        await self.push_frame(frame, direction)


def create_esp32_auth_message(volume: int | None = None) -> dict:
    """Build the auth frame the device gets on connect.

    `volume` comes from the device's own row when it resolved, so a device can
    be turned up or down from the web app; None keeps the env-level default.
    """
    return {
        "type": "auth",
        "volume_control": (
            volume if volume is not None else int(os.getenv("ESP32_DEFAULT_VOLUME", "100"))
        ),
        "pitch_factor": float(os.getenv("ESP32_DEFAULT_PITCH_FACTOR", "1.0")),
        "is_ota": False,
        "is_reset": False,
    }


async def run_bot_session(
    transport: BaseTransport,
    transport_kind: Literal["browser", "esp32"],
    handle_sigint: bool = False,
    tts_voice: str | None = None,
    tts_voices: dict[str, str] | None = None,
    title: str | None = None,
    character_prompt: str | None = None,
    voice_prompt: str | None = None,
    first_message_prompt: str | None = None,
    memory=None,
    child=None,
    user_id: str | None = None,
    chat_group_id: str | None = None,
    device_id: str | None = None,
    language_code: str | None = None,
    region=None,
    ip=None,
    mode_key: str | None = None,
    style_key: str | None = None,
):
    voice_route = CURRENT_VOICE_ROUTE
    logger.info(f"Starting bot session for {transport_kind} via route={voice_route}")

    # Which model this session runs on is a database read, not an env read, so
    # the admin page can change it without a restart. It is resolved once here,
    # before the pipeline is built, because the model is fixed for the life of
    # a websocket -- exactly like the character prompt beside it.
    #
    # Only the classic route has a model to choose. gem_live and grok build
    # their own single speech-to-speech service and would ignore it, so they do
    # not pay for the lookup.
    #
    # The date, time and weather go into the same system instruction, so they
    # are fetched here too, alongside the settings rather than after them: the
    # weather is a network round trip and the greeting is waiting on both.
    if voice_route == "classic":
        voice_settings, world_context = await asyncio.gather(
            fetch_voice_settings(), fetch_world_block(region)
        )
        stack = resolve_voice_stack(voice_settings)
    else:
        stack = None
        world_context = None

    # gem_live and grok are speech-to-speech: our STT never emits a
    # TranscriptionFrame on those routes and their instructions are fixed when
    # the route is built, so memory would be inert. Better to say so than to
    # wire up something that silently does nothing.
    if memory is not None and voice_route != "classic":
        logger.warning(
            "Long-term memory is only wired into the classic route, not {}", voice_route
        )
        memory = None

    context = LLMContext()
    input_processor = RealtimeInputControlProcessor(voice_route)
    transcript_state = TranscriptSessionState() if transport_kind == "browser" else None
    extra_after_stt = TranscriptForwardProcessor(transcript_state) if transcript_state else None
    extra_after_llm = TranscriptForwardProcessor(transcript_state) if transcript_state else None
    if voice_route == "gem_live":
        route_processors, assistant_aggregator = build_gem_live_route(input_processor, context)
        if extra_after_llm is not None:
            route_processors.append(extra_after_llm)
    elif voice_route == "grok":
        route_processors, assistant_aggregator = build_grok_route(input_processor, context)
        if extra_after_llm is not None:
            route_processors.append(extra_after_llm)
    else:
        route_processors, assistant_aggregator = build_voice_pipeline(
            input_processor,
            context,
            tts_voice=tts_voice,
            tts_voices=tts_voices,
            title=title,
            character_prompt=character_prompt,
            voice_prompt=voice_prompt,
            extra_after_stt=extra_after_stt,
            extra_after_llm=extra_after_llm,
            memory=memory,
            child=child,
            stack=stack,
            language_code=language_code,
            world_context=world_context,
            ip=ip,
            mode_key=mode_key,
            style_key=style_key,
        )

    processors = [transport.input(), *route_processors]

    if transport_kind in {"esp32", "browser"}:
        processors.append(
            RealtimeOutputControlProcessor(
                transcript_state,
                # The browser streams the mic full-duplex with echo cancellation
                # on, so STT has to stay live during playback for barge-in to
                # catch the first word. The ESP32 is half-duplex and still needs
                # the mute to clear its end_of_speech latch.
                mute_stt_while_speaking=transport_kind == "esp32",
            )
        )
    processors.append(transport.output())
    processors.append(assistant_aggregator)

    pipeline = Pipeline(processors)

    # enable_metrics has been on since this pipeline was written; until the
    # observer below there was nothing reading the MetricsFrames it produces.
    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
            audio_in_sample_rate=AUDIO_IN_SAMPLE_RATE,
            audio_out_sample_rate=AUDIO_OUT_SAMPLE_RATE,
        ),
        observers=[
            TurnMetricsObserver(
                user_id=user_id,
                chat_group_id=chat_group_id,
                device_id=device_id,
                transport=transport_kind,
                personality_key=(child or {}).get("personality_key"),
                # Only the classic route is a three-provider stack. gem_live and
                # grok are single speech-to-speech models, so tagging their
                # turns with the classic STT/LLM/TTS names would credit the
                # timings to services that never ran -- and those rows would
                # then pollute the per-model comparison on the admin page. The
                # route name is the honest label there; the end-to-end total is
                # still measured either way, and for a speech-to-speech model
                # that is the only span there is.
                **(
                    {
                        "stt_provider": stack["stt_provider"],
                        "llm_provider": stack["llm_provider"],
                        "tts_provider": stack["tts_provider"],
                        "llm_model": stack["llm_model"],
                    }
                    if stack is not None
                    else {"llm_provider": voice_route}
                ),
            )
        ],
    )

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info(f"{transport_kind} client connected")
        if voice_route in {"gem_live", "grok"}:
            context.add_message(
                {
                    "role": "user",
                    "content": "Say hello and briefly introduce yourself.",
                }
            )
            await task.queue_frames(
                [
                    LLMContextFrame(context=context)
                ]
            )
        else:
            greeting = (
                f"Always start the conversation following these instructions from the user: {first_message_prompt}"
                if first_message_prompt
                else "Say hello and briefly introduce yourself."
            )
            context.add_message(
                {
                    "role": "developer",
                    "content": greeting,
                }
            )
            await task.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info(f"{transport_kind} client disconnected")
        # Memory is released by whoever acquired it, in a finally block, so it
        # still happens when a socket dies without this handler ever firing.
        await task.cancel()

    runner = PipelineRunner(handle_sigint=handle_sigint)
    await runner.run(task)

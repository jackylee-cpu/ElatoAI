#
# Copyright (c) 2024-2026, Daily
#
# SPDX-License-Identifier: BSD 2-Clause License
#

"""Shared Pipecat bot logic for the local multi-transport server."""

from __future__ import annotations

import os
import time
import uuid
from typing import Any, Literal

from voice_pipeline import build_voice_pipeline
from dotenv import load_dotenv
from gem_live_route import build_gem_live_route
from grok_route import build_grok_route
from loguru import logger

logger.info("Loading Silero VAD model...")

logger.info("Silero VAD model loaded")

from pipecat.frames.frames import (
    BotStoppedSpeakingFrame,
    ErrorFrame,
    Frame,
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
    if "latency_ms" not in payload and elapsed_ms is not None:
        payload["latency_ms"] = elapsed_ms
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
            logger.info(
                "Forwarding USER.TRANSCRIPT final text={} latency_ms={} elapsed_ms={}",
                text.strip(),
                payload.get("latency_ms"),
                payload.get("elapsed_ms"),
            )
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


class RealtimeInputControlProcessor(FrameProcessor):
    """Bridge incoming websocket control messages into Pipecat frames."""

    def __init__(self, voice_route: str):
        super().__init__()
        self._voice_route = voice_route

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, InputTransportMessageFrame):
            message = frame.message if isinstance(frame.message, dict) else {}
            msg_type = message.get("type")
            msg = message.get("msg")

            if msg_type == "instruction" and msg == "end_of_speech":
                if self._voice_route == "gem_live":
                    await self.push_frame(VADUserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
                else:
                    # Pipecat 1.7 removed EmulateUserStoppedSpeakingFrame; the
                    # ESP32 end-of-speech signal now maps to UserStoppedSpeakingFrame.
                    await self.push_frame(UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
                    await self.push_frame(STTMuteFrame(mute=True), FrameDirection.DOWNSTREAM)
                return

            if msg_type == "instruction" and msg == "INTERRUPT":
                await self.push_frame(InterruptionFrame(), FrameDirection.DOWNSTREAM)
                if self._voice_route != "gem_live":
                    await self.push_frame(STTMuteFrame(mute=False), FrameDirection.DOWNSTREAM)
                return

        await self.push_frame(frame, direction)


class RealtimeOutputControlProcessor(FrameProcessor):
    """Translate pipeline state changes into the old websocket control protocol."""

    def __init__(self, transcript_state: TranscriptSessionState | None = None):
        super().__init__()
        self._response_started = False
        self._transcript_state = transcript_state

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if direction is FrameDirection.DOWNSTREAM:
            if self._transcript_state is not None:
                await forward_transcript_frame(
                    self,
                    self._transcript_state,
                    frame,
                    direction,
                    include_tts_text=True,
                )

            if isinstance(frame, (UserStoppedSpeakingFrame, VADUserStoppedSpeakingFrame)):
                await self.push_frame(
                    OutputTransportMessageFrame(message={"type": "server", "msg": "AUDIO.COMMITTED"}),
                    direction,
                )
            elif isinstance(frame, OutputAudioRawFrame) and not self._response_started:
                self._response_started = True
                logger.debug("Sending RESPONSE.CREATED before first audio packet")
                # STT sits upstream of this processor, so mute/unmute has to
                # travel UPSTREAM to reach it. Pushing it downstream made the
                # mute a no-op and left the ESP32 end_of_speech mute latched
                # forever, which silently killed every following turn.
                await self.push_frame(STTMuteFrame(mute=True), FrameDirection.UPSTREAM)
                created_message = {"type": "server", "msg": "RESPONSE.CREATED"}
                if self._transcript_state and self._transcript_state.bot_item_id:
                    created_message["item_id"] = self._transcript_state.bot_item_id
                await self.push_frame(
                    OutputTransportMessageFrame(message=created_message),
                    direction,
                )
            elif isinstance(frame, (TTSStoppedFrame, BotStoppedSpeakingFrame)):
                self._response_started = False
                bot_item_id = None
                if self._transcript_state is not None:
                    bot_item_id = self._transcript_state.bot_item_id
                    self._transcript_state.bot_item_id = None
                    self._transcript_state.emitted_llm_text = False
                logger.debug("Sending RESPONSE.COMPLETE after TTS stop")
                await self.push_frame(STTMuteFrame(mute=False), FrameDirection.UPSTREAM)
                await self.push_frame(frame, direction)
                complete_message = {"type": "server", "msg": "RESPONSE.COMPLETE"}
                if bot_item_id:
                    complete_message["item_id"] = bot_item_id
                await self.push_frame(
                    OutputTransportMessageFrame(message=complete_message),
                    direction,
                )
                return
            elif isinstance(frame, ErrorFrame):
                self._response_started = False
                if self._transcript_state is not None:
                    self._transcript_state.bot_item_id = None
                    self._transcript_state.emitted_llm_text = False
                await self.push_frame(STTMuteFrame(mute=False), FrameDirection.UPSTREAM)
                await self.push_frame(
                    OutputTransportMessageFrame(message={"type": "server", "msg": "RESPONSE.ERROR"}),
                    direction,
                )

        await self.push_frame(frame, direction)


def create_esp32_auth_message() -> dict:
    return {
        "type": "auth",
        "volume_control": int(os.getenv("ESP32_DEFAULT_VOLUME", "100")),
        "pitch_factor": float(os.getenv("ESP32_DEFAULT_PITCH_FACTOR", "1.0")),
        "is_ota": False,
        "is_reset": False,
    }


async def run_bot_session(
    transport: BaseTransport,
    transport_kind: Literal["browser", "esp32"],
    handle_sigint: bool = False,
    tts_voice: str | None = None,
    title: str | None = None,
    character_prompt: str | None = None,
    voice_prompt: str | None = None,
    first_message_prompt: str | None = None,
):
    voice_route = CURRENT_VOICE_ROUTE
    logger.info(f"Starting bot session for {transport_kind} via route={voice_route}")

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
            title=title,
            character_prompt=character_prompt,
            voice_prompt=voice_prompt,
            extra_after_stt=extra_after_stt,
            extra_after_llm=extra_after_llm,
        )

    processors = [transport.input(), *route_processors]

    if transport_kind in {"esp32", "browser"}:
        processors.append(RealtimeOutputControlProcessor(transcript_state))
    processors.append(transport.output())
    processors.append(assistant_aggregator)

    pipeline = Pipeline(processors)

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
            audio_in_sample_rate=AUDIO_IN_SAMPLE_RATE,
            audio_out_sample_rate=AUDIO_OUT_SAMPLE_RATE,
        ),
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
        await task.cancel()

    runner = PipelineRunner(handle_sigint=handle_sigint)
    await runner.run(task)

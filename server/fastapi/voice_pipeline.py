"""Default STT -> LLM -> TTS voice pipeline builder."""

from __future__ import annotations

import os

from character_prompt import build_session_prompt
from loguru import logger
from models.llm import create_llm_service
from models.stt import create_stt_service
from models.tts import create_tts_service
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
)
from pipecat.processors.audio.vad_processor import VADProcessor


def build_voice_pipeline(
    input_processor,
    context: LLMContext,
    tts_voice: str | None = None,
    title: str | None = None,
    character_prompt: str | None = None,
    voice_prompt: str | None = None,
    extra_after_stt=None,
    extra_after_llm=None,
):
    stt_provider = os.getenv("CLASSIC_STT_PROVIDER", "deepgram")
    llm_provider = os.getenv("CLASSIC_LLM_PROVIDER", "openai")
    tts_provider = os.getenv("CLASSIC_TTS_PROVIDER", "elevenlabs")
    system_instruction = build_session_prompt(
        title=title,
        character_prompt=character_prompt,
        voice_prompt=voice_prompt,
    )

    logger.info(
        "Building classic route with stt={} llm={} tts={} voice={} character={}",
        stt_provider,
        llm_provider,
        tts_provider,
        tts_voice or "default",
        title or "default",
    )

    stt = create_stt_service(stt_provider)
    llm = create_llm_service(
        llm_provider,
        system_instruction=system_instruction,
    )
    tts_kwargs = {}
    if tts_voice:
        tts_kwargs["voice"] = tts_voice
        lowered = tts_voice.lower()
        if "chinese" in lowered or "mandarin" in lowered:
            tts_kwargs["language"] = "zh"
    tts = create_tts_service(tts_provider, **tts_kwargs)

    # Whisper is a segmented STT: it only transcribes after VAD start/stop.
    # Streaming STT (Azure) can finalize on a shorter silence for lower latency.
    stt_name = stt_provider.strip().lower()
    stop_secs = 0.35 if stt_name in {"azure", "azure_speech", "azure_stt"} else 0.8
    vad = VADProcessor(
        vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=stop_secs)),
    )
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(context)

    processors = [input_processor, vad, stt]
    if extra_after_stt is not None:
        processors.append(extra_after_stt)
    processors.extend([user_aggregator, llm])
    if extra_after_llm is not None:
        processors.append(extra_after_llm)
    processors.append(tts)

    return processors, assistant_aggregator

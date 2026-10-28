"""Default STT -> LLM -> TTS voice pipeline builder."""

from __future__ import annotations

import os

import language_profiles
import session_content
from character_prompt import build_session_prompt
from llm_output_guard import LLMOutputGuard
from loguru import logger
from models.llm import create_llm_service
from models.stt import create_stt_service, flush_silence_ms
from models.tts import create_tts_service
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.turns.user_stop import ExternalUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import (
    UserTurnStrategies,
    default_user_turn_start_strategies,
    default_user_turn_stop_strategies,
)

# After an explicit commit, wait this long for a trailing Azure fragment
# before closing the turn. Pipecat's default is 0.5s, a flat tax on every
# push-to-talk turn (measured 2026-09-10). 80ms is enough to catch a
# punctuation revision, not another sentence. Hands-free is unaffected:
# UserTurnController ignores this strategy until VAD stop or the client's
# UserStoppedSpeakingFrame, so a short timer cannot close a held utterance.
PTT_TRANSCRIPT_MERGE_SECS = 0.08


def build_user_turn_strategies() -> UserTurnStrategies:
    """Turn strategies for a pipeline serving both push-to-talk and open-mic clients."""
    # A push-to-talk client closes its own turn: the button comes up, the client
    # sends `end_of_speech`, and bot.py turns that into a
    # UserStoppedSpeakingFrame. Pipecat's default stop strategy is the smart-turn
    # analyzer, which decides the turn is over by looking at the audio that
    # *follows* the speech -- audio a push-to-talk client stops sending the
    # instant it commits. It therefore never closes a PTT turn on its own: it
    # reports EndOfTurnState.INCOMPLETE and the turn limps shut on a five second
    # timeout instead, or not at all. ExternalUserTurnStopStrategy is the
    # strategy that listens for that explicit frame.
    #
    # The default is kept alongside it so an open-mic client (the web app's
    # hands-free mode) still gets its turns closed for it; strategies are
    # evaluated in order and this one always returns CONTINUE, so the analyzer
    # keeps seeing every frame. Turn *start* is left on VAD, which works for
    # both kinds of client.
    #
    # No guard is needed against this strategy closing a turn early (say, on a
    # final transcript while the button is still held): UserTurnController
    # refuses to finalize while its own _user_speaking is set, and only a VAD
    # stop or the client's explicit frame clears that.
    return UserTurnStrategies(
        start=default_user_turn_start_strategies(),
        stop=[
            ExternalUserTurnStopStrategy(timeout=PTT_TRANSCRIPT_MERGE_SECS),
            *default_user_turn_stop_strategies(),
        ],
    )


def resolve_voice_stack(settings: dict | None = None) -> dict:
    """Which providers and which model this session will actually run on.

    Settings from the `app_settings` row win over the environment, which wins
    over whatever the provider defaults to on its own. Anything absent from the
    row means "leave it as the server was started with", so a deployment that
    never touches the admin page behaves exactly as it did before.

    Also used to tag every turn_metrics row, so the numbers on the admin page
    say which model produced them.
    """
    settings = settings or {}
    stt_provider = os.getenv("CLASSIC_STT_PROVIDER", "deepgram")
    llm_provider = os.getenv("CLASSIC_LLM_PROVIDER", "openai")
    tts_provider = os.getenv("CLASSIC_TTS_PROVIDER", "elevenlabs")

    llm_model = settings.get("llm_model")
    if not llm_model and llm_provider.strip().lower() in {"openrouter", "open_router"}:
        # OpenRouter is the one provider in this stack that names its model in
        # the environment (models/llm/openrouter.py). For the rest the model is
        # whatever pipecat's service class defaults to, and there is no env var
        # to read it back out of -- so an untouched setting leaves the tag
        # empty rather than guessing.
        llm_model = os.getenv("OPENROUTER_MODEL") or "openai/gpt-4o-mini"

    return {
        "stt_provider": stt_provider,
        "llm_provider": llm_provider,
        "tts_provider": tts_provider,
        "llm_model": llm_model,
        "provider_sort": settings.get("provider_sort"),
        "provider_order": settings.get("provider_order"),
        "reasoning_effort": settings.get("reasoning_effort"),
    }


def build_voice_pipeline(
    input_processor,
    context: LLMContext,
    tts_voice: str | None = None,
    tts_voices: dict[str, str] | None = None,
    tts_speed: float | None = None,
    title: str | None = None,
    character_prompt: str | None = None,
    extra_after_stt=None,
    extra_after_llm=None,
    memory=None,
    child=None,
    stack: dict | None = None,
    language_code: str | None = None,
    world_context: str | None = None,
    ip=None,
    mode_key: str | None = None,
    style_key: str | None = None,
):
    # `stack` is resolved by the caller because reading it needs an await and
    # this function is synchronous. Falling back to the env-only stack keeps
    # every existing caller (and every test) working unchanged.
    stack = stack or resolve_voice_stack()
    stt_provider = stack["stt_provider"]
    llm_provider = stack["llm_provider"]
    tts_provider = stack["tts_provider"]
    child = child or {}

    # One decision drives the recognizer, the voice and the system prompt. An
    # account on a language with no profile resolves to None, which leaves all
    # three exactly where the env vars put them. See language_profiles.py.
    language = language_profiles.resolve(language_code)

    # The system-prompt half of long-term memory: who the child is (facts) and
    # what the last sessions ended on (the brief). `memory_preamble` had been
    # an unused hook in build_session_prompt since it was written, and this is
    # the thing it was for.
    #
    # It goes in the system instruction rather than a per-turn message because
    # the greeting is queued on connect, before the child has said a word --
    # the one turn no retrieval can serve, and the turn where being remembered
    # is most obvious.
    memory_preamble = child.get("memory_preamble")
    if memory is not None:
        preamble = memory.prompt_preamble()
        if preamble:
            memory_preamble = preamble
            logger.info(
                "Opened the session with {} fact(s) and {} chars of memory",
                len(memory.facts),
                len(preamble),
            )

    # An IP that could not be read shapes the prompt as an in-house one would:
    # nothing restricted, no guardrails. Memory is already off for it (see
    # memory.session.acquire), which is the part that must not guess.
    rules = ip or session_content.DEFAULT_IP
    system_instruction = build_session_prompt(
        title=title,
        character_prompt=character_prompt,
        child_name=child.get("name"),
        child_age=child.get("age"),
        child_persona=child.get("persona"),
        memory_preamble=memory_preamble,
        language_instruction=language.prompt if language else None,
        world_context=world_context,
        style_block=session_content.style_block(style_key, rules),
        mode_block=session_content.mode_block(mode_key, rules),
        guardrails_block=session_content.guardrails_block(rules),
    )

    # The voice is part of the language, not a free choice beside it: a MiniMax
    # voice id speaks exactly one language. `voice_for` keeps the character's
    # own voice when it can say these words -- including a per-language id
    # from `tts_voices` -- and substitutes the language's otherwise, so a
    # Cantonese session never runs an English voice id.
    session_voice = (
        language_profiles.voice_for(language, tts_voice, tts_voices)
        if language
        else tts_voice
    )

    logger.info(
        "Building classic route with stt={} llm={} tts={} model={} reasoning={} "
        "language={} voice={} character={} ip={} mode={} style={}",
        stt_provider,
        llm_provider,
        tts_provider,
        stack["llm_model"] or "provider default",
        stack.get("reasoning_effort") or "model default",
        language.label if language else (language_code or "provider default"),
        session_voice or "default",
        title or "default",
        ip.ip_key if ip else "unknown",
        mode_key or "none",
        style_key or "none",
    )
    if language:
        intended = language_profiles.intended_voice(
            language, tts_voice, tts_voices
        )
        if intended and session_voice != intended:
            logger.info(
                "Character voice {} cannot speak {}, using {} instead",
                intended,
                language.label,
                session_voice,
            )

    stt_kwargs = {"language": language.stt_language} if language else {}
    stt = create_stt_service(stt_provider, **stt_kwargs)
    # Azure force-finalizes on commit (flush_silence_ms=0). Other recognizers
    # still need trailing silence written in; see models/stt/azure.py.
    input_processor.set_flush_silence_ms(flush_silence_ms(stt_provider))
    # Only pass what was actually chosen. models/_unsupported.py forwards
    # `model` straight into the service's Settings, so handing it None would
    # overwrite the provider's own default with nothing.
    llm_kwargs = {"system_instruction": system_instruction}
    if stack["llm_model"]:
        llm_kwargs["model"] = stack["llm_model"]
    if stack["provider_sort"]:
        llm_kwargs["provider_sort"] = stack["provider_sort"]
    if stack.get("provider_order"):
        llm_kwargs["provider_order"] = stack["provider_order"]
    if stack.get("reasoning_effort"):
        llm_kwargs["reasoning_effort"] = stack["reasoning_effort"]
    llm = create_llm_service(llm_provider, **llm_kwargs)
    tts_kwargs = {}
    if session_voice:
        tts_kwargs["voice"] = session_voice
    if language:
        tts_kwargs["language"] = language.tts_language
    # MiniMax only: the other providers are autodiscovered Pipecat services
    # (models/_unsupported.py), and a `speed` they do not take would fail
    # their constructor rather than be ignored.
    if tts_speed is not None and tts_provider == "minimax":
        tts_kwargs["speed"] = tts_speed
    tts = create_tts_service(tts_provider, **tts_kwargs)

    # Whisper is a segmented STT: it only transcribes after VAD start/stop.
    # Streaming STT (Azure) can finalize on a shorter silence for lower latency,
    # but the VAD stop must stay above Azure's phrase segmentation timeout —
    # otherwise one sentence turns into several user turns.
    stt_name = stt_provider.strip().lower()
    stop_secs = 0.6 if stt_name in {"azure", "azure_speech", "azure_stt"} else 0.8
    vad = VADProcessor(
        vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=stop_secs)),
    )
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(user_turn_strategies=build_user_turn_strategies()),
    )

    # Straight after the LLM, so control tokens a host leaks never reach memory,
    # the transcript or TTS. See llm_output_guard.py.
    guard = LLMOutputGuard(stack["llm_model"])

    processors = [input_processor, vad, stt]
    if extra_after_stt is not None:
        processors.append(extra_after_stt)

    # Long-term memory sits between STT and the aggregator so it sees the final
    # transcript before the LLM runs: that is where the history window is
    # trimmed and the running summary refreshed. Neither processor ever holds a
    # frame -- see memory/processors.py.
    if memory is not None:
        from memory.processors import (
            AssistantTurnCaptureProcessor,
            MemoryProcessor,
            UserTurnRelay,
        )

        # The aggregator between these two consumes TranscriptionFrame, so the
        # child's line cannot reach the capture processor as a frame. The relay
        # carries it across.
        relay = UserTurnRelay()
        processors.append(MemoryProcessor(memory, context, relay))
        processors.extend([user_aggregator, llm, guard])
        processors.append(
            AssistantTurnCaptureProcessor(memory, child.get("personality_key"), relay)
        )
    else:
        processors.extend([user_aggregator, llm, guard])

    if extra_after_llm is not None:
        processors.append(extra_after_llm)
    processors.append(tts)

    return processors, assistant_aggregator

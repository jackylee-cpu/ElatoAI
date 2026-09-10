"""Azure Speech STT provider."""

from __future__ import annotations

import inspect
import os

from loguru import logger
from pipecat.services.azure.stt import AzureSTTService
from pipecat.transcriptions.language import Language

_LANGUAGE_ALIASES = {
    "AUTO": None,
    "CHINESE": "ZH_CN",
    "MANDARIN": "ZH_CN",
    "ZH": "ZH_CN",
    "ZH_CN": "ZH_CN",
    "ZH_TW": "ZH_TW",
    "CANTONESE": "ZH_HK",
    "YUE": "ZH_HK",
    "ENGLISH": "EN_US",
    "EN": "EN_US",
}

_VALID_PROFANITY = {"raw", "masked", "removed"}


def _parse_language(value: str | None):
    if not value:
        return Language.ZH_CN
    token = value.strip().replace("-", "_").replace(" ", "_").upper()
    if not token or token == "AUTO":
        return Language.ZH_CN
    attr = _LANGUAGE_ALIASES.get(token, token)
    if attr is None:
        return Language.ZH_CN
    return getattr(Language, attr, Language.ZH_CN)


def _parse_profanity(value: str | None):
    if not value:
        # Azure's default "masked" filter over-eagerly censors non-English speech.
        return "raw"
    token = value.strip().lower()
    if token not in _VALID_PROFANITY:
        raise RuntimeError(
            "AZURE_SPEECH_PROFANITY must be one of: raw, masked, removed"
        )
    return token


def _settings(**values):
    params = inspect.signature(AzureSTTService.Settings).parameters
    return AzureSTTService.Settings(
        **{key: value for key, value in values.items() if value is not None and key in params}
    )


def create_service(**kwargs):
    api_key = kwargs.get("api_key") or os.getenv("AZURE_SPEECH_API_KEY")
    region = kwargs.get("region") or os.getenv("AZURE_SPEECH_REGION")
    private_endpoint = kwargs.get("private_endpoint") or os.getenv(
        "AZURE_SPEECH_PRIVATE_ENDPOINT"
    )
    if not api_key:
        raise RuntimeError("Azure STT requires AZURE_SPEECH_API_KEY")
    if not region and not private_endpoint:
        raise RuntimeError(
            "Azure STT requires AZURE_SPEECH_REGION or AZURE_SPEECH_PRIVATE_ENDPOINT"
        )

    language = _parse_language(
        kwargs.get("language") or os.getenv("AZURE_SPEECH_LANGUAGE") or "zh-CN"
    )
    logger.info(
        "Creating Azure STT region={} language={} private_endpoint={}",
        region or "none",
        language,
        bool(private_endpoint),
    )

    init_kwargs = {
        "api_key": api_key,
        "settings": _settings(
            language=language,
            profanity=_parse_profanity(
                kwargs.get("profanity") or os.getenv("AZURE_SPEECH_PROFANITY")
            ),
        ),
    }
    if region:
        init_kwargs["region"] = region
    if private_endpoint:
        init_kwargs["private_endpoint"] = private_endpoint
    endpoint_id = kwargs.get("endpoint_id") or os.getenv("AZURE_SPEECH_ENDPOINT_ID")
    if endpoint_id:
        init_kwargs["endpoint_id"] = endpoint_id

    return _tune_low_latency(AzureSTTService(**init_kwargs))


# Azure finalizes a phrase after this much trailing silence. A push-to-talk
# client stops sending audio the moment it commits, so this silence is written
# for it (bot.py) -- which means the number is paid, in full, on every turn.
#
# 2000 is deliberately far above what transcription needs, and lowering it is
# not the free win it looks like. Azure's endpointer runs on *stream* time, so a
# short timeout finalizes a phrase in the middle of the utterance, seconds
# before the child lets go of the button. Measured 2026-09-10 against the live
# recogniser on a sentence with a 700ms thinking pause, at a 500ms timeout:
#
#     fragment at commit -4215ms   我最喜歡的動物是。
#     fragment at commit   +387ms   小熊貓，因為他們又懶又可愛。
#
# Every word is still recoverable, but nothing in the pipeline waits 4.6s to
# collect them: ExternalUserTurnStopStrategy closes the turn 500ms after the
# first fragment, which is while the child is still talking. The result is two
# user turns, two LLM requests and two answers on top of each other -- observed
# in a real session 2026-09-10 after exactly this change, and reverted.
#
# So the ~600ms this costs on every turn is not buyable by tuning this number.
# It needs a stop strategy that refuses to close a push-to-talk turn until the
# commit has arrived, and only then waits a short merge window. Until that
# exists and is validated in the real pipeline, this stays where it is.
_DEFAULT_SILENCE_MS = 2000
_MIN_SILENCE_MS = 300


def _silence_timeout_ms() -> str:
    raw = os.getenv("AZURE_SPEECH_SILENCE_MS", str(_DEFAULT_SILENCE_MS))
    try:
        value = int(raw)
    except ValueError:
        value = _DEFAULT_SILENCE_MS
    if value < _MIN_SILENCE_MS:
        logger.warning(
            "AZURE_SPEECH_SILENCE_MS={} is too low and fragments utterances; using {}",
            value,
            _MIN_SILENCE_MS,
        )
    return str(max(_MIN_SILENCE_MS, min(value, 5000)))


# How much further past its own timeout Azure has to be pushed before it will
# emit a final result. Measured 2026-09-08 with the timeout at 600ms: 800ms of
# trailing silence produced nothing and 1200ms produced the final, so the
# property is not honoured to the millisecond. The margin is free -- the flush is
# written to the stream as fast as the queue takes it, and the Silero VAD it
# passes through on the way costs 18ms for 2.9s of silence (measured
# 2026-09-10) -- and being under the real threshold costs the whole turn.
_FLUSH_MARGIN_MS = 900


def flush_silence_ms() -> int:
    """Trailing silence that reliably ends a phrase, for push-to-talk commits."""
    return int(_silence_timeout_ms()) + _FLUSH_MARGIN_MS


def _tune_low_latency(service: AzureSTTService) -> AzureSTTService:
    """Favor first-partial speed over Azure's default phrase buffering."""
    from azure.cognitiveservices.speech import PropertyId

    cfg = service._speech_config
    silence_ms = _silence_timeout_ms()
    # Do not set SpeechServiceConnection_RecoMode=INTERACTIVE: Pipecat uses
    # continuous recognition, which requires CONVERSATION mode. Forcing
    # INTERACTIVE raises SPXERR_SWITCH_MODE_NOT_ALLOWED at start.
    properties = {
        "Speech_SegmentationStrategy": "Time",
        "Speech_SegmentationSilenceTimeoutMs": silence_ms,
        "SpeechServiceResponse_StablePartialResultThreshold": "1",
    }
    for name, value in properties.items():
        prop = getattr(PropertyId, name, None)
        if prop is None:
            continue
        try:
            cfg.set_property(prop, value)
        except Exception as exc:
            logger.warning("Azure STT could not set {}: {}", name, exc)

    logger.info("Azure STT low-latency silence_ms={}", silence_ms)
    return service

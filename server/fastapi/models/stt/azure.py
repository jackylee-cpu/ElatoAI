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


# Azure finalizes a phrase after this much trailing silence. Mandarin has
# frequent sub-300ms gaps between words, so anything shorter chops a single
# sentence into several "recognized" events (and several LLM turns).
#
# 2000, not the 600 this started at: both clients are push-to-talk and say
# explicitly when a turn is over, so Azure's own endpointing only ever needs to
# be slow enough to stay out of the way. At 600 a child pausing mid-sentence to
# think of a word ("hello hello 我叫 ... GIXIE") had the sentence cut in two,
# answered twice, and the second half treated as a new turn -- reproduced with a
# 700ms pause. Nothing is lost by waiting: RealtimeInputControlProcessor flushes
# the recognizer the moment the button comes up.
#
# The cost lands on hands-free mode, where no commit arrives and this timeout is
# what ends a phrase, so a reply there now waits ~1.4s longer. Push-to-talk is
# the default on both clients, so that is the right way round.
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
# written to the stream as fast as the queue takes it -- and being under the
# real threshold costs the whole turn.
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

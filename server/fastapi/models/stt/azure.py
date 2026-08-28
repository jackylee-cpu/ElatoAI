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


def _silence_timeout_ms() -> str:
    raw = os.getenv("AZURE_SPEECH_SILENCE_MS", "200")
    try:
        value = int(raw)
    except ValueError:
        value = 200
    return str(max(100, min(value, 5000)))


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
        "Speech_StartEventSensitivity": "high",
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

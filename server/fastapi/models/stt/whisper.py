"""Local Whisper STT provider."""

from __future__ import annotations

import inspect
import os

from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.transcriptions.language import Language

_LANGUAGE_ALIASES = {
    "AUTO": None,
    "CHINESE": "ZH",
    "MANDARIN": "ZH",
    "ZH_CN": "ZH",
    "ZH_TW": "ZH",
    "CANTONESE": "YUE",
    "ENGLISH": "EN",
}


def _parse_language(value: str | None):
    if not value:
        return Language.ZH
    token = value.strip().replace("-", "_").replace(" ", "_").upper()
    if not token or token == "AUTO":
        return None
    attr = _LANGUAGE_ALIASES.get(token, token)
    if attr is None:
        return None
    return getattr(Language, attr, Language.ZH)


def _settings(**values):
    params = inspect.signature(WhisperSTTService.Settings).parameters
    return WhisperSTTService.Settings(
        **{key: value for key, value in values.items() if value is not None and key in params}
    )


def create_service(**kwargs):
    # Pipecat's default Whisper model is English-only (distil-medium.en).
    # Chinese sessions should use a multilingual checkpoint.
    model = kwargs.get("model") or os.getenv("WHISPER_MODEL") or "small"
    language = _parse_language(kwargs.get("language") or os.getenv("WHISPER_LANGUAGE") or "zh")
    from loguru import logger

    logger.info("Creating Whisper STT model={} language={}", model, language)
    return WhisperSTTService(
        settings=_settings(
            model=model,
            language=language,
        )
    )

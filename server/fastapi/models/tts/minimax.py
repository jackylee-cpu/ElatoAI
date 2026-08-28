"""MiniMax TTS provider."""

from __future__ import annotations

import inspect
import os

import aiohttp
from pipecat.services.minimax.tts import MiniMaxHttpTTSService
from pipecat.transcriptions.language import Language

_http_session: aiohttp.ClientSession | None = None

_LANGUAGE_ALIASES = {
    "CHINESE": "ZH",
    "MANDARIN": "ZH",
    "ZH_CN": "ZH",
    "ZH_TW": "ZH",
    "CANTONESE": "YUE",
    "ENGLISH": "EN",
}


def _get_http_session() -> aiohttp.ClientSession:
    global _http_session
    if _http_session is None or _http_session.closed:
        _http_session = aiohttp.ClientSession()
    return _http_session


def _parse_language(value: str | None):
    if not value:
        return None
    token = value.strip().replace("-", "_").replace(" ", "_").upper()
    if not token:
        return None
    attr = _LANGUAGE_ALIASES.get(token, token)
    return getattr(Language, attr, None)


def _settings(**values):
    params = inspect.signature(MiniMaxHttpTTSService.Settings).parameters
    return MiniMaxHttpTTSService.Settings(
        **{key: value for key, value in values.items() if value is not None and key in params}
    )


def create_service(**kwargs):
    api_key = kwargs.get("api_key") or os.getenv("MINIMAX_API_KEY")
    group_id = kwargs.get("group_id") or os.getenv("MINIMAX_GROUP_ID")
    if not api_key:
        raise RuntimeError("MiniMax TTS requires MINIMAX_API_KEY")
    if not group_id:
        raise RuntimeError(
            "MiniMax TTS requires MINIMAX_GROUP_ID from the same MiniMax console as the API key"
        )

    init_kwargs = {
        "api_key": api_key,
        "group_id": group_id,
        "aiohttp_session": kwargs.get("aiohttp_session") or _get_http_session(),
        "settings": _settings(
            model=kwargs.get("model") or os.getenv("MINIMAX_TTS_MODEL") or "speech-2.6-turbo",
            voice=kwargs.get("voice") or os.getenv("MINIMAX_VOICE") or "Calm_Woman",
            language=_parse_language(kwargs.get("language") or os.getenv("MINIMAX_LANGUAGE")),
            emotion=kwargs.get("emotion") or os.getenv("MINIMAX_EMOTION"),
        ),
    }
    base_url = kwargs.get("base_url") or os.getenv("MINIMAX_BASE_URL")
    if base_url:
        init_kwargs["base_url"] = base_url

    return MiniMaxHttpTTSService(**init_kwargs)

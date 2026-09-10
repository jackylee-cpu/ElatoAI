"""MiniMax TTS provider."""

from __future__ import annotations

import inspect
import json
import os

import aiohttp
from collections.abc import AsyncGenerator
from loguru import logger
from pipecat.frames.frames import ErrorFrame, Frame, TTSAudioRawFrame
from pipecat.services.minimax.tts import MiniMaxHttpTTSService
from pipecat.transcriptions.language import Language
from pipecat.utils.tracing.service_decorators import traced_tts

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


# How much audio goes into one TTSAudioRawFrame. The base class offers
# `chunk_size` (half a second) for this, but that number exists to answer a
# different question -- how much a chunking service should download before it
# starts pushing -- and this service no longer waits on a byte count at all.
# A tenth of a second is small enough that the first frame reaches the
# transport promptly and an interruption can cut in between frames, and large
# enough not to drown the pipeline in frames.
_FRAME_SECONDS = 0.1


class _LowLatencyMiniMaxTTSService(MiniMaxHttpTTSService):
    """MiniMax TTS that releases each audio block the moment it lands.

    Upstream's `run_tts` reads the SSE body with `iter_chunked(chunk_size)` --
    24000 bytes at 24kHz -- and then refuses to emit a `data:` block until a
    *second* `data:` marker has arrived in the buffer to delimit it. So the
    first audio waits both on a byte count and on the block after it, neither
    of which the listener is waiting for.

    Measured 2026-09-10, replaying each captured response's byte-arrival
    timeline through both parsers so the two are paired and share the run's
    network noise (n=12, api.minimax.io): the listener hears the first speech
    sample a median of 22ms sooner, better in 8 runs of 12, spread +0..+1087ms.
    This parser cannot by construction release a block later than upstream's,
    which is why no run goes negative -- so the shape of the win is a trimmed
    tail rather than a moved median. Do not quote a headline number from
    unpaired medians; the run-to-run spread is far wider than the effect.

    Two things this deliberately does not do, both measured and both rejected:

    - `exclude_aggregated_audio` in the payload. MiniMax's final block repeats
      the whole synthesis (measured: 212.8KB streamed, 212.8KB repeated), and
      the flag is documented to suppress it, but the endpoint ignores it in
      every position tried -- top level and inside `audio_setting`, on
      speech-2.6-turbo and speech-02-turbo. The block arrives last and is
      discarded here, so it costs bandwidth rather than latency.

    - Trimming the ~280-370ms of leading silence MiniMax puts in front of
      every synthesis. It looks free and is not: dropping it means waiting for
      the block that carries the first speech sample, which arrives later than
      the silence saves. Paired over the same 12 runs the trim is worth a
      median of 0ms and wins 4 times of 12, spread -762..+324ms -- it trades
      one wait for another and buys nothing.
    """

    @traced_tts
    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        """Generate TTS audio, pushing each SSE audio block as soon as it completes.

        Args:
            text: The text to synthesize into speech.
            context_id: The context ID for tracking audio frames.

        Yields:
            Frame: Audio frames containing the synthesized speech.
        """
        headers = {
            "accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._api_key}",
        }

        # Mirrors the payload built by MiniMaxHttpTTSService.run_tts. It is not
        # factored out upstream, so it is duplicated here; keep the two in step
        # when pipecat's settings change.
        voice_setting = {
            "voice_id": self._settings.voice,
            "speed": self._settings.speed,
            "vol": self._settings.volume,
            "pitch": self._settings.pitch,
        }
        if self._settings.emotion is not None:
            voice_setting["emotion"] = self._settings.emotion
        if self._settings.text_normalization is not None:
            voice_setting["text_normalization"] = self._settings.text_normalization
        if self._settings.latex_read is not None:
            voice_setting["latex_read"] = self._settings.latex_read

        payload = {
            "stream": True,
            "voice_setting": voice_setting,
            "audio_setting": {
                "bitrate": self._audio_bitrate,
                "format": self._audio_format,
                "channel": self._audio_channel,
                "sample_rate": self._audio_sample_rate,
            },
            "model": self._settings.model,
            "text": text,
        }
        if self._settings.language_boost is not None:
            payload["language_boost"] = self._settings.language_boost

        frame_bytes = max(2, int(self.sample_rate * _FRAME_SECONDS) * 2)

        try:
            async with self._session.post(
                self._base_url, headers=headers, json=payload
            ) as response:
                if response.status != 200:
                    body = (await response.text())[:200]
                    yield ErrorFrame(error=f"MiniMax TTS error: HTTP {response.status} {body}")
                    return

                await self.start_tts_usage_metrics(text)

                # Read raw and split on newlines rather than iterating
                # `response.content` by line: aiohttp's readline caps a line at
                # 512KB and MiniMax's final block runs past that on a long
                # utterance (measured 425.9KB for a 4.6s one), which raises
                # LineTooLong mid-stream.
                buffer = bytearray()
                async for part in response.content.iter_any():
                    buffer.extend(part)
                    while True:
                        newline = buffer.find(b"\n")
                        if newline == -1:
                            break
                        line = bytes(buffer[:newline])
                        del buffer[: newline + 1]
                        for audio in self._audio_from_sse_line(line, frame_bytes):
                            await self.stop_ttfb_metrics()
                            yield TTSAudioRawFrame(
                                audio=audio,
                                sample_rate=self.sample_rate,
                                num_channels=1,
                                context_id=context_id,
                            )
                # A body that does not end in a newline leaves one block behind.
                for audio in self._audio_from_sse_line(bytes(buffer), frame_bytes):
                    await self.stop_ttfb_metrics()
                    yield TTSAudioRawFrame(
                        audio=audio,
                        sample_rate=self.sample_rate,
                        num_channels=1,
                        context_id=context_id,
                    )

        except Exception as exc:  # noqa: BLE001 - matches upstream's contract
            yield ErrorFrame(error=f"Unknown error occurred: {exc}", exception=exc)
        finally:
            await self.stop_ttfb_metrics()

    def _audio_from_sse_line(self, line: bytes, frame_bytes: int):
        """Decode one `data:` line into audio chunks, or nothing at all."""
        line = line.strip()
        if not line.startswith(b"data:"):
            return
        try:
            data = json.loads(line[5:].decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            logger.error("MiniMax TTS could not decode an SSE block: {}", exc)
            return
        # The last block repeats the entire synthesis alongside its extra_info.
        if "extra_info" in data:
            return
        audio_hex = (data.get("data") or {}).get("audio")
        if not audio_hex:
            return
        try:
            audio = bytes.fromhex(audio_hex)
        except ValueError as exc:
            logger.error("MiniMax TTS returned audio that is not hex: {}", exc)
            return
        for start in range(0, len(audio), frame_bytes):
            chunk = audio[start : start + frame_bytes]
            if chunk:
                yield chunk


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

    return _LowLatencyMiniMaxTTSService(**init_kwargs)

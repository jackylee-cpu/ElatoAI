"""MiniMax TTS provider."""

from __future__ import annotations

import inspect
import json
import os

import asyncio
from collections.abc import AsyncGenerator
from urllib.parse import urlparse

import aiohttp
from loguru import logger
from pipecat.frames.frames import ErrorFrame, Frame, TTSAudioRawFrame
from pipecat.services.minimax.tts import (
    MiniMaxHttpTTSService,
    language_to_minimax_language,
)
from pipecat.services.tts_service import WebsocketTTSService
from pipecat.transcriptions.language import Language
from pipecat.utils.tracing.service_decorators import traced_tts
from websockets.protocol import State

_http_session: aiohttp.ClientSession | None = None

# Spelling of a language on the way in -> the Language member MiniMax's own
# map knows. Cantonese is the one that matters: ZH_HK looks like the obvious
# member and is the wrong one, because MiniMax's map is keyed on YUE and
# anything it does not know falls through to the raw code string.
_LANGUAGE_ALIASES = {
    "CHINESE": "ZH",
    "MANDARIN": "ZH",
    "ZH_CN": "ZH",
    "ZH_HANS": "ZH",
    "ZH_TW": "ZH",
    "CANTONESE": "YUE",
    "ZH_HK": "YUE",
    "ZH_HANT_HK": "YUE",
    "ENGLISH": "EN",
    "EN_US": "EN",
    "EN_GB": "EN",
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


def _language_boost(language) -> str | None:
    """The `language_boost` string MiniMax actually reads, or None.

    `TTSSettings.language` is a dead end for this service. Pipecat stores it
    and converts it to a service string, but neither the HTTP payload nor the
    websocket's `task_start` message ever looks at it -- both read
    `language_boost`, which upstream only fills in from the deprecated
    `params=` constructor path this module does not use. So `MINIMAX_LANGUAGE`
    silently did nothing until this converted it here.

    Note that Cantonese has to arrive as `Language.YUE`. `Language.ZH_HK` is
    not in MiniMax's map and resolves to the literal "zh-HK", which the API
    does not recognise as a language at all.
    """
    if language is None:
        return None
    return language_to_minimax_language(language)


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


# Websocket URL for a given HTTP base. MiniMax puts the two on the same host,
# so the region chosen by MINIMAX_BASE_URL carries over without a second knob.
def _ws_url_for(base_url: str | None) -> str:
    explicit = os.getenv("MINIMAX_WS_URL")
    if explicit:
        return explicit.strip()
    host = urlparse(base_url or "https://api.minimax.io/v1/t2a_v2").netloc
    return f"wss://{host or 'api.minimax.io'}/ws/v1/t2a_v2"


class _WebsocketMiniMaxTTSService(WebsocketTTSService):
    """MiniMax TTS over the T2A websocket instead of one HTTP request per sentence.

    HTTP re-negotiates a whole synthesis session on every call, and a reply is
    split into a sentence per call, so a four sentence answer pays that four
    times. The websocket says model, voice and audio format once in `task_start`
    and then sends only text.

    Measured 2026-09-11 from one machine, alternating the two protocols sentence
    by sentence so they share the same slice of network, first audio per
    sentence with the connection already warm:

        api-uw.minimax.io   HTTP 1657ms   websocket 496ms   +1168ms, 8 of 8
        api.minimax.io      HTTP 1408ms   websocket  514ms   +886ms, 8 of 8

    Sixteen of sixteen, and the websocket's spread is the narrow one. Those
    absolutes are a laptop's, not the server's -- the deployment's own logs show
    HTTP first audio near 670ms -- so expect the gap to be smaller there. The
    direction is the part that is not in doubt.

    What it costs: the socket plus `task_start` is about 1.9s before the first
    sentence can be sent. That is why `start()` connects eagerly, so a session
    pays it while the greeting's LLM call is still running rather than in front
    of the first word.

    Barge-in is the hard part, and the reason this class is shaped the way it
    is. The protocol has task_start, task_continue and task_finish, and no
    cancel. Measured on a live task: interrupting a long sentence and sending
    the next one immediately produced 508 more chunks of the abandoned sentence
    first, and the new sentence's audio did not start until 1591ms after the
    interruption. A socket cannot be reused after an interruption, so
    `on_audio_context_interrupted` throws it away and reconnects in the
    background, where the ~1.9s overlaps the next turn's STT and LLM.
    """

    Settings = MiniMaxHttpTTSService.Settings

    def __init__(
        self,
        *,
        api_key: str,
        ws_url: str,
        sample_rate: int | None = None,
        settings: Settings | None = None,
        **kwargs,
    ):
        """Initialize the MiniMax websocket TTS service.

        Args:
            api_key: MiniMax API key. No GroupId: unlike the HTTP endpoint the
                websocket does not take one.
            ws_url: Full wss:// URL of the T2A websocket.
            sample_rate: Output sample rate in Hz, or None for the pipeline's.
            settings: Runtime-updatable settings.
            **kwargs: Additional arguments passed to TTSService.
        """
        default_settings = self.Settings(
            model="speech-02-turbo",
            voice="Calm_Woman",
            language=None,
            speed=1.0,
            volume=1.0,
            pitch=0,
            language_boost=None,
            emotion=None,
            text_normalization=None,
            latex_read=None,
        )
        if settings is not None:
            default_settings.apply_update(settings)

        super().__init__(
            sample_rate=sample_rate,
            push_start_frame=True,
            push_stop_frames=True,
            settings=default_settings,
            **kwargs,
        )

        self._api_key = api_key
        self._ws_url = ws_url
        self._audio_bitrate = 128000
        self._audio_format = "pcm"
        self._audio_channel = 1
        self._audio_sample_rate = 0  # set in start()
        # One synthesis at a time. The protocol tags nothing with a context id,
        # so the only way to tell one sentence's audio from the next is to have
        # just one in flight.
        self._send_lock = asyncio.Lock()
        self._recycle_task = None

    def can_generate_metrics(self) -> bool:
        """Check if this service can generate processing metrics.

        Returns:
            True, as MiniMax service supports metrics generation.
        """
        return True

    def language_to_service_language(self, language: Language) -> str | None:
        """Convert a Language enum to MiniMax service language format.

        Args:
            language: The language to convert.

        Returns:
            The MiniMax-specific language name, or None if not supported.
        """
        return MiniMaxHttpTTSService.language_to_service_language(self, language)

    async def start(self, frame):
        """Start the service and open the socket before it is needed.

        Args:
            frame: The start frame containing initialization parameters.
        """
        await super().start(frame)
        self._audio_sample_rate = self.sample_rate
        await self._connect()

    async def _connect(self):
        await super()._connect()
        await self._connect_websocket()

    async def _disconnect(self):
        await super()._disconnect()
        await self._disconnect_websocket()

    def _task_start_message(self) -> str:
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

        message = {
            "event": "task_start",
            "model": self._settings.model,
            "voice_setting": voice_setting,
            "audio_setting": {
                "bitrate": self._audio_bitrate,
                "format": self._audio_format,
                "channel": self._audio_channel,
                "sample_rate": self._audio_sample_rate,
            },
        }
        if self._settings.language_boost is not None:
            message["language_boost"] = self._settings.language_boost
        return json.dumps(message)

    async def _connect_websocket(self):
        try:
            if self._websocket and self._websocket.state is State.OPEN:
                return
            logger.debug("Connecting to MiniMax TTS websocket")
            websocket = await self._websocket_connect(
                self._ws_url,
                additional_headers={"Authorization": f"Bearer {self._api_key}"},
                # An audio block runs to hundreds of KB, well past the library's
                # 1MB default only by luck; no limit is the honest setting for a
                # stream whose frame size the server chooses.
                max_size=None,
            )
            await websocket.recv()  # connected_success
            await websocket.send(self._task_start_message())
            while True:
                message = json.loads(await websocket.recv())
                if message.get("event") == "task_started":
                    break
                if message.get("event") == "task_failed":
                    raise RuntimeError(f"MiniMax refused task_start: {message}")
            self._websocket = websocket
            await self._call_event_handler("on_connected")
        except Exception as exc:  # noqa: BLE001 - reported, not raised into the pipeline
            self._websocket = None
            await self.push_error(error_msg=f"MiniMax TTS websocket failed: {exc}", exception=exc)
            await self._call_event_handler("on_connection_error", f"{exc}")

    async def _disconnect_websocket(self):
        websocket, self._websocket = self._websocket, None
        try:
            await self.stop_all_metrics()
            if websocket and websocket.state is State.OPEN:
                logger.debug("Disconnecting from MiniMax TTS websocket")
                await websocket.send(json.dumps({"event": "task_finish"}))
                await websocket.close()
        except Exception as exc:  # noqa: BLE001 - teardown must not raise
            logger.warning("MiniMax TTS websocket close errored: {}", exc)
        finally:
            await self._call_event_handler("on_disconnected")

    async def _receive_messages(self):
        """Not used: this service reads its own replies.

        `WebsocketService` offers a background receive task for protocols that
        tag each message with a context, so one reader can fan messages out to
        several in-flight requests. MiniMax's T2A websocket tags nothing, so
        there can only ever be one synthesis in flight and `run_tts` reads it
        directly. Nothing starts this, and it is here because the base class
        declares it abstract.
        """
        raise NotImplementedError(
            "MiniMax websocket replies are read inline by run_tts, not by a receive task"
        )

    async def on_audio_context_interrupted(self, context_id: str):
        """Throw the socket away: the abandoned sentence still owns it.

        There is no cancel in this protocol, so everything already queued for
        the interrupted sentence is still coming and would arrive ahead of the
        next one. Reconnecting costs ~1.9s, spent in the background against the
        next turn's STT and LLM rather than in front of its first word.
        """
        await self._recycle_websocket()
        await super().on_audio_context_interrupted(context_id)

    async def _recycle_websocket(self):
        """Drop the current socket and open a fresh one, off the critical path."""
        if self._recycle_task:
            return
        stale, self._websocket = self._websocket, None

        async def _close(socket):
            try:
                await socket.close()
            except Exception as exc:  # noqa: BLE001 - a dead socket may close badly
                logger.debug("MiniMax TTS stale socket close errored: {}", exc)

        async def _replace():
            try:
                await self._connect_websocket()
            finally:
                self._recycle_task = None

        # The close is not awaited first: a peer that has stopped answering
        # takes the full close timeout to give up, and waiting that out before
        # dialling again made recovery 3775ms instead of the ~1900ms the new
        # connection actually needs (measured 2026-09-11).
        if stale:
            self.create_task(_close(stale))
        self._recycle_task = self.create_task(_replace())

    @traced_tts
    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        """Synthesize one sentence over the open socket.

        Args:
            text: The text to synthesize into speech.
            context_id: The context ID for tracking audio frames.

        Yields:
            Frame: Audio frames containing the synthesized speech.
        """
        frame_bytes = max(2, int(self.sample_rate * _FRAME_SECONDS) * 2)
        completed = False
        websocket = None
        try:
            async with self._send_lock:
                if not self._websocket or self._websocket.state is not State.OPEN:
                    await self._connect_websocket()
                websocket = self._websocket
                if not websocket:
                    yield ErrorFrame(error="MiniMax TTS websocket is not connected")
                    return

                await websocket.send(json.dumps({"event": "task_continue", "text": text}))
                await self.start_tts_usage_metrics(text)

                while True:
                    message = json.loads(await websocket.recv())
                    if message.get("event") == "task_failed":
                        yield ErrorFrame(error=f"MiniMax TTS failed: {message}")
                        break
                    audio_hex = (message.get("data") or {}).get("audio")
                    if audio_hex:
                        try:
                            audio = bytes.fromhex(audio_hex)
                        except ValueError as exc:
                            logger.error("MiniMax TTS returned audio that is not hex: {}", exc)
                            audio = b""
                        for start in range(0, len(audio), frame_bytes):
                            chunk = audio[start : start + frame_bytes]
                            if not chunk:
                                continue
                            await self.stop_ttfb_metrics()
                            yield TTSAudioRawFrame(
                                audio=chunk,
                                sample_rate=self.sample_rate,
                                num_channels=1,
                                context_id=context_id,
                            )
                    if message.get("is_final"):
                        completed = True
                        break
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - matches the HTTP service's contract
            yield ErrorFrame(error=f"Unknown error occurred: {exc}", exception=exc)
        finally:
            await self.stop_ttfb_metrics()
            # Left mid-sentence, by an interruption or an error: the rest of
            # this sentence is still on its way, so that socket is spent. The
            # identity check matters because on barge-in
            # `on_audio_context_interrupted` has usually recycled it already --
            # without it, a `finally` that ran late would throw away the
            # replacement instead of the socket it was actually reading.
            if not completed and websocket is not None and self._websocket is websocket:
                await self._recycle_websocket()


def create_service(**kwargs):
    api_key = kwargs.get("api_key") or os.getenv("MINIMAX_API_KEY")
    group_id = kwargs.get("group_id") or os.getenv("MINIMAX_GROUP_ID")
    if not api_key:
        raise RuntimeError("MiniMax TTS requires MINIMAX_API_KEY")
    if not group_id:
        raise RuntimeError(
            "MiniMax TTS requires MINIMAX_GROUP_ID from the same MiniMax console as the API key"
        )

    settings = _settings(
        model=kwargs.get("model") or os.getenv("MINIMAX_TTS_MODEL") or "speech-2.6-turbo",
        voice=kwargs.get("voice") or os.getenv("MINIMAX_VOICE") or "Calm_Woman",
        language_boost=_language_boost(
            _parse_language(kwargs.get("language") or os.getenv("MINIMAX_LANGUAGE"))
        ),
        emotion=kwargs.get("emotion") or os.getenv("MINIMAX_EMOTION"),
    )
    base_url = kwargs.get("base_url") or os.getenv("MINIMAX_BASE_URL")

    # Websocket by default: it says model, voice and format once instead of on
    # every sentence, which measured 886-1168ms faster per sentence and won
    # 16 runs of 16 (see _WebsocketMiniMaxTTSService). The HTTP service stays
    # reachable because the websocket has one behaviour HTTP does not -- an
    # interruption costs a reconnect, since the protocol has no cancel -- and a
    # deployment that trips over it should be able to fall back by setting an
    # env var rather than by shipping a revert.
    transport = (
        kwargs.get("transport") or os.getenv("MINIMAX_TTS_TRANSPORT") or "websocket"
    ).strip().lower()
    if transport in {"websocket", "ws"}:
        return _WebsocketMiniMaxTTSService(
            api_key=api_key,
            ws_url=_ws_url_for(base_url),
            settings=settings,
        )
    if transport not in {"http", "https"}:
        raise RuntimeError("MINIMAX_TTS_TRANSPORT must be one of: websocket, http")

    init_kwargs = {
        "api_key": api_key,
        "group_id": group_id,
        "aiohttp_session": kwargs.get("aiohttp_session") or _get_http_session(),
        "settings": settings,
    }
    if base_url:
        init_kwargs["base_url"] = base_url

    return _LowLatencyMiniMaxTTSService(**init_kwargs)

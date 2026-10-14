"""Custom websocket transports for raw PCM input with ESP32/browser outputs."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass

import av
import numpy as np
from fastapi import WebSocket
from loguru import logger

from pipecat.frames.frames import (
    Frame,
    InputAudioRawFrame,
    InputTransportMessageFrame,
    OutputAudioRawFrame,
    OutputTransportMessageFrame,
    OutputTransportMessageUrgentFrame,
)
from pipecat.serializers.base_serializer import FrameSerializer
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketCallbacks,
    FastAPIWebsocketClient,
    FastAPIWebsocketInputTransport,
    FastAPIWebsocketOutputTransport,
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)


class RawPCMFrameSerializer(FrameSerializer):
    """Deserialize raw PCM and JSON control messages."""

    def __init__(
        self,
        input_sample_rate: int,
        input_channels: int = 1,
        on_control: Callable[[dict], bool] | None = None,
    ):
        super().__init__()
        self._input_sample_rate = input_sample_rate
        self._input_channels = input_channels
        # Gets each JSON message first; True means it was handled outside the
        # voice pipeline (device Wi-Fi management) and must not enter it.
        self._on_control = on_control

    async def serialize(self, frame: Frame) -> str | bytes | None:
        if isinstance(frame, (OutputTransportMessageFrame, OutputTransportMessageUrgentFrame)):
            if self.should_ignore_frame(frame):
                return None
            return json.dumps(frame.message)
        return None

    async def deserialize(self, data: str | bytes) -> Frame | None:
        if isinstance(data, bytes):
            return InputAudioRawFrame(
                audio=data,
                sample_rate=self._input_sample_rate,
                num_channels=self._input_channels,
            )

        if isinstance(data, str):
            try:
                message = json.loads(data)
            except json.JSONDecodeError:
                logger.warning("Ignoring non-JSON websocket text frame")
                return None
            if isinstance(message, dict) and self._on_control and self._on_control(message):
                return None
            return InputTransportMessageFrame(message=message)

        return None


@dataclass
class OpusEncoder:
    sample_rate: int = 24000
    channels: int = 1
    # 40kbps "audio", not 24kbps "voip". At 24kbps voip libopus codes this
    # 24kHz speech as SILK+CELT hybrid, and on MiniMax's Cantonese voice that
    # pulled some 20ms stretches up to 3.9dB under the source -- heard on the
    # toy as syllables faintly swallowed. At 40kbps audio it is CELT only:
    # worst stretch -0.8dB, waveform SNR 20.1dB against 10.8dB, and picked by
    # ear over the old setting on the same clip (2026-09-30).
    #
    # It is also cheaper to *decode*. Measured on the xmini-c3 (single 160MHz
    # core), same 12.6s clip, scheduler suspended per packet: 8256us per 40ms
    # packet against 10287us, 20.6% of the core against 25.7%, and the libopus
    # pseudo-stack peaked at 6288 bytes of the 16KB that board gives it. The
    # cost is the websocket: ~38kbps of payload instead of ~21.
    bit_rate: int = 40000
    # Opus' native frame sizes stop at 60ms: a 120ms packet is not a longer
    # frame, it is six 20ms frames concatenated behind one header, so it buys
    # no coding efficiency at all. Measured over 10s of speech-like audio at
    # this bitrate, 2026-09-11: 20ms -> 25304 bytes, 40ms -> 25217 bytes,
    # 120ms -> 25446 bytes. The long packet was the *largest* of the three.
    #
    # What it did cost was latency. The encoder has to accumulate a whole
    # frame before it emits anything, so at 120ms the first packet of every
    # answer waited on 120ms of PCM that pipecat had already produced.
    #
    # 40ms matches the transport's own chunk size (audio_out_10ms_chunks=4 at
    # 24kHz), so each chunk handed to write_audio_frame() now produces exactly
    # one packet and nothing is left in _buffer between calls. The cost is
    # packet rate -- 25/s instead of 8.3/s, roughly 10kbps more of websocket
    # and TLS framing -- which is not worth counting on wifi.
    frame_duration_ms: int = 40

    def __post_init__(self):
        self._codec = av.CodecContext.create("libopus", "w")
        self._codec.sample_rate = self.sample_rate
        self._codec.rate = self.sample_rate
        self._codec.layout = "mono" if self.channels == 1 else "stereo"
        self._codec.format = "s16"
        self._codec.bit_rate = self.bit_rate
        self._codec.options = {
            "application": "audio",
            "frame_duration": str(self.frame_duration_ms),
            # ffmpeg's libopus wrapper defaults this to 10, the slowest
            # setting. At 24kbps voip it bought nothing measurable: over the
            # same 10s sample, level 5 produced 24931 bytes against level
            # 10's 25217 -- slightly *smaller* -- for half the encode time
            # (0.44ms vs 0.77ms per frame). This call is synchronous inside
            # the event loop, so that half is worth having once more than a
            # couple of sessions share the process.
            "compression_level": "5",
        }
        self._codec.open()
        self._frame_size = int(self.sample_rate * self.frame_duration_ms / 1000)
        self._bytes_per_frame = self._frame_size * self.channels * 2
        self._buffer = bytearray()

    def encode(self, pcm_audio: bytes) -> list[bytes]:
        packets: list[bytes] = []
        self._buffer.extend(pcm_audio)

        while len(self._buffer) >= self._bytes_per_frame:
            chunk = bytes(self._buffer[: self._bytes_per_frame])
            del self._buffer[: self._bytes_per_frame]

            samples = np.frombuffer(chunk, dtype=np.int16).reshape(self.channels, -1)
            frame = av.AudioFrame.from_ndarray(samples, format="s16", layout=self._codec.layout.name)
            frame.sample_rate = self.sample_rate
            packets.extend(bytes(packet) for packet in self._codec.encode(frame))

        return packets

    def flush(self, pad_final_frame: bool = False) -> list[bytes]:
        if not self._buffer:
            return []

        if not pad_final_frame:
            self._buffer.clear()
            return []

        padded = bytes(self._buffer) + b"\x00" * (self._bytes_per_frame - len(self._buffer))
        self._buffer.clear()
        return self.encode(padded)

    def reset(self):
        self._buffer.clear()

    def close(self):
        self._buffer.clear()


class RawPCMWebsocketOutputTransport(FastAPIWebsocketOutputTransport):
    async def send_message(
        self, frame: OutputTransportMessageFrame | OutputTransportMessageUrgentFrame
    ):
        if self._client.is_closing or not self._client.is_connected:
            return
        payload = await self._params.serializer.serialize(frame) if self._params.serializer else None
        if payload:
            await self._client.send(payload)

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        if self._client.is_closing or not self._client.is_connected:
            return False

        await self._client.send(frame.audio)
        await self._write_audio_sleep()
        return True


class OpusWebsocketOutputTransport(FastAPIWebsocketOutputTransport):
    def __init__(self, transport, client, params, **kwargs):
        super().__init__(transport, client, params, **kwargs)
        self._encoder = OpusEncoder(
            sample_rate=params.audio_out_sample_rate or 24000,
            channels=params.audio_out_channels or 1,
        )

    async def send_message(
        self, frame: OutputTransportMessageFrame | OutputTransportMessageUrgentFrame
    ):
        if self._client.is_closing or not self._client.is_connected:
            return

        message = frame.message if isinstance(frame.message, dict) else {}
        msg = message.get("msg")

        if msg == "RESPONSE.CREATED":
            self._encoder.reset()
        elif msg == "RESPONSE.COMPLETE":
            for packet in self._encoder.flush(pad_final_frame=True):
                await self._client.send(packet)
        elif msg == "RESPONSE.ERROR":
            self._encoder.reset()

        payload = await self._params.serializer.serialize(frame) if self._params.serializer else None
        if payload:
            await self._client.send(payload)

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        if self._client.is_closing or not self._client.is_connected:
            return False

        for packet in self._encoder.encode(frame.audio):
            await self._client.send(packet)

        await self._write_audio_sleep()
        return True


class BaseRawWebsocketTransport(FastAPIWebsocketTransport):
    output_transport_cls = RawPCMWebsocketOutputTransport

    def __init__(
        self,
        websocket: WebSocket,
        params: FastAPIWebsocketParams,
        input_name: str | None = None,
        output_name: str | None = None,
    ):
        super(FastAPIWebsocketTransport, self).__init__(input_name=input_name, output_name=output_name)
        self._params = params
        self._callbacks = FastAPIWebsocketCallbacks(
            on_client_connected=self._on_client_connected,
            on_client_disconnected=self._on_client_disconnected,
            on_session_timeout=self._on_session_timeout,
        )
        self._client = FastAPIWebsocketClient(websocket, self._callbacks)
        self._input = FastAPIWebsocketInputTransport(
            self, self._client, self._params, name=self._input_name
        )
        self._output = self.output_transport_cls(self, self._client, self._params, name=self._output_name)
        self._register_event_handler("on_client_connected")
        self._register_event_handler("on_client_disconnected")
        self._register_event_handler("on_session_timeout")


class Esp32WebsocketTransport(BaseRawWebsocketTransport):
    output_transport_cls = OpusWebsocketOutputTransport


class BrowserWebsocketTransport(BaseRawWebsocketTransport):
    output_transport_cls = RawPCMWebsocketOutputTransport

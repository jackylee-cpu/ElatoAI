"""Does the MiniMax parser release audio as soon as it has it?

Upstream reads the SSE body in 24000-byte chunks and will not emit a `data:`
block until a *second* `data:` marker arrives to delimit it, so the first audio
waits on a byte count and on the block behind it. These tests pin the parser
that does neither, and the two edges that broke while measuring it: a block
split across socket reads, and a final block too long for aiohttp's readline.
"""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("MINIMAX_API_KEY", "test-key")
os.environ.setdefault("MINIMAX_GROUP_ID", "test-group")

from pipecat.frames.frames import ErrorFrame, TTSAudioRawFrame

from models.tts.minimax import _LowLatencyMiniMaxTTSService

SAMPLE_RATE = 24000


def sse(audio: bytes, *, extra_info: bool = False) -> bytes:
    """One MiniMax SSE line. The real final block carries extra_info last."""
    body: dict = {"data": {"audio": audio.hex(), "status": 1}, "trace_id": "t"}
    if extra_info:
        body["extra_info"] = {"audio_length": 1}
    return b"data: " + json.dumps(body).encode() + b"\n"


class _FakeContent:
    """Hands out exactly the reads it was given, the way a socket would."""

    def __init__(self, reads):
        self._reads = list(reads)

    async def iter_any(self):
        for read in self._reads:
            yield read


class _FakeResponse:
    def __init__(self, reads, status=200, text=""):
        self.content = _FakeContent(reads)
        self.status = status
        self._text = text

    async def text(self):
        return self._text

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeSession:
    def __init__(self, response):
        self._response = response
        self.payload = None

    def post(self, url, headers=None, json=None):
        self.payload = json
        return self._response


def build(reads, **kwargs):
    service = _LowLatencyMiniMaxTTSService(
        api_key="test-key",
        group_id="test-group",
        aiohttp_session=_FakeSession(_FakeResponse(reads, **kwargs)),
        settings=_LowLatencyMiniMaxTTSService.Settings(model="speech-2.6-turbo"),
    )
    service._sample_rate = SAMPLE_RATE
    service._audio_sample_rate = SAMPLE_RATE

    async def noop(*args, **kwargs):
        return None

    service.start_tts_usage_metrics = noop
    service.stop_ttfb_metrics = noop
    return service


async def collect(service):
    audio = bytearray()
    errors = []
    frames = 0
    async for frame in service.run_tts("你好", "ctx"):
        if isinstance(frame, ErrorFrame):
            errors.append(frame.error)
        elif isinstance(frame, TTSAudioRawFrame):
            audio.extend(frame.audio)
            frames += 1
    return bytes(audio), frames, errors


async def test_the_only_block_in_the_body_is_still_emitted():
    """Upstream needs a second `data:` to delimit the first. This must not."""
    only = b"\x01\x02" * 100
    audio, frames, errors = await collect(build([sse(only)]))
    assert errors == []
    assert audio == only
    assert frames >= 1


async def test_a_block_split_across_socket_reads_is_reassembled():
    first, second = b"\xaa\xbb" * 50, b"\xcc\xdd" * 50
    body = sse(first) + sse(second)
    # split at a point that lands inside the first block's hex string
    cut = 40
    audio, _frames, errors = await collect(build([body[:cut], body[cut:]]))
    assert errors == []
    assert audio == first + second


async def test_the_aggregated_final_block_is_not_spoken_twice():
    """MiniMax repeats the whole synthesis in the extra_info block."""
    streamed = b"\x11\x22" * 60
    body = sse(streamed) + sse(streamed, extra_info=True)
    audio, _frames, errors = await collect(build([body]))
    assert errors == []
    assert audio == streamed


async def test_a_block_longer_than_aiohttps_readline_limit_survives():
    """aiohttp's readline caps a line at 512KB; the real final block runs past it."""
    big = b"\x33\x44" * 200_000  # ~800KB of hex on the wire
    body = sse(big)
    reads = [body[i : i + 65536] for i in range(0, len(body), 65536)]
    audio, _frames, errors = await collect(build(reads))
    assert errors == []
    assert audio == big


async def test_audio_is_split_into_frames_smaller_than_the_download_chunk():
    """One frame per tenth of a second, so the first reaches the transport early."""
    one_second = b"\x00\x01" * SAMPLE_RATE
    _audio, frames, errors = await collect(build([sse(one_second)]))
    assert errors == []
    assert frames == 10


async def test_a_non_200_reports_the_body_rather_than_a_bare_status():
    _audio, _frames, errors = await collect(
        build([], status=401, text="invalid api key")
    )
    assert len(errors) == 1
    assert "401" in errors[0] and "invalid api key" in errors[0]


async def test_malformed_json_does_not_take_down_the_turn():
    good = b"\x55\x66" * 40
    body = b"data: {not json at all}\n" + sse(good)
    audio, _frames, errors = await collect(build([body]))
    assert errors == []
    assert audio == good

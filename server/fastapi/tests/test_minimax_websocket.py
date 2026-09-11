"""The MiniMax T2A websocket, and the one thing it cannot do.

HTTP renegotiates a synthesis session per sentence; the websocket says model,
voice and format once in `task_start` and then sends only text. What it buys is
measured in models/tts/minimax.py. What it costs is that the protocol has no
cancel, so a sentence abandoned half way still owns the socket -- these tests
pin that the socket is thrown away rather than reused, because reusing it
delivers the abandoned sentence's audio into the next turn.
"""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("MINIMAX_API_KEY", "test-key")
os.environ.setdefault("MINIMAX_GROUP_ID", "test-group")

from pipecat.frames.frames import ErrorFrame, TTSAudioRawFrame

from models.tts.minimax import _WebsocketMiniMaxTTSService, _ws_url_for

SAMPLE_RATE = 24000


class _FakeSocket:
    """A T2A websocket that replies from a script."""

    class _State:
        name = "OPEN"

    def __init__(self, replies):
        # replies: list of lists -- one list of messages per task_continue
        self._replies = list(replies)
        self.state = OPEN
        self.sent = []
        self.closed = False
        self._pending = []

    async def recv(self):
        if not self._pending:
            raise AssertionError("recv() with nothing queued")
        return json.dumps(self._pending.pop(0))

    async def send(self, raw):
        message = json.loads(raw)
        self.sent.append(message)
        if message.get("event") == "task_continue":
            self._pending.extend(self._replies.pop(0) if self._replies else [])

    async def close(self):
        self.closed = True
        self.state = CLOSED


from websockets.protocol import State  # noqa: E402

OPEN, CLOSED = State.OPEN, State.CLOSED


def audio_message(payload: bytes, final: bool = False):
    message = {"data": {"audio": payload.hex(), "status": 1}}
    if final:
        message["is_final"] = True
    return message


def build(socket=None):
    service = _WebsocketMiniMaxTTSService(
        api_key="test-key",
        ws_url="wss://example.invalid/ws/v1/t2a_v2",
        settings=_WebsocketMiniMaxTTSService.Settings(model="speech-2.6-turbo"),
    )
    service._sample_rate = SAMPLE_RATE
    service._audio_sample_rate = SAMPLE_RATE
    service._websocket = socket

    async def noop(*args, **kwargs):
        return None

    service.start_tts_usage_metrics = noop
    service.stop_ttfb_metrics = noop
    service.stop_all_metrics = noop
    service._call_event_handler = noop
    service.push_error = noop
    service.create_task = lambda coro, *a, **k: asyncio.create_task(coro)
    return service


async def collect(service, text, stop_after=None):
    audio, errors, frames = bytearray(), [], 0
    async for frame in service.run_tts(text, "ctx"):
        if isinstance(frame, ErrorFrame):
            errors.append(frame.error)
        elif isinstance(frame, TTSAudioRawFrame):
            audio.extend(frame.audio)
            frames += 1
            if stop_after and frames >= stop_after:
                break
    return bytes(audio), frames, errors


async def test_a_sentence_is_sent_as_text_only():
    """task_start carried the voice; a sentence must not re-send it."""
    speech = b"\x01\x02" * 100
    socket = _FakeSocket([[audio_message(speech, final=True)]])
    service = build(socket)
    audio, _frames, errors = await collect(service, "你好")

    assert errors == []
    assert audio == speech
    assert socket.sent == [{"event": "task_continue", "text": "你好"}]


async def test_the_socket_survives_a_sentence_that_finished():
    """A completed sentence must not cost a reconnect."""
    speech = b"\x03\x04" * 80
    socket = _FakeSocket([[audio_message(speech, final=True)]])
    service = build(socket)
    await collect(service, "你好")
    await asyncio.sleep(0)

    assert service._websocket is socket, "a clean sentence threw the socket away"
    assert not socket.closed


async def test_interrupting_throws_the_socket_away():
    """The protocol has no cancel, so the rest of that sentence is still coming.

    Reusing the socket would play it into the next turn -- measured on a live
    task as 508 leftover chunks and 1591ms before the new sentence was heard.
    `on_audio_context_interrupted` is the hook pipecat calls on barge-in.
    """
    speech = b"\x05\x06" * 4000
    socket = _FakeSocket([[audio_message(speech), audio_message(b"\x07\x08" * 10, final=True)]])
    service = build(socket)
    await service.on_audio_context_interrupted("ctx")
    await asyncio.sleep(0)

    assert service._websocket is not socket, "the interrupted sentence's socket was kept"


async def test_a_sentence_cancelled_mid_stream_throws_the_socket_away():
    """The backstop for the same thing, one layer down.

    On barge-in pipecat cancels the task iterating run_tts, which throws into
    the generator at its await; this pins that the socket goes with it even if
    the hook above never runs.
    """
    speech = b"\x05\x06" * 4000
    socket = _FakeSocket([[audio_message(speech), audio_message(b"\x07\x08" * 10, final=True)]])
    service = build(socket)

    generator = service.run_tts("很長的一句話", "ctx")
    await generator.__anext__()          # first frame out, sentence still running
    await generator.aclose()             # the iterating task goes away
    await asyncio.sleep(0)

    assert service._websocket is not socket, "the abandoned sentence's socket was kept"
    assert not service._send_lock.locked(), "the send lock was not released"


async def test_an_error_reply_is_reported_and_does_not_keep_the_socket():
    socket = _FakeSocket([[{"event": "task_failed", "base_resp": {"status_code": 1004}}]])
    service = build(socket)
    _audio, _frames, errors = await collect(service, "你好")

    assert len(errors) == 1 and "task_failed" in errors[0]
    assert service._websocket is not socket


async def test_audio_is_split_into_frames_not_handed_over_whole():
    """One frame per tenth of a second, so the first reaches the transport early."""
    one_second = b"\x00\x01" * SAMPLE_RATE
    socket = _FakeSocket([[audio_message(one_second, final=True)]])
    service = build(socket)
    _audio, frames, errors = await collect(service, "你好")

    assert errors == []
    assert frames == 10


async def test_task_start_names_the_voice_model_and_format():
    service = build()
    message = json.loads(service._task_start_message())

    assert message["event"] == "task_start"
    assert message["model"] == "speech-2.6-turbo"
    assert message["voice_setting"]["voice_id"]
    assert message["audio_setting"] == {
        "bitrate": 128000,
        "format": "pcm",
        "channel": 1,
        "sample_rate": SAMPLE_RATE,
    }


def test_the_websocket_follows_whichever_region_the_http_base_url_names():
    """One knob for the region, not two that can disagree."""
    assert _ws_url_for("https://api-uw.minimax.io/v1/t2a_v2") == (
        "wss://api-uw.minimax.io/ws/v1/t2a_v2"
    )
    assert _ws_url_for("https://api.minimax.io/v1/t2a_v2") == (
        "wss://api.minimax.io/ws/v1/t2a_v2"
    )
    assert _ws_url_for(None) == "wss://api.minimax.io/ws/v1/t2a_v2"


def test_an_explicit_websocket_url_wins():
    os.environ["MINIMAX_WS_URL"] = "wss://private.example/ws/v1/t2a_v2"
    try:
        assert _ws_url_for("https://api.minimax.io/v1/t2a_v2") == (
            "wss://private.example/ws/v1/t2a_v2"
        )
    finally:
        del os.environ["MINIMAX_WS_URL"]


async def test_the_hook_and_the_backstop_do_not_recycle_twice():
    """Barge-in fires both paths; between them they must cost one socket, not two.

    on_audio_context_interrupted runs first and replaces the socket, then the
    cancelled generator's finally runs. If that second path recycled blindly it
    would throw away the replacement that the next turn is about to speak on.
    """
    speech = b"\x05\x06" * 4000
    socket = _FakeSocket([[audio_message(speech), audio_message(b"\x07\x08" * 10, final=True)]])
    service = build(socket)

    replacements = []

    async def fake_connect():
        service._websocket = _FakeSocket([])
        replacements.append(service._websocket)

    service._connect_websocket = fake_connect

    generator = service.run_tts("很長的一句話", "ctx")
    await generator.__anext__()
    await service.on_audio_context_interrupted("ctx")   # the hook
    while service._recycle_task:
        await asyncio.sleep(0)
    replaced = service._websocket
    await generator.aclose()                            # the backstop
    await asyncio.sleep(0)

    assert len(replacements) == 1, f"recycled {len(replacements)} times, expected 1"
    assert service._websocket is replaced, "the backstop discarded the replacement"

"""Talk to the voice server the way a board does, and check that it answers.

    .venv/bin/python scripts/simulate_device.py                 # the cloud
    .venv/bin/python scripts/simulate_device.py --target local  # localhost:7860

One run is one session, the same steps the firmware takes (src/Audio.cpp):

1. Open /ws/esp32 with the board's three headers: Authorization,
   X-Wifi-Rssi, X-Device-Mac.
2. Wait for the {"type": "auth"} frame.
3. Sit through the greeting the server always opens with: RESPONSE.CREATED,
   Opus packets, RESPONSE.COMPLETE.
4. Push-to-talk: stream a 16kHz s16le mono question in real time, in the
   board's 1024-byte frames, then send end_of_speech.
5. Expect AUDIO.COMMITTED, then a spoken answer.

Every step has a deadline. The exit code is 0 only when all of them pass, so
this can run after a deploy. Each answer is decoded and saved as a WAV next to
--out, so you can listen to what came back.

The default MAC is a made-up, locally administered one. The cloud resolves it
to no account, so the session runs without memory and writes nothing to any
family's store. Pass a real board's MAC only if you mean to talk as that board.

The ESP32 route sends no transcripts, so this checks that audio came back,
not what the recognizer heard. Listen to the saved WAVs for that.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path

import av
import numpy as np
import websockets

TARGETS = {
    # Config.cpp, PROD_MODE + VOICE_SERVER_FASTAPI.
    "cloud": "wss://elatoai.hkqft.com/fastapi/ws/esp32",
    # platformio.ini, the *-localws envs.
    "local": "ws://localhost:7860/ws/esp32",
}

FIXTURE = Path(__file__).parent / "fixtures" / "question_yue.wav"
DEFAULT_MAC = "02:A1:B0:00:00:01"  # locally administered bit set: no real NIC has it

MIC_SAMPLE_RATE = 16000  # server.py ESP32_INPUT_SAMPLE_RATE
MIC_FRAME_BYTES = 1024  # Audio.cpp kMicChunkSamples (512) * 2 bytes
OUT_SAMPLE_RATE = 24000  # server.py AUDIO_OUTPUT_SAMPLE_RATE

# An answer quieter than this is treated as silence: something went wrong
# between the LLM and TTS and the server only sent padding.
MIN_ANSWER_RMS = 100


class StepFailed(Exception):
    pass


@dataclass
class Response:
    packets: list[bytes] = field(default_factory=list)
    first_packet_at: float | None = None
    completed_at: float | None = None
    error: bool = False


class Device:
    def __init__(self, ws):
        self.ws = ws
        self.t0 = time.monotonic()

    def log(self, message: str) -> None:
        print(f"[{time.monotonic() - self.t0:6.2f}s] {message}", flush=True)

    async def next_text(self, deadline: float, want: set[str]) -> dict:
        """Read until a JSON frame whose type or msg is in `want`.

        Binary frames arriving meanwhile are stray audio, dropped like the
        board drops audio outside SPEAKING.
        """
        while True:
            message = await self._recv(deadline, f"one of {sorted(want)}")
            if isinstance(message, bytes):
                continue
            data = json.loads(message)
            self.log(f"<- {message}")
            if data.get("type") in want or data.get("msg") in want:
                return data

    async def read_response(self, created_deadline: float, complete_timeout: float) -> Response:
        """RESPONSE.CREATED, then audio, then RESPONSE.COMPLETE or .ERROR."""
        await self.next_text(created_deadline, {"RESPONSE.CREATED"})
        response = Response()
        deadline = time.monotonic() + complete_timeout
        while True:
            message = await self._recv(deadline, "RESPONSE.COMPLETE")
            if isinstance(message, bytes):
                if response.first_packet_at is None:
                    response.first_packet_at = time.monotonic()
                response.packets.append(message)
                continue
            data = json.loads(message)
            self.log(f"<- {message}")
            if data.get("msg") in {"RESPONSE.COMPLETE", "RESPONSE.ERROR"}:
                response.completed_at = time.monotonic()
                response.error = data["msg"] == "RESPONSE.ERROR"
                return response

    async def speak(self, pcm: bytes) -> None:
        """Stream the question at real-time pace, as the mic would."""
        seconds_per_frame = MIC_FRAME_BYTES / 2 / MIC_SAMPLE_RATE
        start = time.monotonic()
        for i in range(0, len(pcm), MIC_FRAME_BYTES):
            await self.ws.send(pcm[i : i + MIC_FRAME_BYTES])
            ahead = start + (i // MIC_FRAME_BYTES + 1) * seconds_per_frame - time.monotonic()
            if ahead > 0:
                await asyncio.sleep(ahead)
        await self.ws.send(json.dumps({"type": "instruction", "msg": "end_of_speech"}))
        self.log(f"-> {len(pcm) / 2 / MIC_SAMPLE_RATE:.2f}s of audio, then end_of_speech")

    async def _recv(self, deadline: float, waiting_for: str):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise StepFailed(f"timed out waiting for {waiting_for}")
        try:
            return await asyncio.wait_for(self.ws.recv(), remaining)
        except asyncio.TimeoutError:
            raise StepFailed(f"timed out waiting for {waiting_for}") from None
        except websockets.ConnectionClosed as exc:
            raise StepFailed(f"server closed the socket ({exc}) waiting for {waiting_for}") from None


def load_question(path: Path) -> bytes:
    with wave.open(str(path), "rb") as f:
        if (f.getframerate(), f.getnchannels(), f.getsampwidth()) != (MIC_SAMPLE_RATE, 1, 2):
            raise SystemExit(
                f"{path} must be 16kHz mono 16-bit, like the board's mic; got "
                f"{f.getframerate()}Hz {f.getnchannels()}ch {8 * f.getsampwidth()}-bit"
            )
        return f.readframes(f.getnframes())


def decode_opus(packets: list[bytes]) -> tuple[np.ndarray, int]:
    """PCM and its rate. libopus decodes to 48kHz whatever the encoder ran at."""
    codec = av.CodecContext.create("libopus", "r")
    codec.sample_rate = OUT_SAMPLE_RATE
    codec.layout = "mono"
    chunks = []
    rate = OUT_SAMPLE_RATE
    for packet in packets:
        for frame in codec.decode(av.Packet(packet)):
            rate = frame.sample_rate
            samples = frame.to_ndarray().reshape(-1)
            if samples.dtype.kind == "f":
                samples = np.clip(samples * 32767, -32768, 32767)
            chunks.append(samples.astype(np.int16))
    pcm = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.int16)
    return pcm, rate


def check_audio(device: Device, name: str, response: Response, out: Path | None) -> None:
    if response.error:
        raise StepFailed(f"{name}: server sent RESPONSE.ERROR")
    if not response.packets:
        raise StepFailed(f"{name}: RESPONSE.COMPLETE with no audio")
    pcm, rate = decode_opus(response.packets)
    seconds = len(pcm) / rate
    rms = float(np.sqrt(np.mean(pcm.astype(np.float64) ** 2))) if len(pcm) else 0.0
    device.log(f"{name}: {len(response.packets)} packets, {seconds:.2f}s of audio, rms {rms:.0f}")
    if out is not None:
        path = out.with_name(f"{out.stem}-{name}.wav")
        with wave.open(str(path), "wb") as f:
            f.setnchannels(1)
            f.setsampwidth(2)
            f.setframerate(rate)
            f.writeframes(pcm.tobytes())
        device.log(f"{name}: saved {path}")
    if rms < MIN_ANSWER_RMS:
        raise StepFailed(f"{name}: audio is silent (rms {rms:.0f} < {MIN_ANSWER_RMS})")


async def run(args: argparse.Namespace) -> None:
    url = args.url or TARGETS[args.target]
    question = load_question(args.question)
    headers = {
        "Authorization": f"Bearer {args.token}",
        "X-Wifi-Rssi": "-55",
        "X-Device-Mac": args.mac,
    }
    print(f"connecting to {url} as {args.mac}", flush=True)
    connect_started = time.monotonic()
    try:
        ws = await asyncio.wait_for(
            websockets.connect(url, additional_headers=headers, max_size=None),
            args.connect_timeout,
        )
    except (OSError, asyncio.TimeoutError, websockets.InvalidStatus, websockets.InvalidHandshake) as exc:
        raise StepFailed(f"could not open the websocket: {exc!r}") from None

    async with ws:
        device = Device(ws)
        device.t0 = connect_started
        device.log("websocket open")

        auth = await device.next_text(time.monotonic() + args.connect_timeout, {"auth"})
        device.log(f"auth ok (volume {auth.get('volume_control')})")

        greeting = await device.read_response(
            time.monotonic() + args.reply_timeout, args.reply_timeout
        )
        check_audio(device, "greeting", greeting, args.out)

        for turn in range(1, args.turns + 1):
            name = f"turn{turn}"
            await device.speak(question)
            committed_at = time.monotonic()
            await device.next_text(committed_at + args.reply_timeout, {"AUDIO.COMMITTED"})
            answer = await device.read_response(committed_at + args.reply_timeout, args.reply_timeout)
            check_audio(device, name, answer, args.out)
            device.log(
                f"{name}: first audio {answer.first_packet_at - committed_at:.2f}s "
                f"after end_of_speech"
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--target", choices=TARGETS, default="cloud")
    parser.add_argument("--url", help="overrides --target")
    parser.add_argument("--mac", default=DEFAULT_MAC)
    # /ws/esp32 does not check this yet; once it does, pass a real device token.
    parser.add_argument("--token", default="simulator")
    parser.add_argument("--question", type=Path, default=FIXTURE)
    parser.add_argument("--turns", type=int, default=1)
    parser.add_argument("--connect-timeout", type=float, default=15)
    parser.add_argument("--reply-timeout", type=float, default=45)
    parser.add_argument(
        "--out", type=Path, help="save each answer as <out>-greeting.wav, <out>-turn1.wav, ..."
    )
    args = parser.parse_args()
    try:
        asyncio.run(run(args))
    except StepFailed as exc:
        print(f"FAIL: {exc}", flush=True)
        return 1
    print("PASS", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

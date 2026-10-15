"""ADPCM microphone uplink (P2-24): the board's encoder, the server's decoder,
and the serializer between them."""

import math
import os
import random
import shutil
import struct
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pipecat.frames.frames import InputAudioRawFrame  # noqa: E402

import mic_adpcm  # noqa: E402
from esp32_transport import RawPCMFrameSerializer  # noqa: E402

FIRMWARE_SRC = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "firmware-arduino", "src"
)


def speech_like(seconds: float = 2.0, rate: int = 16000) -> bytes:
    """Deterministic test audio that walks the whole step table: quiet noise,
    a voiced sweep, and full-scale square edges that hit the clamps."""
    rng = random.Random(24)
    samples = []
    for i in range(int(seconds * rate)):
        t = i / rate
        if t < 0.3:
            value = rng.gauss(0, 60)
        elif t < 1.6:
            pitch = 120 + 80 * t
            value = 9000 * math.sin(2 * math.pi * pitch * t) + 3000 * math.sin(2 * math.pi * 3 * pitch * t)
            value += rng.gauss(0, 400)
        else:
            value = 32767 if (i // 40) % 2 else -32768
        samples.append(max(-32768, min(32767, int(value))))
    return struct.pack(f"<{len(samples)}h", *samples)


# Uneven block sizes, odd ones included: the Spotpear's downsampler hands out
# odd sample counts.
BLOCK_SAMPLES = [341, 342, 256, 1, 2, 511]


def blocks_of(pcm: bytes):
    offset, n = 0, 0
    while offset < len(pcm):
        size = BLOCK_SAMPLES[n % len(BLOCK_SAMPLES)] * 2
        yield pcm[offset:offset + size]
        offset += size
        n += 1


def python_encode(pcm: bytes) -> list[bytes]:
    state = None
    out = []
    for chunk in blocks_of(pcm):
        block, state = mic_adpcm.encode_block(chunk, state)
        out.append(block)
    return out


def test_blocks_decode_to_what_one_continuous_stream_would():
    pcm = speech_like()
    decoded = b"".join(mic_adpcm.decode_block(b) for b in python_encode(pcm))
    codes, _ = mic_adpcm.audioop.lin2adpcm(pcm + b"\0\0" * (len(pcm) // 2 % 2), 2, None)
    continuous, _ = mic_adpcm.audioop.adpcm2lin(codes, 2, None)
    assert len(decoded) == len(pcm)
    assert decoded == continuous[: len(pcm)]


def test_quarter_of_the_bytes_and_close_to_the_input():
    pcm = speech_like()
    blocks = python_encode(pcm)
    assert sum(len(b) for b in blocks) < len(pcm) / 3.5
    decoded = b"".join(mic_adpcm.decode_block(b) for b in blocks)
    orig = struct.unpack(f"<{len(pcm) // 2}h", pcm)
    back = struct.unpack(f"<{len(decoded) // 2}h", decoded)
    voiced = range(int(0.4 * 16000), int(1.5 * 16000))
    signal = sum(orig[i] ** 2 for i in voiced)
    noise = sum((orig[i] - back[i]) ** 2 for i in voiced)
    assert 10 * math.log10(signal / noise) > 20  # dB on the voiced part


def test_a_lost_block_costs_only_itself():
    pcm = speech_like()
    blocks = python_encode(pcm)
    whole = [mic_adpcm.decode_block(b) for b in blocks]
    survivors = blocks[:3] + blocks[4:]
    assert [mic_adpcm.decode_block(b) for b in survivors] == whole[:3] + whole[4:]


@pytest.mark.parametrize(
    "block",
    [b"", b"\x00\x00\x00\x00", b"\x00\x00\x59\x00\x12", b"\x01"],
)
def test_malformed_blocks_decode_to_nothing(block):
    assert mic_adpcm.decode_block(block) == b""


def test_header_value():
    assert mic_adpcm.uses_adpcm("ima-adpcm")
    assert mic_adpcm.uses_adpcm(" IMA-ADPCM ")
    assert not mic_adpcm.uses_adpcm(None)
    assert not mic_adpcm.uses_adpcm("opus")


async def test_serializer_decodes_only_when_told():
    pcm = speech_like(0.1)
    block, _ = mic_adpcm.encode_block(pcm, None)

    frame = await RawPCMFrameSerializer(input_sample_rate=16000, adpcm=True).deserialize(block)
    assert isinstance(frame, InputAudioRawFrame)
    assert frame.audio == mic_adpcm.decode_block(block) and frame.sample_rate == 16000

    plain = await RawPCMFrameSerializer(input_sample_rate=16000).deserialize(pcm)
    assert plain.audio == pcm

    assert await RawPCMFrameSerializer(input_sample_rate=16000, adpcm=True).deserialize(b"\x00") is None


HARNESS = r"""
#include <stdio.h>
#include <stdlib.h>
#include "MicAdpcm.h"
// stdin: 16-bit PCM. argv: block sizes in samples, used in turn.
// stdout: each block, preceded by its length as uint16 LE.
int main(int argc, char **argv) {
    static int16_t pcm[1 << 20];
    size_t total = fread(pcm, 2, sizeof(pcm) / 2, stdin);
    MicAdpcmState state;
    static uint8_t block[4096];
    size_t at = 0;
    for (int n = 0; at < total; n++) {
        size_t want = (size_t)atoi(argv[1 + n % (argc - 1)]);
        if (want > total - at) want = total - at;
        size_t len = micAdpcmEncodeBlock(state, pcm + at, want, block);
        uint8_t prefix[2] = {(uint8_t)(len & 0xff), (uint8_t)(len >> 8)};
        fwrite(prefix, 1, 2, stdout);
        fwrite(block, 1, len, stdout);
        at += want;
    }
    return 0;
}
"""


@pytest.mark.skipif(shutil.which("c++") is None, reason="needs a host C++ compiler")
def test_firmware_encoder_matches_audioop_byte_for_byte(tmp_path):
    harness = tmp_path / "harness.cpp"
    harness.write_text(HARNESS)
    binary = tmp_path / "harness"
    subprocess.run(
        ["c++", "-std=c++17", "-O2", "-I", FIRMWARE_SRC, str(harness),
         os.path.join(FIRMWARE_SRC, "MicAdpcm.cpp"), "-o", str(binary)],
        check=True,
    )
    pcm = speech_like()
    out = subprocess.run(
        [str(binary), *map(str, BLOCK_SAMPLES)], input=pcm, capture_output=True, check=True
    ).stdout

    firmware_blocks, offset = [], 0
    while offset < len(out):
        (length,) = struct.unpack_from("<H", out, offset)
        firmware_blocks.append(out[offset + 2:offset + 2 + length])
        offset += 2 + length

    assert firmware_blocks == python_encode(pcm)

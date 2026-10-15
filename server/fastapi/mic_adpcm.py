"""IMA ADPCM microphone uplink from the boards (P2-24).

Raw 16kHz PCM is 256 kbps, and on a phone hotspot that filled the C3's TCP send
queue until TLS had no heap left (2026-10-13). ADPCM is a quarter of that for
0.7% of the C3's CPU. A board that sends it says so when it connects:

    X-Mic-Codec: ima-adpcm

Each binary websocket frame is then one block:

    int16 LE  predicted sample the block starts from
    uint8     step index the block starts from (0-88)
    uint8     flags: bit 0 set when the last low nibble is padding
    ...       4-bit codes, two per byte, first sample in the high nibble

That is the encoder state a block starts with, so every block decodes on its
own: a dropped frame or a reconnect costs that frame and nothing after it. The
codes are audioop's (Intel/DVI IMA): firmware-arduino/src/MicAdpcm.cpp is a
port of its encoder, and tests/test_mic_adpcm.py holds the two to the same
bits.
"""

from __future__ import annotations

# Standard library up to 3.12 (the image runs 3.11); from 3.13 on the
# audioop-lts package provides the same module under the same name.
import audioop
import struct

CODEC_HEADER = "x-mic-codec"
IMA_ADPCM = "ima-adpcm"

_HEADER = struct.Struct("<hBB")
_FLAG_ODD = 0x01


def uses_adpcm(header_value: str | None) -> bool:
    return (header_value or "").strip().lower() == IMA_ADPCM


def decode_block(block: bytes) -> bytes:
    """One block to 16-bit little-endian PCM. Empty for a block that is not one."""
    if len(block) <= _HEADER.size:
        return b""
    predicted, index, flags = _HEADER.unpack_from(block)
    if index > 88:
        return b""
    pcm, _ = audioop.adpcm2lin(block[_HEADER.size:], 2, (predicted, index))
    if flags & _FLAG_ODD:
        pcm = pcm[:-2]
    return pcm


def encode_block(pcm: bytes, state: tuple[int, int] | None) -> tuple[bytes, tuple[int, int]]:
    """The board's side, for tests and tools: PCM to one block, continuing from
    state (None starts fresh). Returns the block and the state to go on with."""
    predicted, index = state or (0, 0)
    odd = (len(pcm) // 2) % 2 == 1
    # audioop drops a trailing odd sample's code; the board pads it instead,
    # so encode one zero sample more and keep the state from before it.
    padded = pcm + b"\x00\x00" if odd else pcm
    codes, after = audioop.lin2adpcm(padded, 2, (predicted, index))
    if odd:
        _, after = audioop.lin2adpcm(pcm, 2, (predicted, index))
        codes = codes[:-1] + bytes([codes[-1] & 0xF0])
    header = _HEADER.pack(predicted, index, _FLAG_ODD if odd else 0)
    return header + codes, after

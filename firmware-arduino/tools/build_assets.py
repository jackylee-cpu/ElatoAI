#!/usr/bin/env python3
"""Pack a brand's sounds into the image for the "assets" partition (P2-12).

    python3 tools/build_assets.py --out .pio/assets.bin
    python3 tools/build_assets.py --brand hkjc --out hkjc.bin boot=hkjc/boot.wav ...

With no sounds named it packs the defaults below. Each WAV goes through the
same resample / trim / normalise as tools/wav_to_sound.py, so a sound sounds
the same whether it is built into the app or read from this partition.

Layout, all little-endian, read by src/Assets.cpp:

    header  32 bytes  "ABAS", u16 version=1, u16 count, u32 payload bytes,
                      u32 CRC-32 of the payload, char brand[16]
    entries 32 bytes each: char name[20] (NUL-terminated), u32 offset from the
                      start of the partition, u32 frames, u32 rate
    data    16-bit mono PCM per entry, each starting on an even offset

The output is only as long as the pack (rounded up to 4KB), so writing it
leaves the rest of the partition alone. It must fit the partition size given
by --size, which defaults to partition_16m.csv's 2MB.
"""

import argparse
import pathlib
import struct
import sys
import zlib

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import wav_to_sound as w  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]

# name -> (wav, rate). Rates follow wav_to_sound.py: speech at 16 kHz.
DEFAULTS = {
    "boot": ("assets/boot-sound.wav", 16000),
    "low_battery": ("assets/low-battery.wav", 16000),
    "wifi_setup": ("assets/wifi/wifi_setup.wav", 16000),
    "wifi_phone": ("assets/wifi/wifi_phone.wav", 16000),
    "wifi_try": ("assets/wifi/wifi_try.wav", 16000),
    "wifi_ok": ("assets/wifi/wifi_ok.wav", 16000),
    "wifi_claim": ("assets/wifi/wifi_claim.wav", 16000),
    "wifi_fail": ("assets/wifi/wifi_fail.wav", 16000),
    "wifi_no_ap": ("assets/wifi/wifi_no_ap.wav", 16000),
}

HEADER = struct.Struct("<4sHHII16s")
ENTRY = struct.Struct("<20sIII")


def pcm_for(path, rate):
    samples, src_rate = w.read_wav(path)
    out = w.shape(w.trim_tail(w.resample(samples, src_rate, rate), rate, w.DEFAULT_TAIL_DB), rate)
    return np.clip(np.round(out), -32768, 32767).astype("<i2").tobytes()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sounds", nargs="*", help="name=path.wav or name=path.wav:rate")
    ap.add_argument("--out", type=pathlib.Path, required=True)
    ap.add_argument("--brand", default="aibuddy")
    ap.add_argument("--size", type=lambda v: int(v, 0), default=0x200000)
    args = ap.parse_args()

    sounds = {}
    for spec in args.sounds:
        name, _, rest = spec.partition("=")
        path, _, rate = rest.partition(":")
        sounds[name] = (path, int(rate or 16000))
    if not sounds:
        sounds = {k: (str(ROOT / p), r) for k, (p, r) in DEFAULTS.items()}

    if len(args.brand.encode()) > 16:
        sys.exit("--brand: at most 16 bytes")
    blobs = []
    for name, (path, rate) in sounds.items():
        if not 0 < len(name.encode()) < 20:
            sys.exit(f"{name}: names are 1-19 bytes")
        data = pcm_for(path, rate)
        blobs.append((name, rate, data))
        print(f"{name:14} {len(data) // 2 / rate:5.2f}s @ {rate} Hz  {len(data) / 1024:6.1f} KB")

    offset = HEADER.size + ENTRY.size * len(blobs)
    table, body = b"", b""
    for name, rate, data in blobs:
        table += ENTRY.pack(name.encode(), offset + len(body), len(data) // 2, rate)
        body += data  # always an even length, so every entry stays aligned
    payload = table + body
    header = HEADER.pack(b"ABAS", 1, len(blobs), len(payload), zlib.crc32(payload), args.brand.encode())
    image = header + payload
    image += b"\xff" * (-len(image) % 4096)
    if len(image) > args.size:
        sys.exit(f"pack is {len(image)} bytes, partition is {args.size}")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(image)
    print(f"{args.out}: {len(blobs)} sounds, {len(image) / 1024:.0f} KB of {args.size / 1024:.0f} KB "
          f"({100 * len(image) / args.size:.0f}%), brand '{args.brand}'")


if __name__ == "__main__":
    main()

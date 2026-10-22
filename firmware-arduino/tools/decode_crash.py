#!/usr/bin/env python3
"""Turn a crash report's addresses into functions and source lines.

The admin Devices page shows each crash's pc and ra (device_crashes). Look
them up in the ELF of the version that crashed:

    tools/decode_crash.py spotpear-ai-toy 1.8.5 0x42012abc 0x42012a80
    tools/decode_crash.py .pio/build/spotpear-ai-toy-localall/firmware.elf 0x42012abc

release_firmware.py publish keeps each release's ELF in release-elf/ (not in
git). A version published before that has none: check out its commit and
build the same environment again, which links the same addresses.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ELF_DIR = ROOT / "release-elf"
ADDR2LINE = Path.home() / ".platformio/packages/toolchain-riscv32-esp/bin/riscv32-esp-elf-addr2line"


def elf_for(board: str, version: str) -> Path:
    return ELF_DIR / f"{board}-{version}.elf"


def main(argv: list[str]) -> int:
    if len(argv) >= 3 and not argv[1].startswith("0x") and not argv[2].startswith("0x"):
        elf, addresses = elf_for(argv[1], argv[2]), argv[3:]
    elif len(argv) >= 2:
        elf, addresses = Path(argv[1]), argv[2:]
    else:
        print(__doc__)
        return 2
    if not elf.exists():
        print(f"{elf} not found. Build that version again (see --help) or pass an ELF path.")
        return 1
    if not addresses:
        print("no addresses given")
        return 2
    if not ADDR2LINE.exists():
        print(f"{ADDR2LINE} not found; build any C3 environment once to install the toolchain")
        return 1
    out = subprocess.run(
        [str(ADDR2LINE), "-pfiaC", "-e", str(elf), *addresses],
        capture_output=True,
        text=True,
        check=False,
    )
    print(out.stdout.strip() or out.stderr.strip())
    return out.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv))

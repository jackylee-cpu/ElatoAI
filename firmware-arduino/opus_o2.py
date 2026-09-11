"""Compile libopus at -O2 while the rest of the firmware stays at -Os.

PlatformIO's base environment puts `-Os` in CCFLAGS (its
`builder/frameworks/_bare.py`) and every library the LDF builds inherits it.
For almost everything here that is the right trade: the ESP32-S3 runs its code
out of flash through a cache, so smaller code is often *faster* code, and the
app partition is 2MB.

The Opus decoder is the exception. It is the one piece of this firmware that
runs a fixed-point DSP inner loop against a hard real-time deadline -- every
40ms packet has to be decoded and in the ring buffer before the I2S DMA runs
dry -- and it is exactly the shape of code (tight loops over int16 arrays,
heavy inlining, no syscalls) that -Os penalises most, because -Os is really
"-O2 minus the transforms that grow code": no loop unrolling, no aggressive
inlining across the small helpers in celt/ and silk/.

So: -O2 for libopus only. Measured cost, 2026-09-11, `esp32-s3-devkitc-1`:
flash 1456261 -> 1469585 bytes, so 13KB, 0.9% more of a 2MB app partition that
was at 69.4%. RAM is unchanged at 67824 bytes. Every other library's code size
is byte-for-byte where it was.

Verify it took effect with `pio run -v`: the 175 compile lines under
.pio/libdeps/<env>/libopus/ should end in -O2, and everything else in -Os.
Whether it is worth *keeping* is a question for the device, not the build log:
the decode has to get measurably faster on hardware to earn the 13KB.
"""

Import("env")  # noqa: F821  (injected by SCons)


def _compile_at_o2(build_env, node):
    """Rebuild one source file's Object() node with -Os swapped for -O2."""
    # GCC takes the last -O on the command line, so appending would be enough.
    # Dropping -Os as well keeps the compile line readable, which matters when
    # the only way to confirm this ran is to read it.
    flags = [flag for flag in build_env["CCFLAGS"] if flag not in ("-Os", "-O0", "-O1")]
    return build_env.Object(node, CCFLAGS=flags + ["-O2"])


# The LDF clones this env for each library and CollectBuildFiles() carries the
# middleware list across the clone, so a pattern registered here reaches
# library sources. The path matched is relative to the project directory:
#   .pio/libdeps/<env>/libopus/src/opus-1.3.1/celt/bands.c
env.AddBuildMiddleware(_compile_at_o2, "*/libopus/*")  # noqa: F821

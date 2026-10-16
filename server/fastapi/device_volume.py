"""Volume changes made in the web app while a board is connected.

The auth frame carries the device's volume, but it is only sent when a session
starts, and a board stays connected until it sleeps -- so a slider move used to
change nothing the parent could hear. The web app now tells the voice server,
and the level reaches the board at once:

- firmware that sends X-Firmware-Version also handles a {"type": "volume"}
  frame (the two arrived together), and gets only that;
- firmware 1.0.1 and earlier ignores that frame. What it does act on mid-session
  is a second "auth" frame, which sets both volume streams there and has no
  other effect that matters on a live session (pitch is re-applied, OTA and
  reset are false, the OTA "server reached" mark is idempotent). Only when the
  pitch factor is 1.0, though: any other value re-runs pitchShift.begin() on the
  network task while the audio task may be inside it. As on every reconnect, a
  level set with the board's buttons wins over it there.

Measured on 62:70 running 1.0.1, 2026-10-16: applied 52ms after the request,
mid-answer.

This used to go out as volume_control on the session's next RESPONSE.COMPLETE,
which every shipped firmware applies, and that was the only route to 1.0.1.
It is gone, not kept as a fallback: the value is picked when the TTS finishes
but reaches the board only after the answer has played, so the whole next
answer was at the old level -- and a change made in that window was undone by
the older value arriving after it. A pending value also outlived its session
when a rebooted board reconnected before the old socket was cleaned up.
"""

from __future__ import annotations

FIRMWARE_HEADER = "x-firmware-version"


def live_frame(volume: int) -> dict:
    return {"type": "volume", "volume_control": volume}


def live_frames(volume: int, firmware_version: str | None, auth_frame: dict) -> list[dict]:
    """What to send a connected board now. `auth_frame` is the session's auth
    frame rebuilt with the new volume (bot.create_esp32_auth_message)."""
    frames = [live_frame(volume)]
    if not firmware_version and auth_frame.get("pitch_factor") == 1.0:
        frames.append(auth_frame)
    return frames

"""Volume changes made in the web app while a board is connected.

The auth frame carries the device's volume, but it is only sent when a session
starts, and a board stays connected until it sleeps -- so a slider move used to
change nothing the parent could hear. The web app now tells the voice server,
and the level reaches the board two ways:

- a {"type": "volume"} frame at once, which firmware with that handler
  (after 1.0.1) applies straight away;
- volume_control on the session's next RESPONSE.COMPLETE, which every firmware
  already shipped applies (Audio.cpp) -- so a board in the field picks the new
  level up from the next answer without an update.

State is in-process, like the session registry it sits next to.
"""

from __future__ import annotations

# Uppercased MAC -> the level still to go out on that board's next
# RESPONSE.COMPLETE. Taken, not read: each change goes out once.
_pending: dict[str, int] = {}


def set_pending(mac: str, volume: int) -> None:
    _pending[mac] = volume


def take(mac: str) -> int | None:
    return _pending.pop(mac, None)


def live_frame(volume: int) -> dict:
    return {"type": "volume", "volume_control": volume}

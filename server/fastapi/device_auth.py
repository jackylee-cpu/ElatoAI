"""Who is on the other end of /ws/esp32.

A board proves itself to the web app with its device secret and gets back a
device token: a JWT, HS256, 24 hours, signed with DEVICE_JWT_SECRET
(frontend-nextjs/lib/deviceAuth.ts issues it). The websocket identity comes
from that token and nothing else. The `X-Device-Mac` header the firmware also
sends is a claim anyone can make, so it is only ever logged.

Verified here with the standard library rather than a JWT package: the token
format is ours, and the only algorithm accepted is HS256, checked before the
signature is -- a token that says "none", or anything else, is refused.

Fails closed: with DEVICE_JWT_SECRET unset, no device gets in.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass

AUDIENCE = "aibuddy-device"


def _configured_secret() -> str:
    # Read per call, not at import: when the server runs from a checkout,
    # bot.py's load_dotenv() fills the environment after this module loads.
    return os.getenv("DEVICE_JWT_SECRET", "")


class InvalidDeviceToken(Exception):
    """The connection did not present a live device token. The message says why."""


@dataclass(frozen=True)
class DeviceIdentity:
    device_id: str
    mac: str


def bearer(authorization: str | None) -> str | None:
    """The token out of an `Authorization: Bearer <token>` header."""
    if not authorization:
        return None
    scheme, _, token = authorization.strip().partition(" ")
    if scheme.lower() != "bearer":
        return None
    return token.strip() or None


def _b64decode(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def verify(
    token: str | None,
    *,
    secret: str | None = None,
    now: float | None = None,
) -> DeviceIdentity:
    """Return the device a token names, or raise InvalidDeviceToken."""
    key = _configured_secret() if secret is None else secret
    if not key:
        raise InvalidDeviceToken("DEVICE_JWT_SECRET is not set")
    if not token:
        raise InvalidDeviceToken("no token")

    parts = token.split(".")
    if len(parts) != 3:
        raise InvalidDeviceToken("malformed token")
    header_b64, payload_b64, signature_b64 = parts
    try:
        header = json.loads(_b64decode(header_b64))
        claims = json.loads(_b64decode(payload_b64))
        signature = _b64decode(signature_b64)
    except (ValueError, binascii.Error):
        raise InvalidDeviceToken("malformed token") from None
    if not isinstance(header, dict) or not isinstance(claims, dict):
        raise InvalidDeviceToken("malformed token")

    if header.get("alg") != "HS256":
        raise InvalidDeviceToken(f"algorithm {header.get('alg')!r} not accepted")
    expected = hmac.new(
        key.encode("utf-8"),
        f"{header_b64}.{payload_b64}".encode("ascii"),
        hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(signature, expected):
        raise InvalidDeviceToken("bad signature")

    exp = claims.get("exp")
    if not isinstance(exp, (int, float)) or isinstance(exp, bool):
        raise InvalidDeviceToken("token has no expiry")
    if exp <= (time.time() if now is None else now):
        raise InvalidDeviceToken("token expired")
    if claims.get("aud") != AUDIENCE or claims.get("typ") != "device":
        raise InvalidDeviceToken("not a device token")

    device_id = claims.get("sub")
    mac = claims.get("mac")
    if not isinstance(device_id, str) or not device_id:
        raise InvalidDeviceToken("token names no device")
    if not isinstance(mac, str) or not mac.strip():
        raise InvalidDeviceToken("token carries no MAC")
    return DeviceIdentity(device_id=device_id, mac=mac.strip().upper())

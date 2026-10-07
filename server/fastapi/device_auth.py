"""Who is on the other end of /ws/esp32 and /ws/nextjs.

Both sockets take their caller's identity from a token the web app signed,
never from anything the client can simply claim:

- A board proves itself to the web app with its device secret and gets back a
  **device token** (24 hours, `aud=aibuddy-device`, names the device). The
  `X-Device-Mac` header the firmware also sends is only ever logged.
- A signed-in parent's browser gets a **web voice token** (5 minutes,
  `aud=aibuddy-web`, names the account) from a server action just before it
  opens /ws/nextjs. The `user_id` the browser used to put on the query string
  is ignored.

frontend-nextjs/lib/deviceAuth.ts issues both, HS256 with DEVICE_JWT_SECRET.
The audience and `typ` keep them apart: a device token never opens a browser
session and the other way round.

Verified here with the standard library rather than a JWT package: the token
format is ours, and the only algorithm accepted is HS256, checked before the
signature is -- a token that says "none", or anything else, is refused.

Fails closed: with DEVICE_JWT_SECRET unset, nobody gets in.
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

DEVICE_AUDIENCE = "aibuddy-device"
WEB_AUDIENCE = "aibuddy-web"


def _configured_secret() -> str:
    # Read per call, not at import: when the server runs from a checkout,
    # bot.py's load_dotenv() fills the environment after this module loads.
    return os.getenv("DEVICE_JWT_SECRET", "")


class InvalidToken(Exception):
    """The connection did not present a live token of the right kind. The message says why."""


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


def _claims(
    token: str | None,
    *,
    audience: str,
    typ: str,
    secret: str | None,
    now: float | None,
) -> dict:
    """The verified claims of a live token for `audience`, or raise InvalidToken."""
    key = _configured_secret() if secret is None else secret
    if not key:
        raise InvalidToken("DEVICE_JWT_SECRET is not set")
    if not token:
        raise InvalidToken("no token")

    parts = token.split(".")
    if len(parts) != 3:
        raise InvalidToken("malformed token")
    header_b64, payload_b64, signature_b64 = parts
    try:
        header = json.loads(_b64decode(header_b64))
        claims = json.loads(_b64decode(payload_b64))
        signature = _b64decode(signature_b64)
    except (ValueError, binascii.Error):
        raise InvalidToken("malformed token") from None
    if not isinstance(header, dict) or not isinstance(claims, dict):
        raise InvalidToken("malformed token")

    if header.get("alg") != "HS256":
        raise InvalidToken(f"algorithm {header.get('alg')!r} not accepted")
    expected = hmac.new(
        key.encode("utf-8"),
        f"{header_b64}.{payload_b64}".encode("ascii"),
        hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(signature, expected):
        raise InvalidToken("bad signature")

    exp = claims.get("exp")
    if not isinstance(exp, (int, float)) or isinstance(exp, bool):
        raise InvalidToken("token has no expiry")
    if exp <= (time.time() if now is None else now):
        raise InvalidToken("token expired")
    if claims.get("aud") != audience or claims.get("typ") != typ:
        raise InvalidToken(f"not a {typ} token")

    subject = claims.get("sub")
    if not isinstance(subject, str) or not subject:
        raise InvalidToken("token names no subject")
    return claims


def verify(
    token: str | None,
    *,
    secret: str | None = None,
    now: float | None = None,
) -> DeviceIdentity:
    """Return the device a device token names, or raise InvalidToken."""
    claims = _claims(token, audience=DEVICE_AUDIENCE, typ="device", secret=secret, now=now)
    mac = claims.get("mac")
    if not isinstance(mac, str) or not mac.strip():
        raise InvalidToken("token carries no MAC")
    return DeviceIdentity(device_id=claims["sub"], mac=mac.strip().upper())


def verify_web(
    token: str | None,
    *,
    secret: str | None = None,
    now: float | None = None,
) -> str:
    """Return the account a web voice token names (its user_id), or raise InvalidToken."""
    return _claims(token, audience=WEB_AUDIENCE, typ="web", secret=secret, now=now)["sub"]

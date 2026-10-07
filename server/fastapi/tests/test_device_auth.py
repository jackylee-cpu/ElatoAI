"""Checks on who gets onto /ws/esp32.

Until the device token, the websocket believed whatever MAC the `X-Device-Mac`
header claimed and only logged the bearer token, so anyone who knew a toy's
MAC could talk as that toy -- and hear the child's memories. Now identity
comes from a signed, expiring device token, and everything else is closed
with 4401.
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import device_auth  # noqa: E402
from device_auth import DeviceIdentity, InvalidDeviceToken  # noqa: E402

SECRET = "test-device-secret-test-device-secret-0123"
DEVICE_ID = "f0f0f0f0-0000-4000-8000-0000000000aa"
MAC = "F8:5B:1B:53:63:64"

# Signed by the web app's own library (jsonwebtoken, as lib/deviceAuth.ts uses
# it), expiring in 2100, so a drift between the two implementations shows up
# here rather than on a toy that will not connect.
NODE_SECRET = "fixture-secret-fixture-secret-fixture-0001"
NODE_TOKEN = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJ0eXAiOiJkZXZpY2UiLCJtYWMiOiJGODo1QjoxQjo1Mzo2Mzo2NCIsImV4cCI6NDEwMjQ0NDgwMCwiaWF0IjoxNzkxMzAwMDAwLCJhdWQiOiJhaWJ1ZGR5LWRldmljZSIsInN1YiI6ImYwZjBmMGYwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDBhYSJ9."
    "VLuhVsKEmMvArdJYRex-MKp55ZzSP2mPKtBAX6tQfMQ"
)


def _b64(data: dict) -> str:
    raw = json.dumps(data, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def sign(claims: dict | None = None, *, secret: str = SECRET, header: dict | None = None, **overrides) -> str:
    body = {
        "typ": "device",
        "mac": MAC,
        "sub": DEVICE_ID,
        "aud": "aibuddy-device",
        "iat": int(time.time()),
        "exp": int(time.time()) + 3600,
    }
    body.update(claims or {})
    body.update(overrides)
    head = _b64(header or {"alg": "HS256", "typ": "JWT"})
    payload = _b64(body)
    sig = hmac.new(secret.encode(), f"{head}.{payload}".encode(), hashlib.sha256).digest()
    return f"{head}.{payload}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"


# ── the verifier ─────────────────────────────────────────────────────────────


def test_accepts_a_live_token():
    assert device_auth.verify(sign(), secret=SECRET) == DeviceIdentity(DEVICE_ID, MAC)


def test_accepts_the_web_apps_own_token():
    assert device_auth.verify(NODE_TOKEN, secret=NODE_SECRET) == DeviceIdentity(DEVICE_ID, MAC)


def test_mac_is_normalised():
    assert device_auth.verify(sign(mac=" f8:5b:1b:53:63:64 "), secret=SECRET).mac == MAC


@pytest.mark.parametrize(
    "token, why",
    [
        (None, "no token"),
        ("", "no token"),
        ("not-a-jwt", "malformed"),
        ("a.b.c", "malformed"),
        (sign(exp=int(time.time()) - 1), "expired"),
        (sign(exp=None), "no expiry"),
        (sign(exp=True), "no expiry"),
        (sign(secret="some-other-secret-entirely-0123456789"), "bad signature"),
        (sign(header={"alg": "none", "typ": "JWT"}), "not accepted"),
        (sign(header={"alg": "HS512", "typ": "JWT"}), "not accepted"),
        (sign(aud="authenticated"), "not a device token"),
        (sign(typ="user"), "not a device token"),
        (sign(sub=""), "names no device"),
        (sign(mac=""), "carries no MAC"),
    ],
)
def test_refuses(token, why):
    with pytest.raises(InvalidDeviceToken, match=why):
        device_auth.verify(token, secret=SECRET)


def test_signature_stripped_to_none_is_refused():
    head, payload, _ = sign().split(".")
    with pytest.raises(InvalidDeviceToken, match="bad signature"):
        device_auth.verify(f"{head}.{payload}.", secret=SECRET)


def test_payload_swapped_under_a_valid_signature_is_refused():
    head, _, sig = sign().split(".")
    _, other_payload, _ = sign(mac="AA:AA:AA:AA:AA:AA").split(".")
    with pytest.raises(InvalidDeviceToken, match="bad signature"):
        device_auth.verify(f"{head}.{other_payload}.{sig}", secret=SECRET)


def test_fails_closed_without_a_secret(monkeypatch):
    monkeypatch.delenv("DEVICE_JWT_SECRET", raising=False)
    with pytest.raises(InvalidDeviceToken, match="not set"):
        device_auth.verify(sign())


@pytest.mark.parametrize(
    "header, token",
    [
        ("Bearer abc.def.ghi", "abc.def.ghi"),
        ("bearer  abc.def.ghi ", "abc.def.ghi"),
        ("Basic abc", None),
        ("Bearer", None),
        ("", None),
        (None, None),
    ],
)
def test_bearer(header, token):
    assert device_auth.bearer(header) == token


# ── the websocket ────────────────────────────────────────────────────────────


@pytest.fixture
def esp32(monkeypatch):
    """The real /ws/esp32 handler, with the database lookup and the bot stubbed."""
    import server
    from device_registry import DevicePersonality

    # After the import: bot.py's load_dotenv(override=True) would undo it.
    monkeypatch.setenv("DEVICE_JWT_SECRET", SECRET)
    looked_up: list[str | None] = []
    sessions: list[dict] = []

    async def fake_lookup(mac):
        looked_up.append(mac)
        return DevicePersonality(volume=55)

    async def fake_bot(*args, **kwargs):
        sessions.append(kwargs)

    monkeypatch.setattr(server, "fetch_device_personality", fake_lookup)
    monkeypatch.setattr(server, "run_bot_session", fake_bot)
    return TestClient(server.app), looked_up, sessions


def _close_code(client, headers):
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect("/ws/esp32", headers=headers) as ws:
            ws.receive_text()
            ws.receive_text()
    return closed.value.code


def test_forged_mac_without_a_token_is_closed_4401(esp32):
    client, looked_up, sessions = esp32
    assert _close_code(client, {"X-Device-Mac": MAC}) == 4401
    assert looked_up == [] and sessions == []


def test_expired_token_is_closed_4401(esp32):
    client, looked_up, sessions = esp32
    expired = sign(exp=int(time.time()) - 60)
    assert _close_code(client, {"Authorization": f"Bearer {expired}", "X-Device-Mac": MAC}) == 4401
    assert looked_up == [] and sessions == []


def test_token_signed_with_another_key_is_closed_4401(esp32):
    client, looked_up, sessions = esp32
    forged = sign(secret="super-secret-jwt-token-with-at-least-32-characters-long")
    assert _close_code(client, {"Authorization": f"Bearer {forged}"}) == 4401
    assert looked_up == [] and sessions == []


def test_live_token_gets_a_session_as_the_device_it_names(esp32):
    client, looked_up, sessions = esp32
    token = sign()
    with client.websocket_connect(
        "/ws/esp32",
        # The header lies; the token decides.
        headers={"Authorization": f"Bearer {token}", "X-Device-Mac": "AA:BB:CC:DD:EE:FF"},
    ) as ws:
        auth = json.loads(ws.receive_text())
    assert auth["type"] == "auth" and auth["volume_control"] == 55
    assert looked_up == [MAC]
    assert len(sessions) == 1

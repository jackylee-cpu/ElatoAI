"""Volume changes from the web app reaching a connected board."""
import json
import os
import sys
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import device_volume  # noqa: E402
from bot import RealtimeOutputControlProcessor  # noqa: E402

MAC = "AA:BB:CC:DD:EE:FF"


class FakeSocket:
    def __init__(self, fail=False, firmware_version=None):
        self.sent: list[dict] = []
        self.fail = fail
        self.state = SimpleNamespace(firmware_version=firmware_version)

    async def send_text(self, text):
        if self.fail:
            raise RuntimeError("socket closed")
        self.sent.append(json.loads(text))


@pytest.fixture(autouse=True)
def clean_pending():
    device_volume._pending.clear()
    yield
    device_volume._pending.clear()


@pytest.fixture
def server_module(monkeypatch):
    import server

    monkeypatch.setattr(server, "INTERNAL_API_TOKEN", "t0ken")
    server._esp32_sessions.clear()
    yield server
    server._esp32_sessions.clear()


@pytest.fixture
def client(server_module):
    return TestClient(server_module.create_app())


def post(client, body, token="t0ken"):
    headers = {"x-internal-token": token} if token else {}
    return client.post("/internal/device_volume", json=body, headers=headers)


def test_requires_internal_token(client):
    assert post(client, {"mac": MAC, "volume": 50}, token=None).status_code == 401


@pytest.mark.parametrize(
    "body",
    [
        {"volume": 50},
        {"mac": MAC},
        {"mac": MAC, "volume": 101},
        {"mac": MAC, "volume": -1},
        {"mac": MAC, "volume": "50"},
        {"mac": MAC, "volume": True},
    ],
)
def test_validates(client, body):
    assert post(client, body).status_code == 400


def test_offline_board_is_a_success_and_leaves_nothing_pending(client):
    response = post(client, {"mac": MAC, "volume": 30})
    assert response.json() == {"ok": True, "sent": 0}
    assert device_volume.take(MAC) is None


def test_connected_board_gets_the_level_now_and_on_the_next_answer(client, server_module):
    socket = FakeSocket(firmware_version="1.0.2")
    server_module._esp32_sessions[MAC].add(socket)

    response = post(client, {"mac": MAC.lower(), "volume": 30})

    assert response.json() == {"ok": True, "sent": 1}
    assert socket.sent == [{"type": "volume", "volume_control": 30}]
    assert device_volume.take(MAC) == 30


def test_firmware_1_0_1_also_gets_a_reauth_it_applies_at_once(client, server_module, monkeypatch):
    # 1.0.1 sends no X-Firmware-Version and ignores {"type": "volume"}; without
    # the auth frame it heard the level only after the next answer had played.
    monkeypatch.delenv("ESP32_DEFAULT_PITCH_FACTOR", raising=False)
    socket = FakeSocket()
    server_module._esp32_sessions[MAC].add(socket)

    response = post(client, {"mac": MAC, "volume": 30})

    assert response.json() == {"ok": True, "sent": 1}
    assert socket.sent == [
        {"type": "volume", "volume_control": 30},
        {
            "type": "auth",
            "volume_control": 30,
            "pitch_factor": 1.0,
            "is_ota": False,
            "is_reset": False,
        },
    ]
    assert device_volume.take(MAC) == 30


def test_no_reauth_when_it_would_restart_the_pitch_shifter(client, server_module, monkeypatch):
    monkeypatch.setenv("ESP32_DEFAULT_PITCH_FACTOR", "1.2")
    socket = FakeSocket()
    server_module._esp32_sessions[MAC].add(socket)

    post(client, {"mac": MAC, "volume": 30})

    assert socket.sent == [{"type": "volume", "volume_control": 30}]
    assert device_volume.take(MAC) == 30


def test_a_dead_socket_does_not_fail_the_request(client, server_module):
    server_module._esp32_sessions[MAC].add(FakeSocket(fail=True))
    response = post(client, {"mac": MAC, "volume": 30})
    assert response.status_code == 200
    assert response.json()["sent"] == 0


async def finish(processor) -> dict:
    pushed = []

    async def capture(frame, direction=None):
        pushed.append(frame)

    processor.push_frame = capture
    processor._completed_for_turn = False
    await processor._finish_response("test")
    return pushed[-1].message


async def test_response_complete_carries_a_pending_volume_once():
    device_volume.set_pending(MAC, 40)
    processor = RealtimeOutputControlProcessor(
        mute_stt_while_speaking=False,
        take_volume_update=lambda: device_volume.take(MAC),
    )

    first = await finish(processor)
    second = await finish(processor)

    assert first == {"type": "server", "msg": "RESPONSE.COMPLETE", "volume_control": 40}
    assert second == {"type": "server", "msg": "RESPONSE.COMPLETE"}

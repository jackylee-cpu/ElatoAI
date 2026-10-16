"""Remote Wi-Fi management relay (R-37).

The board answers over its own socket, so these stand in a fake socket that
records what the server sent and lets the test play the board's reply.
"""
import asyncio
import json
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import device_wifi  # noqa: E402
from esp32_transport import RawPCMFrameSerializer  # noqa: E402

MAC = "AA:BB:CC:DD:EE:FF"
SECRET = "hunter2-very-secret"


class FakeSocket:
    def __init__(self, fail=False):
        self.sent: list[dict] = []
        self.fail = fail

    async def send_text(self, text):
        if self.fail:
            raise RuntimeError(f"socket closed while sending {text}")
        self.sent.append(json.loads(text))


@pytest.fixture
def logs():
    """Everything loguru writes during the test. caplog cannot see loguru."""
    from loguru import logger

    lines: list[str] = []
    sink = logger.add(lambda message: lines.append(str(message)), level="DEBUG")
    yield lines
    logger.remove(sink)


@pytest.fixture(autouse=True)
def clean_boards():
    device_wifi._boards.clear()
    yield
    device_wifi._boards.clear()


def board_replies(socket, **reply):
    """Answer the last request the server sent, as the board would."""
    async def answer():
        while not socket.sent:
            await asyncio.sleep(0)
        request = socket.sent[-1]
        device_wifi.handle_device_message(MAC, {"type": "wifi_result", "id": request["id"], **reply})
    return asyncio.create_task(answer())


STATUS = {
    "current": {"ssid": "Home", "rssi": -48},
    "saved": [{"ssid": "Home", "joined": True}, {"ssid": "Phone", "joined": False}],
    "max": 8,
}


def test_offline_board_reports_offline():
    result = asyncio.run(device_wifi.request(MAC, "status"))
    assert result["ok"] is False and result["error"] == "offline"
    assert result["online"] is False


async def test_add_round_trip_relays_password_and_caches_names_only(logs):
    socket = FakeSocket()
    device_wifi.register(MAC, socket)
    task = board_replies(socket, ok=True, **STATUS)

    result = await device_wifi.request(MAC, "add", ssid="Phone", password=SECRET)
    await task

    assert socket.sent[0]["op"] == "add"
    assert socket.sent[0]["password"] == SECRET  # the board does need it
    assert result["ok"] is True and result["online"] is True
    assert result["status"]["saved"][1] == {"ssid": "Phone", "joined": False}
    # Nothing kept or returned carries the password.
    assert SECRET not in json.dumps(device_wifi.snapshot(MAC))
    assert SECRET not in json.dumps(result)
    assert logs and SECRET not in "".join(logs)


async def test_board_error_is_passed_on():
    socket = FakeSocket()
    device_wifi.register(MAC, socket)
    task = board_replies(socket, ok=False, error="current", **STATUS)
    result = await device_wifi.request(MAC, "delete", ssid="Home")
    await task
    assert result == {**device_wifi.snapshot(MAC), "ok": False, "error": "current"}


async def test_timeout(monkeypatch):
    monkeypatch.setattr(device_wifi, "REQUEST_TIMEOUT_S", 0.05)
    device_wifi.register(MAC, FakeSocket())
    result = await device_wifi.request(MAC, "status")
    assert result["ok"] is False and result["error"] == "timeout"
    assert device_wifi._boards[MAC].pending == {}


async def test_send_failure_does_not_log_the_payload(logs):
    device_wifi.register(MAC, FakeSocket(fail=True))
    result = await device_wifi.request(MAC, "add", ssid="Phone", password=SECRET)
    assert result["error"] == "offline"
    assert logs and SECRET not in "".join(logs)


async def test_disconnect_fails_waiters_at_once():
    socket = FakeSocket()
    device_wifi.register(MAC, socket)
    pending = asyncio.create_task(device_wifi.request(MAC, "scan"))
    while not socket.sent:
        await asyncio.sleep(0)
    device_wifi.unregister(MAC, socket)
    result = await asyncio.wait_for(pending, 1)
    assert result["error"] == "offline" and result["online"] is False


async def test_switch_is_answered_before_the_board_moves():
    socket = FakeSocket()
    device_wifi.register(MAC, socket)
    task = board_replies(socket, ok=True, switching=True, **STATUS)
    result = await device_wifi.request(MAC, "switch", ssid="Phone")
    await task
    assert socket.sent[0]["op"] == "switch" and socket.sent[0]["ssid"] == "Phone"
    assert "password" not in socket.sent[0]
    assert result["ok"] is True and result["switching"] is True
    assert result["last_switch"] is None


async def test_switch_refused_by_the_board_is_not_switching():
    socket = FakeSocket()
    device_wifi.register(MAC, socket)
    task = board_replies(socket, ok=False, error="current", **STATUS)
    result = await device_wifi.request(MAC, "switch", ssid="Home")
    await task
    assert result["ok"] is False and result["error"] == "current"
    assert "switching" not in result


def test_switch_result_arrives_with_the_next_report_and_outlives_it():
    device_wifi.handle_device_message(MAC, {
        "type": "wifi_status",
        **STATUS,
        "last_switch": {"ssid": "Phone", "ok": False, "error": "not_found", "back": "Home", "junk": 1},
    })
    first = device_wifi.snapshot(MAC)["last_switch"]
    assert {k: v for k, v in first.items() if k != "at"} == {
        "ssid": "Phone", "ok": False, "error": "not_found", "back": "Home",
    }
    assert first["at"] >= device_wifi.snapshot(MAC)["status_at"] - 1

    # A later report without one leaves it alone: the page may not have looked yet.
    device_wifi.handle_device_message(MAC, {"type": "wifi_status", **STATUS})
    assert device_wifi.snapshot(MAC)["last_switch"] == first

    device_wifi.handle_device_message(MAC, {
        "type": "wifi_status", **STATUS, "last_switch": {"ssid": "Phone", "ok": True, "error": "x"},
    })
    second = device_wifi.snapshot(MAC)["last_switch"]
    assert second["ok"] is True and "error" not in second and "back" not in second


def test_malformed_switch_result_is_dropped():
    device_wifi.handle_device_message(MAC, {"type": "wifi_status", **STATUS, "last_switch": "yes"})
    device_wifi.handle_device_message(MAC, {"type": "wifi_status", **STATUS, "last_switch": {"ok": True}})
    assert device_wifi.snapshot(MAC)["last_switch"] is None


def test_endpoint_relays_switch_without_a_password(client, monkeypatch):
    seen = {}

    async def fake_request(mac, op, **fields):
        seen.update(mac=mac, op=op, fields=fields)
        return {"ok": True, "switching": True}

    monkeypatch.setattr(device_wifi, "request", fake_request)
    response = client.post(
        "/internal/device_wifi",
        json={"mac": MAC.lower(), "op": "switch", "ssid": "Phone", "password": "ignored-pass"},
        headers={"x-internal-token": "t0ken"},
    )
    assert response.status_code == 200 and response.json()["switching"] is True
    assert seen == {"mac": MAC, "op": "switch", "fields": {"ssid": "Phone"}}


def test_unprompted_status_is_cached_and_cleaned():
    device_wifi.handle_device_message(
        MAC.lower(),
        {
            "type": "wifi_status",
            **STATUS,
            "saved": STATUS["saved"] + [{"ssid": 5}, "junk"],
            "password": "should-not-stick",
        },
    )
    snap = device_wifi.snapshot(MAC)
    assert snap["online"] is False
    assert snap["status"] == STATUS
    assert "should-not-stick" not in json.dumps(snap)


async def test_serializer_keeps_wifi_messages_out_of_the_pipeline():
    seen = []
    serializer = RawPCMFrameSerializer(
        16000, on_control=lambda m: seen.append(m) or device_wifi.handle_device_message(MAC, m)
    )
    assert await serializer.deserialize(json.dumps({"type": "wifi_status", **STATUS})) is None
    frame = await serializer.deserialize(json.dumps({"type": "instruction", "msg": "end_of_speech"}))
    assert frame is not None and frame.message["msg"] == "end_of_speech"
    assert len(seen) == 2


@pytest.fixture
def client(monkeypatch):
    import server

    monkeypatch.setattr(server, "INTERNAL_API_TOKEN", "t0ken")
    return TestClient(server.create_app())


def test_endpoint_requires_internal_token(client):
    response = client.post("/internal/device_wifi", json={"mac": MAC, "op": "status"})
    assert response.status_code == 401


@pytest.mark.parametrize(
    "body",
    [
        {"mac": MAC, "op": "explode"},
        {"op": "status"},
        {"mac": MAC, "op": "add", "ssid": ""},
        {"mac": MAC, "op": "add", "ssid": "x" * 33},
        {"mac": MAC, "op": "add", "ssid": "Home", "password": "short"},
        {"mac": MAC, "op": "delete"},
        {"mac": MAC, "op": "switch"},
        {"mac": MAC, "op": "switch", "ssid": "x" * 33},
    ],
)
def test_endpoint_validates(client, body):
    response = client.post(
        "/internal/device_wifi", json=body, headers={"x-internal-token": "t0ken"}
    )
    assert response.status_code == 400
    if "password" in body:
        assert body["password"] not in response.text


def test_endpoint_status_of_sleeping_board_returns_last_list(client):
    device_wifi.handle_device_message(MAC, {"type": "wifi_status", **STATUS})
    response = client.post(
        "/internal/device_wifi",
        json={"mac": MAC.lower(), "op": "status"},
        headers={"x-internal-token": "t0ken"},
    )
    body = response.json()
    assert response.status_code == 200
    assert body["ok"] is True and body["online"] is False
    assert body["status"] == STATUS


def test_endpoint_peek_never_contacts_the_board(client):
    socket = FakeSocket()
    device_wifi.register(MAC, socket)
    device_wifi.handle_device_message(MAC, {"type": "wifi_status", **STATUS})
    response = client.post(
        "/internal/device_wifi",
        json={"mac": MAC, "op": "peek"},
        headers={"x-internal-token": "t0ken"},
    )
    assert response.json() == {**device_wifi.snapshot(MAC), "ok": True}
    assert response.json()["online"] is True
    assert socket.sent == []


def post_status(client, **extra):
    return client.post(
        "/internal/device_wifi",
        json={"mac": MAC, "op": "status", **extra},
        headers={"x-internal-token": "t0ken"},
    )


def test_endpoint_status_answers_from_a_recent_report_without_the_board(client):
    socket = FakeSocket()
    device_wifi.register(MAC, socket)
    device_wifi.handle_device_message(MAC, {"type": "wifi_status", **STATUS})
    body = post_status(client).json()
    assert body["ok"] is True and body["online"] is True and body["status"] == STATUS
    assert socket.sent == []


def test_endpoint_status_asks_the_board_when_the_report_is_old_or_fresh_is_asked(
    client, monkeypatch
):
    socket = FakeSocket()
    device_wifi.register(MAC, socket)
    device_wifi.handle_device_message(MAC, {"type": "wifi_status", **STATUS})

    async def ask(mac, op, **fields):
        return {**device_wifi.snapshot(mac), "ok": True, "asked": op}

    monkeypatch.setattr(device_wifi, "request", ask)
    assert post_status(client, fresh=True).json()["asked"] == "status"

    board = device_wifi._boards[MAC]
    board.status_at -= device_wifi.STATUS_MAX_AGE_S + 1
    assert post_status(client).json()["asked"] == "status"


def test_a_report_from_an_earlier_connection_is_not_fresh():
    device_wifi.handle_device_message(MAC, {"type": "wifi_status", **STATUS})
    device_wifi._boards[MAC].status_at -= 5
    device_wifi.register(MAC, FakeSocket())
    assert device_wifi.status_is_fresh(MAC) is False
    device_wifi.handle_device_message(MAC, {"type": "wifi_status", **STATUS})
    assert device_wifi.status_is_fresh(MAC) is True


def test_presence_lists_known_boards_with_online_and_since():
    other = "11:22:33:44:55:66"
    socket = FakeSocket()
    device_wifi.register(MAC, socket)
    device_wifi.handle_device_message(other, {"type": "wifi_status", **STATUS})

    presence = device_wifi.presence()
    assert presence[MAC]["online"] is True
    assert isinstance(presence[MAC]["connected_at"], float)
    assert presence[other]["online"] is False
    assert presence[other]["connected_at"] is None
    assert presence[other]["status"] == STATUS

    device_wifi.unregister(MAC, socket)
    assert device_wifi.presence()[MAC] == {
        "online": False, "status": None, "status_at": None, "last_switch": None,
        "reports_wifi": None,
        "connected_at": None,
    }


def test_presence_since_survives_a_second_socket():
    first, second = FakeSocket(), FakeSocket()
    device_wifi.register(MAC, first)
    since = device_wifi.presence()[MAC]["connected_at"]
    device_wifi.register(MAC, second)
    device_wifi.unregister(MAC, first)
    assert device_wifi.presence()[MAC]["connected_at"] == since


def test_presence_endpoint_requires_token_and_returns_boards(client):
    assert client.post("/internal/devices_presence").status_code == 401
    device_wifi.register(MAC, FakeSocket())
    response = client.post(
        "/internal/devices_presence", headers={"x-internal-token": "t0ken"}
    )
    body = response.json()
    assert response.status_code == 200
    assert body["ok"] is True
    assert body["devices"][MAC]["online"] is True


async def test_old_firmware_is_refused_at_once_instead_of_timing_out():
    socket = FakeSocket()
    device_wifi.register(MAC, socket)
    assert device_wifi.snapshot(MAC)["reports_wifi"] is None  # just connected
    device_wifi._boards[MAC].connected_at -= device_wifi.REPORT_GRACE_S + 1

    result = await device_wifi.request(MAC, "status")
    assert result["ok"] is False and result["error"] == "unsupported"
    assert result["reports_wifi"] is False
    assert socket.sent == []


def test_a_report_on_this_connection_means_the_firmware_reports():
    device_wifi.register(MAC, FakeSocket())
    device_wifi._boards[MAC].connected_at -= device_wifi.REPORT_GRACE_S + 1
    device_wifi.handle_device_message(MAC, {"type": "wifi_status", **STATUS})
    assert device_wifi.snapshot(MAC)["reports_wifi"] is True


def test_an_asleep_board_cannot_be_judged():
    device_wifi.handle_device_message(MAC, {"type": "wifi_status", **STATUS})
    assert device_wifi.snapshot(MAC)["reports_wifi"] is None


async def test_reports_are_recorded_once_per_change(monkeypatch):
    written: list[dict] = []

    async def record(mac, status):
        written.append(status)
        return True

    monkeypatch.setattr(device_wifi, "_record", record)
    device_wifi.handle_device_message(MAC, {"type": "wifi_status", **STATUS})
    await asyncio.gather(*device_wifi._tasks)
    device_wifi.handle_device_message(MAC, {"type": "wifi_status", **STATUS})
    await asyncio.gather(*device_wifi._tasks)
    moved = {**STATUS, "current": {"ssid": "Phone", "rssi": -60}}
    device_wifi.handle_device_message(MAC, {"type": "wifi_status", **moved})
    await asyncio.gather(*device_wifi._tasks)

    assert [w["current"]["ssid"] for w in written] == ["Home", "Phone"]
    assert all("password" not in json.dumps(w) for w in written)


async def test_a_failed_write_is_tried_again_with_the_next_report(monkeypatch):
    results = [False, True]
    calls: list[str] = []

    async def record(mac, status):
        calls.append(mac)
        return results.pop(0)

    monkeypatch.setattr(device_wifi, "_record", record)
    for _ in range(2):
        device_wifi.handle_device_message(MAC, {"type": "wifi_status", **STATUS})
        await asyncio.gather(*device_wifi._tasks)
    assert calls == [MAC, MAC]


async def test_record_sends_names_to_the_rpc_and_reads_its_answer(monkeypatch):
    sent: dict = {}

    class Response:
        status = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def json(self):
            return True

        async def text(self):
            return "true"

    class Session:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def post(self, url, json, headers):
            sent.update(url=url, json=json)
            return Response()

    monkeypatch.setattr(device_wifi, "SUPABASE_URL", "http://db")
    monkeypatch.setattr(device_wifi, "SUPABASE_SERVICE_ROLE_KEY", "k")
    monkeypatch.setattr(device_wifi.aiohttp, "ClientSession", Session)
    assert await device_wifi._record(MAC, device_wifi._clean_status(STATUS)) is True
    assert sent["url"] == "http://db/rest/v1/rpc/record_device_wifi"
    assert sent["json"] == {
        "p_mac": MAC,
        "p_current_ssid": "Home",
        "p_current_rssi": -48,
        "p_saved": STATUS["saved"],
        "p_max_saved": 8,
    }

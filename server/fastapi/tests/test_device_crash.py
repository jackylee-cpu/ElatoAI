"""Crash reports from boards to device_crashes, and the ack back."""
import asyncio
import json
import os
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import device_crash  # noqa: E402

MAC = "AA:BB:CC:DD:EE:FF"
REPORT = {
    "type": "crash",
    "id": 3735928559,
    "count": 2,
    "reason": "panic",
    "fw": "1.8.4",
    "pc": "0x42012abc",
    "ra": "0x42012a80",
    "uptime_s": 1234,
    "task": "network",
    "detail": "Store access fault",
}


class FakeSocket:
    def __init__(self, device_id="dev-1"):
        self.state = SimpleNamespace(device_id=device_id)
        self.sent: list[str] = []

    async def send_text(self, text):
        self.sent.append(text)


def test_a_full_report_becomes_a_row():
    row = device_crash.clean(REPORT, MAC, "dev-1")
    assert row == {
        "mac_address": MAC,
        "device_id": "dev-1",
        "report_id": 3735928559,
        "crash_count": 2,
        "reason": "panic",
        "firmware_version": "1.8.4",
        "pc": "0x42012abc",
        "ra": "0x42012a80",
        "uptime_s": 1234,
        "task": "network",
        "detail": "Store access fault",
    }


def test_a_brownout_has_no_location():
    row = device_crash.clean({"type": "crash", "id": 7, "count": 1, "reason": "brownout", "fw": "1.8.4"}, MAC, None)
    assert row["reason"] == "brownout"
    assert row["pc"] is None and row["ra"] is None and row["task"] is None


@pytest.mark.parametrize(
    "change",
    [
        {"reason": "meltdown"},
        {"reason": None},
        {"id": -1},
        {"id": "7"},
        {"id": True},
        {"count": 0},
        {"count": None},
    ],
)
def test_malformed_reports_are_dropped(change):
    assert device_crash.clean({**REPORT, **change}, MAC, None) is None


@pytest.mark.parametrize(
    "field, value",
    [
        ("pc", "0x4201"),
        ("pc", "42012abc"),
        ("pc", "0x42012ABZ"),
        ("ra", 1234),
        ("fw", "1.8.4; drop table"),
        ("fw", 184),
        ("uptime_s", -5),
        ("uptime_s", "12"),
    ],
)
def test_bad_optional_fields_are_left_out(field, value):
    row = device_crash.clean({**REPORT, field: value}, MAC, None)
    column = {"fw": "firmware_version"}.get(field, field)
    assert row[column] is None
    assert row["reason"] == "panic"


def test_text_is_trimmed_and_printable():
    row = device_crash.clean({**REPORT, "task": "net\x00work\nxxxxxxxxxxxxxxxxxx", "detail": "x" * 200}, MAC, None)
    assert row["task"] == "networkxxxxxxxxx"
    assert len(row["detail"]) == 64


def run(socket, message, store_result=True, monkeypatch=None):
    stored = []

    async def fake_store(row):
        stored.append(row)
        return store_result

    monkeypatch.setattr(device_crash, "store", fake_store)

    async def go():
        handled = device_crash.handle_device_message(socket, MAC.lower(), message)
        await asyncio.sleep(0.01)
        return handled

    return asyncio.run(go()), stored


def test_stored_report_is_acked(monkeypatch):
    socket = FakeSocket()
    handled, stored = run(socket, REPORT, monkeypatch=monkeypatch)
    assert handled is True
    assert stored[0]["mac_address"] == MAC and stored[0]["device_id"] == "dev-1"
    assert [json.loads(t) for t in socket.sent] == [{"type": "crash_ack", "id": 3735928559}]


def test_failed_store_sends_no_ack(monkeypatch):
    # Without the ack the board keeps the report and sends it next session.
    socket = FakeSocket()
    _, stored = run(socket, REPORT, store_result=False, monkeypatch=monkeypatch)
    assert stored and socket.sent == []


def test_malformed_report_is_swallowed(monkeypatch):
    socket = FakeSocket()
    handled, stored = run(socket, {"type": "crash", "reason": "panic"}, monkeypatch=monkeypatch)
    assert handled is True and stored == [] and socket.sent == []


def test_other_messages_pass_through():
    assert device_crash.handle_device_message(FakeSocket(), MAC, {"type": "power", "low": True}) is False


def test_store_is_a_no_op_without_supabase(monkeypatch):
    monkeypatch.setattr(device_crash, "SUPABASE_URL", "")
    assert asyncio.run(device_crash.store(device_crash.clean(REPORT, MAC, None))) is False


def test_the_esp32_serializer_keeps_crash_out_of_the_pipeline(monkeypatch):
    import server
    from esp32_transport import RawPCMFrameSerializer

    stored = []

    async def fake_store(row):
        stored.append(row)
        return True

    monkeypatch.setattr(device_crash, "store", fake_store)
    socket = FakeSocket()
    transport = server.create_esp32_transport(websocket=socket, mac=MAC)
    serializer = transport._params.serializer
    assert isinstance(serializer, RawPCMFrameSerializer)

    async def go():
        frame = await serializer.deserialize(json.dumps(REPORT))
        await asyncio.sleep(0.01)
        return frame

    assert asyncio.run(go()) is None
    assert stored[0]["report_id"] == REPORT["id"]
    assert json.loads(socket.sent[0])["type"] == "crash_ack"

"""Online / asleep / gone, from the board's sessions to its devices row."""
import asyncio
import os
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import device_connection  # noqa: E402

MAC = "AA:BB:CC:DD:EE:FF"


def socket():
    return SimpleNamespace(state=SimpleNamespace())


@pytest.fixture
def writes(monkeypatch):
    seen: list[tuple[str, dict, str | None]] = []

    async def fake_write(mac, row, session_started=None):
        seen.append((mac, row, session_started))
        return True

    monkeypatch.setattr(device_connection, "write", fake_write)
    return seen


def run(fn):
    async def go():
        fn()
        await asyncio.sleep(0)

    asyncio.run(go())


@pytest.mark.parametrize(
    "header, expected",
    [("bye", True), ("bye, other", True), ("other,BYE", True), ("", False), (None, False), ("byebye", False)],
)
def test_caps_header(header, expected):
    assert device_connection.says_bye(header) is expected


def test_connect_marks_the_board_online(writes):
    ws = socket()
    run(lambda: device_connection.connected(MAC.lower(), ws, "bye"))
    mac, row, guard = writes[0]
    assert mac == MAC
    assert row["connected_at"] == ws.state.session_started_at
    assert row["disconnected_at"] is None and row["disconnect_reason"] is None
    assert guard is None


@pytest.mark.parametrize("reason", sorted(device_connection.BOARD_REASONS))
def test_bye_then_close_records_the_boards_reason(writes, reason):
    ws = socket()
    run(lambda: device_connection.connected(MAC, ws, "bye"))
    assert device_connection.handle_device_message(ws, {"type": "bye", "reason": reason}) is True
    run(lambda: device_connection.disconnected(MAC, ws))
    _, row, guard = writes[-1]
    assert row["disconnect_reason"] == reason
    assert row["disconnected_at"]
    # Only lands while this session is still the board's latest.
    assert guard == ws.state.session_started_at


def test_close_without_bye_is_lost(writes):
    ws = socket()
    run(lambda: device_connection.connected(MAC, ws, "bye"))
    run(lambda: device_connection.disconnected(MAC, ws))
    assert writes[-1][1]["disconnect_reason"] == "lost"


def test_old_firmware_closes_are_unknown(writes):
    # 1.1.0 and older sleep without a word; that is not "lost".
    ws = socket()
    run(lambda: device_connection.connected(MAC, ws, None))
    run(lambda: device_connection.disconnected(MAC, ws))
    assert writes[-1][1]["disconnect_reason"] == "unknown"


@pytest.mark.parametrize("reason", ["", "hacked", None, 3])
def test_unknown_bye_reason_counts_as_no_bye(writes, reason):
    ws = socket()
    run(lambda: device_connection.connected(MAC, ws, "bye"))
    assert device_connection.handle_device_message(ws, {"type": "bye", "reason": reason}) is True
    run(lambda: device_connection.disconnected(MAC, ws))
    assert writes[-1][1]["disconnect_reason"] == "lost"


def test_other_messages_pass_through():
    assert device_connection.handle_device_message(socket(), {"type": "power", "low": True}) is False


def test_bye_without_a_socket_is_swallowed():
    # create_esp32_transport(websocket=None) in tests.
    assert device_connection.handle_device_message(None, {"type": "bye", "reason": "sleep_idle"}) is True


def test_disconnect_without_connect_writes_nothing(writes):
    run(lambda: device_connection.disconnected(MAC, socket()))
    assert writes == []


def test_write_guards_on_the_session(monkeypatch):
    queries = []

    async def fake_patch(key, query, row):
        queries.append(query)
        return True

    monkeypatch.setattr(device_connection, "_patch", fake_patch)
    started = "2026-10-16T08:00:00.123456+00:00"
    asyncio.run(device_connection.write(MAC, {"disconnect_reason": "lost"}, started))
    assert queries == [
        "mac_address=ilike.AA%3ABB%3ACC%3ADD%3AEE%3AFF"
        "&connected_at=eq.2026-10-16T08%3A00%3A00.123456%2B00%3A00"
    ]


def test_stale_sessions_are_closed_as_server_restart(monkeypatch):
    calls = []

    async def fake_patch(key, query, row):
        calls.append((query, row))
        return True

    monkeypatch.setattr(device_connection, "_patch", fake_patch)
    asyncio.run(device_connection.close_stale_sessions())
    query, row = calls[0]
    assert query == "connected_at=not.is.null&disconnected_at=is.null"
    assert row["disconnect_reason"] == "server_restart"


def test_write_is_a_no_op_without_supabase(monkeypatch):
    monkeypatch.setattr(device_connection, "SUPABASE_URL", "")
    assert asyncio.run(device_connection.write(MAC, {"disconnect_reason": "lost"})) is False


def test_the_esp32_serializer_keeps_bye_out_of_the_pipeline():
    import server
    from esp32_transport import RawPCMFrameSerializer

    ws = socket()
    transport = server.create_esp32_transport(websocket=ws, mac=MAC)
    serializer = transport._params.serializer
    assert isinstance(serializer, RawPCMFrameSerializer)
    frame = asyncio.run(serializer.deserialize('{"type":"bye","reason":"sleep_idle"}'))
    assert frame is None
    assert ws.state.bye_reason == "sleep_idle"

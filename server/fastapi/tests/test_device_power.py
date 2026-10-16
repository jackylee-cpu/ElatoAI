"""Battery state from the board to its devices row (R-41)."""
import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import device_power  # noqa: E402
from esp32_transport import RawPCMFrameSerializer  # noqa: E402

MAC = "AA:BB:CC:DD:EE:FF"


def test_low_only_from_a_board_without_battery_sense():
    row = device_power.clean({"type": "power", "low": True})
    assert row["battery_low"] is True
    # Not "not charging": the Spotpear board cannot tell, so unknown.
    assert row["battery_percent"] is None
    assert row["battery_charging"] is None
    assert row["battery_full"] is None
    assert row["battery_at"]


def test_percent_and_charging_from_a_board_with_battery_sense():
    row = device_power.clean({"type": "power", "low": False, "percent": 72, "charging": True})
    assert (row["battery_low"], row["battery_percent"], row["battery_charging"]) == (False, 72, True)
    # Firmware up to 1.1.0 sends no "full".
    assert row["battery_full"] is None


def test_full_from_a_board_that_senses_it():
    row = device_power.clean(
        {"type": "power", "low": False, "percent": 98, "charging": False, "full": True}
    )
    assert (row["battery_charging"], row["battery_full"]) == (False, True)


def test_charging_and_full_without_a_percentage():
    # A board with only the charger's outputs wired (no cell divider).
    row = device_power.clean({"type": "power", "low": False, "charging": True, "full": False})
    assert row["battery_percent"] is None
    assert (row["battery_charging"], row["battery_full"]) == (True, False)


@pytest.mark.parametrize("value", [1, "true", None, 0])
def test_non_bool_charging_and_full_are_unknown(value):
    row = device_power.clean({"type": "power", "low": False, "charging": value, "full": value})
    assert row["battery_charging"] is None
    assert row["battery_full"] is None


@pytest.mark.parametrize(
    "message",
    [
        {"type": "power"},
        {"type": "power", "low": "yes"},
        {"type": "power", "low": 1},
    ],
)
def test_malformed_low_is_dropped(message):
    assert device_power.clean(message) is None


@pytest.mark.parametrize("percent", [-1, 101, "50", 50.5, True])
def test_bad_percent_is_left_out(percent):
    row = device_power.clean({"type": "power", "low": False, "percent": percent, "charging": True})
    assert row["battery_percent"] is None
    # The rest of the report still counts.
    assert row["battery_charging"] is True


def test_only_known_columns_are_written():
    row = device_power.clean({"type": "power", "low": False, "user_id": "someone-else", "mac_address": "x"})
    assert set(row) == {
        "battery_low",
        "battery_percent",
        "battery_charging",
        "battery_full",
        "battery_at",
    }


def test_other_messages_pass_through():
    assert device_power.handle_device_message(MAC, {"type": "instruction"}) is False


def test_power_message_is_written_in_the_background(monkeypatch):
    written: list[tuple[str, dict]] = []

    async def fake_write(mac, row):
        written.append((mac, row))
        return True

    monkeypatch.setattr(device_power, "write", fake_write)

    async def run():
        assert device_power.handle_device_message(MAC.lower(), {"type": "power", "low": True}) is True
        await asyncio.sleep(0)

    asyncio.run(run())
    assert written == [(MAC, written[0][1])]
    assert written[0][1]["battery_low"] is True


def test_malformed_power_message_is_swallowed_not_written(monkeypatch):
    called = []
    monkeypatch.setattr(device_power, "write", lambda *a: called.append(a))

    async def run():
        assert device_power.handle_device_message(MAC, {"type": "power", "low": "nope"}) is True

    asyncio.run(run())
    assert called == []


def test_write_is_a_no_op_without_supabase(monkeypatch):
    monkeypatch.setattr(device_power, "SUPABASE_URL", "")
    row = device_power.clean({"type": "power", "low": True})
    assert asyncio.run(device_power.write(MAC, row)) is False


def test_the_esp32_serializer_keeps_power_out_of_the_pipeline(monkeypatch):
    seen = []

    async def fake_write(mac, row):
        seen.append(mac)
        return True

    monkeypatch.setattr(device_power, "write", fake_write)
    import server

    transport = server.create_esp32_transport(websocket=None, mac=MAC)
    serializer = transport._params.serializer

    async def run():
        frame = await serializer.deserialize('{"type":"power","low":false}')
        await asyncio.sleep(0)
        return frame

    assert isinstance(serializer, RawPCMFrameSerializer)
    assert asyncio.run(run()) is None
    assert seen == [MAC]

"""personalities.tts_speed reaches MiniMax's voice_setting.speed.

The voice server used to ask for speed 1.0 on every session. The speed is now
per character; these pin that the row's value survives parsing, that a value
MiniMax would refuse is dropped rather than sent, and that it lands in the
websocket's task_start.
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("MINIMAX_API_KEY", "test-key")
os.environ.setdefault("MINIMAX_GROUP_ID", "test-group")

import device_registry
from models.tts.minimax import create_service


def _row(speed):
    return {"user": {"personality": {"title": "Pepa", "tts_speed": speed}}}


@pytest.mark.parametrize("speed", [0.5, 0.85, 1, 2.0])
def test_a_speed_in_range_is_kept(speed):
    assert device_registry._parse(_row(speed)).tts_speed == float(speed)


@pytest.mark.parametrize("speed", [0.49, 2.01, 0, True, "0.8", None])
def test_a_speed_minimax_would_refuse_is_dropped(speed):
    assert device_registry._parse(_row(speed)).tts_speed is None


def test_a_row_without_the_column_has_no_speed():
    assert device_registry._parse({"user": {"personality": {}}}).tts_speed is None


def _task_start_speed(**kwargs):
    service = create_service(transport="websocket", **kwargs)
    return json.loads(service._task_start_message())["voice_setting"]["speed"]


def test_the_character_speed_goes_into_task_start():
    assert _task_start_speed(speed=0.8) == 0.8


def test_no_speed_keeps_minimax_at_normal():
    assert _task_start_speed() == 1.0

"""The date, time and weather block, and where it lands in the prompt."""
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from character_prompt import SPOKEN_OUTPUT_RULES, build_session_prompt  # noqa: E402
from world_context import build_world_block, describe_time, describe_weather  # noqa: E402

EVENING = datetime(2026, 9, 23, 19, 58, tzinfo=ZoneInfo("Asia/Hong_Kong"))


def test_time_is_written_the_way_it_is_said():
    assert describe_time(EVENING) == "Wednesday, 23 September 2026, 7:58 PM"
    assert describe_time(EVENING.replace(hour=0, minute=5)).endswith("12:05 AM")
    assert describe_time(EVENING.replace(hour=12)).endswith("12:58 PM")


def test_weather_sentence_from_open_meteo():
    payload = {
        "current": {"temperature_2m": 28.6, "relative_humidity_2m": 81, "weather_code": 61},
        "daily": {
            "temperature_2m_max": [31.2],
            "temperature_2m_min": [26.4],
            "precipitation_probability_max": [70],
        },
    }
    sentence = describe_weather(payload)
    assert sentence == (
        "Right now it is light rain, 29 degrees Celsius, 81 percent humidity. "
        "Today's high is 31 and the low is 26. The chance of rain today is 70 percent."
    )
    assert describe_weather({}) is None


def test_block_without_weather_still_gives_the_time():
    block = build_world_block(EVENING, "Hong Kong", None)
    assert "7:58 PM" in block and "weather" not in block.split("Use this")[0]


def test_both_branches_carry_it_before_the_spoken_rules():
    block = build_world_block(EVENING, "Hong Kong", "Right now it is clear sky.")
    for prompt in (
        build_session_prompt(world_context=block),
        build_session_prompt(title="AI Hulk", character_prompt="You are AI Hulk.",
                             world_context=block, language_instruction="Reply in Cantonese."),
    ):
        assert block in prompt
        assert prompt.endswith(SPOKEN_OUTPUT_RULES)
        assert prompt.index(block) < prompt.index(SPOKEN_OUTPUT_RULES)
    custom = build_session_prompt(title="X", character_prompt="Y", world_context=block,
                                  language_instruction="Reply in Cantonese.")
    assert custom.index(block) < custom.index("Reply in Cantonese.")


def test_account_region_is_parsed_from_the_embedded_row():
    from device_registry import _parse

    row = {"user_id": "u1", "user": {"region": {
        "name": "Taipei", "timezone": "Asia/Taipei", "latitude": 25.033, "longitude": 121.5654,
    }}}
    region = _parse(row).region
    assert region is not None and region.name == "Taipei" and region.timezone == "Asia/Taipei"
    # Not chosen, or a half-filled row: fall back to the server default.
    assert _parse({"user": {"region": None}}).region is None
    assert _parse({"user": {"region": {"name": "X", "timezone": "Asia/Taipei"}}}).region is None


def test_block_uses_the_regions_clock_and_name():
    import asyncio

    import world_context

    os.environ["WEATHER_ENABLED"] = "false"
    try:
        block = asyncio.run(world_context.fetch_world_block(
            world_context.Region("London", "Europe/London", 51.5, -0.13)))
    finally:
        del os.environ["WEATHER_ENABLED"]
    assert "local time in London" in block

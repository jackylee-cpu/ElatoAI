"""Checks on modes, styles and IPs: the parts of a session that are not the character.

The ones that matter most are the isolation ones. An IP's guardrails have to
sit after anything that could argue with them, and one IP's memories must
never be read under another -- including when the character's IP could not be
read at all, which must turn memory off rather than fall back to a default.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import device_registry  # noqa: E402
import session_content  # noqa: E402
from character_prompt import SPOKEN_OUTPUT_RULES, build_session_prompt  # noqa: E402
from memory import session as memory_session  # noqa: E402
from memory import store  # noqa: E402
from session_content import IpRules, parse_ip_rules  # noqa: E402


def test_the_yaml_loads():
    assert {"companion", "story", "language"} <= set(session_content.modes())
    assert {"playful", "gentle", "silly"} <= set(session_content.styles())
    for entry in [*session_content.modes().values(), *session_content.styles().values()]:
        assert entry.name and entry.prompt, entry.key
    print("  ok: every mode and style has a name and a prompt")


def test_no_mode_chosen_means_no_mode_block():
    assert session_content.mode_block(None) is None
    assert session_content.style_block(None) is None
    print("  ok: an account that chose nothing gets the old prompt")


def test_the_chosen_mode_comes_first_and_the_others_are_offered():
    block = session_content.mode_block("story")
    story = session_content.modes()["story"]
    language = session_content.modes()["language"]
    assert block.startswith(f"WHAT YOU ARE DOING: {story.name}")
    assert block.index(story.prompt) < block.index("OTHER THINGS YOU CAN DO")
    assert language.prompt in block
    print("  ok: the child can ask to switch to any other mode")


def test_an_ip_only_offers_the_modes_it_allows():
    ip = IpRules(
        ip_key="licensed",
        mode_prompts={"story": "Stories happen in the bakery."},
        allowed_modes=frozenset({"story"}),
    )
    block = session_content.mode_block("story", ip)
    assert "Stories happen in the bakery." in block
    assert session_content.modes()["language"].prompt not in block
    assert "OTHER THINGS YOU CAN DO" not in block
    assert session_content.mode_block("language", ip) is None
    print("  ok: a disallowed mode is neither started nor offered")


def test_an_unrestricted_ip_can_flavour_one_mode_and_keep_the_rest():
    ip = IpRules(ip_key="ours", mode_prompts={"story": "Stories happen in the bakery."})
    block = session_content.mode_block("companion", ip)
    assert "Stories happen in the bakery." in block
    assert session_content.modes()["language"].prompt in block
    print("  ok: flavouring a mode does not restrict the IP to it")


def test_an_ip_only_allows_the_styles_it_lists():
    ip = IpRules(ip_key="licensed", allowed_styles=frozenset({"gentle"}))
    assert session_content.style_block("gentle", ip) is not None
    assert session_content.style_block("silly", ip) is None
    assert session_content.style_block("no-such-style") is None
    print("  ok: a disallowed or unknown style is left out")


def test_guardrails_come_after_style_and_mode_and_rules_stay_last():
    ip = IpRules(ip_key="licensed", guardrails="Never be mean about anyone's cooking.")
    for character_prompt in ("You are Pig.", None):
        prompt = build_session_prompt(
            title="Pig",
            character_prompt=character_prompt,
            child_name="Mia",
            style_block=session_content.style_block("silly", ip),
            mode_block=session_content.mode_block("story", ip),
            guardrails_block=session_content.guardrails_block(ip),
        )
        style_at = prompt.index("YOUR MANNER")
        mode_at = prompt.index("WHAT YOU ARE DOING")
        rules_at = prompt.index("Never be mean about anyone's cooking.")
        assert style_at < mode_at < rules_at < prompt.index("Mia")
        assert prompt.endswith(SPOKEN_OUTPUT_RULES)
    print("  ok: on both branches, guardrails outrank style and mode")


def test_ip_rules_parse_from_the_embedded_row():
    row = {
        "ip_key": "licensed",
        "guardrails": "  Be kind.  ",
        "restrict_modes": True,
        "restrict_styles": False,
        "ip_modes": [
            {"mode_key": "story", "prompt": None},
            {"mode_key": "language", "prompt": " In Spanish. "},
        ],
        "ip_styles": [{"style_key": "gentle"}],
    }
    rules = parse_ip_rules(row)
    assert rules.ip_key == "licensed"
    assert rules.guardrails == "Be kind."
    assert rules.mode_prompts == {"language": "In Spanish."}
    assert rules.allowed_modes == {"story", "language"}
    assert rules.allowed_styles is None  # rows, but not restricting
    assert parse_ip_rules({**row, "restrict_modes": None}).allowed_modes is None
    assert parse_ip_rules(None) is None
    assert parse_ip_rules({"guardrails": "x"}) is None
    print("  ok: only the flag restricts, a missing key is no IP")


def test_a_device_reads_its_characters_ip_mode_and_style():
    row = {
        "user_id": "child-1",
        "user": {
            "personality": {
                "key": "pig",
                "mode_key": "story",
                "style_key": "gentle",
                "ip": {"ip_key": "licensed"},
            },
        },
    }
    parsed = device_registry._parse(row)
    assert parsed.ip.ip_key == "licensed"
    assert (parsed.mode_key, parsed.style_key) == ("story", "gentle")

    lost = device_registry._parse(
        {"user_id": "child-1", "user": {"personality": {"key": "pig"}}}
    )
    assert lost.ip is None

    unclaimed = device_registry._parse({})
    assert unclaimed.ip.ip_key == session_content.DEFAULT_IP_KEY
    print("  ok: a lost IP is None, not the default; the built-in pal is in-house")


async def test_memory_reads_are_scoped_to_the_ip():
    seen: list[str] = []

    async def capture(url, *, what):
        seen.append(url)
        return []

    original = store._get_json, store.configured
    store._get_json = capture
    store.configured = lambda: True
    try:
        await store.fetch_recent_segments("child-1", "licensed")
        await store.fetch_active_facts("child-1", "licensed")
    finally:
        store._get_json, store.configured = original
    assert len(seen) == 2
    assert all("ip_key=eq.licensed" in url for url in seen)
    print("  ok: segments and facts are read for one IP only")


async def test_no_ip_means_no_memory():
    original = memory_session.enabled, store.configured
    memory_session.enabled = lambda: True
    store.configured = lambda: True
    try:
        assert await memory_session.acquire("child-1", None) is None
    finally:
        memory_session.enabled, store.configured = original
    print("  ok: an unreadable IP turns memory off instead of guessing")


def main():
    tests = [
        test_the_yaml_loads,
        test_no_mode_chosen_means_no_mode_block,
        test_the_chosen_mode_comes_first_and_the_others_are_offered,
        test_an_ip_only_offers_the_modes_it_allows,
        test_an_unrestricted_ip_can_flavour_one_mode_and_keep_the_rest,
        test_an_ip_only_allows_the_styles_it_lists,
        test_guardrails_come_after_style_and_mode_and_rules_stay_last,
        test_ip_rules_parse_from_the_embedded_row,
        test_a_device_reads_its_characters_ip_mode_and_style,
        test_memory_reads_are_scoped_to_the_ip,
        test_no_ip_means_no_memory,
    ]
    failed = 0
    for test in tests:
        print(f"{test.__name__}:")
        try:
            result = test()
            if asyncio.iscoroutine(result):
                asyncio.run(result)
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL: {exc}")
        except Exception as exc:
            failed += 1
            import traceback
            print(f"  ERROR: {type(exc).__name__}: {exc}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return failed


if __name__ == "__main__":
    sys.exit(main())

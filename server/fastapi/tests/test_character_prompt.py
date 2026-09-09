"""Checks on the prompt every character is assembled from.

The one that matters is that both branches carry the shared rules. They are
easy to add to one branch and forget in the other -- which is how the built-in
pal ended up as the only character with no instruction against speaking
markdown, and nothing about the symptom points at this file.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from character_prompt import SPOKEN_OUTPUT_RULES, build_session_prompt  # noqa: E402


def test_the_builtin_character_gets_the_spoken_output_rules():
    prompt = build_session_prompt()
    assert SPOKEN_OUTPUT_RULES in prompt
    print("  ok: the built-in pal is told not to speak markdown")


def test_a_custom_character_gets_the_spoken_output_rules():
    prompt = build_session_prompt(title="AI Hulk", character_prompt="You are AI Hulk.")
    assert SPOKEN_OUTPUT_RULES in prompt
    assert "Never ask the child for personal information" in prompt
    print("  ok: a custom character keeps both the safety and the spoken rules")


def test_the_rules_come_last():
    """Recency matters for a formatting instruction the model keeps breaking."""
    prompt = build_session_prompt(
        title="AI Hulk",
        character_prompt="You are AI Hulk. Shout HULK SMASH when excited.",
        child_name="Mia",
        memory_preamble="WHAT YOU REMEMBER: jellyfish.",
    )
    assert prompt.endswith(SPOKEN_OUTPUT_RULES)
    print("  ok: the spoken rules are the last thing the model reads")


def test_the_memory_brief_survives_alongside_them():
    prompt = build_session_prompt(
        character_prompt="You are AI Hulk.",
        memory_preamble="WHAT YOU REMEMBER: jellyfish.",
    )
    assert "jellyfish" in prompt
    print("  ok: the memory brief is still in the prompt")


def main():
    tests = [
        test_the_builtin_character_gets_the_spoken_output_rules,
        test_a_custom_character_gets_the_spoken_output_rules,
        test_the_rules_come_last,
        test_the_memory_brief_survives_alongside_them,
    ]
    failed = 0
    for test in tests:
        print(f"{test.__name__}:")
        try:
            test()
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

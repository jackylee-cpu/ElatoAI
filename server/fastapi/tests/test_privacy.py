"""What the memory write gate blocks, and what it must never block.

The false negatives are the ones with a real cost -- a phone number in a prompt
the toy can read back. But the false positives matter too, and one of them is
the reason this file exists: a length-only rule blocked "2026-09-09", and a
birthday is exactly the kind of thing a child expects the toy to remember.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from memory.privacy import holds_sensitive_number  # noqa: E402

BLOCK = [
    ("a mainland mobile number", "我的电话是13812345678"),
    ("the same number, spoken in groups", "我家电话 138 1234 5678"),
    ("a dash-separated number", "my number is 555-0123-999"),
    ("an ID number", "身份证 110101199003074567"),
    ("date-shaped but not a date: month 34", "12-34-5678"),
]

KEEP = [
    ("a birthday, the case this gate got wrong", "我的生日是2026-09-09"),
    ("a slash date", "2026/09/09 我们去公园"),
    ("a CJK date", "2026年9月9日"),
    ("a day-first date", "9-9-2026 是我生日"),
    ("a space-separated date", "2026 09 09"),
    ("an age", "我今年8岁"),
    ("a count", "我有3只狗"),
    ("no digits at all", "我最喜欢的动物是水母"),
    ("a house number", "我住在幸福路123号"),
    ("nothing", ""),
]


def test_sensitive_numbers_are_blocked():
    for label, text in BLOCK:
        assert holds_sensitive_number(text), f"should have blocked {label}: {text!r}"
    print(f"  ok: {len(BLOCK)} sensitive strings blocked")


def test_dates_and_ordinary_numbers_survive():
    for label, text in KEEP:
        assert not holds_sensitive_number(text), f"should have kept {label}: {text!r}"
    print(f"  ok: {len(KEEP)} harmless strings kept, dates included")


def test_none_is_not_sensitive():
    assert not holds_sensitive_number(None)
    print("  ok: a missing reply is not sensitive")


def main():
    tests = [
        test_sensitive_numbers_are_blocked,
        test_dates_and_ordinary_numbers_survive,
        test_none_is_not_sensitive,
    ]
    failed = 0
    for test in tests:
        print(f"{test.__name__}:")
        try:
            test()
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL: {exc}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return failed


if __name__ == "__main__":
    sys.exit(main())

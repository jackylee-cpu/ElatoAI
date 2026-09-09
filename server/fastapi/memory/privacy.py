"""What must never reach long-term memory.

The scope here is deliberately narrow: long digit strings. That covers phone
numbers, ID numbers and card numbers, which are the ones with a real cost if
the toy ever says them back, and it covers them without an LLM call on the
write path.

It does not cover addresses, school names or surnames -- those need judgement,
not a regex, and they belong to the extraction layer that reads a turn and
decides what it means. The summariser prompt already refuses them; a future
facts layer would be where they are properly handled. Pretending this module
does more than it does would be worse than the gap.

**Dates are not sensitive and must survive.** A birthday, a trip next Saturday,
the day a puppy arrives -- these are exactly what a child wants the toy to
remember, and a plain digit-length rule eats them: "2026-09-09" is eight digits
and looks identical to the front of an ID number. So date-shaped runs are
removed before anything is counted, and the month and day are range-checked so
that "12-34-5678" is not waved through as a date.

A flagged turn is kept out of `memories` and out of VoiceMem, but stays in
`conversations`. That split is the point: `conversations` is a transcript a
parent reads and can delete, and it is never replayed into a prompt, whereas
everything in `memories` is eventually spoken back by the toy. The number a
child read out loud stays visible to their parent, and stops being something
the toy knows.
"""

from __future__ import annotations

import re

# A run of digits, allowing the spaces and dashes people say numbers with.
# Other separators need no handling: "2026/09/09" and "2026年9月9日" already
# break into runs of four, two and two.
_DIGIT_RUN = re.compile(r"\d[\d\s\-]*\d")

# Year-first and day-first dates, with the separators that would otherwise be
# swallowed into one long run. Ranges are checked below, not here, because a
# regex that also validated them would be unreadable.
_DATE = re.compile(
    r"(?<!\d)(?:"
    r"(\d{4})[-. /](\d{1,2})[-. /](\d{1,2})"
    r"|(\d{1,2})[-. /](\d{1,2})[-. /](\d{4})"
    r")(?!\d)"
)

# Seven, because six still catches ordinary prices and quantities while seven is
# the short end of a real phone number.
MIN_SENSITIVE_DIGITS = 7


def _is_date(month: str, day: str) -> bool:
    return 1 <= int(month) <= 12 and 1 <= int(day) <= 31


def _strip_dates(text: str) -> str:
    """Blank out anything that is really a date, so it is never counted."""

    def replace(match: re.Match) -> str:
        year_first, month_a, day_a, day_b, month_b, year_last = match.groups()
        if year_first is not None and _is_date(month_a, day_a):
            return " "
        if year_last is not None and _is_date(month_b, day_b):
            return " "
        return match.group()

    return _DATE.sub(replace, text)


def holds_sensitive_number(text: str | None) -> bool:
    """Does this text contain a digit string long enough to identify someone?"""
    if not text:
        return False
    for match in _DIGIT_RUN.finditer(_strip_dates(text)):
        if len(re.sub(r"\D", "", match.group())) >= MIN_SENSITIVE_DIGITS:
            return True
    return False

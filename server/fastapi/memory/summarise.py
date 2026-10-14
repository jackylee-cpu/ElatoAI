"""The cold path: turn a stretch of raw conversation into what outlives it.

This is the only LLM call long-term memory makes on its own behalf, and it is
deliberately nothing like a retrieval. It runs every few turns in the
background, never on the frame path, and what it produces is already sitting in
Supabase before the *next* session starts -- which is the whole point. A search
cannot greet a child by name: at "hello" there is no query yet.

One call, two outputs, because they are two different kinds of memory:

  * **a segment** -- what this stretch was about, one or two sentences. Episodic:
    the next session's opening brief is the last couple of these, so it ages
    out, which is right for "we went to medieval Europe".
  * **facts** -- who the child is: name, family, pets, likes, plans with a date.
    Durable: they stay in the prompt until something replaces them, which is
    right for "has a shiba called 豆豆" and wrong to leave to a segment that
    two short sessions will push out of the brief.

Two rules are load-bearing:

**Work from the raw turns, never from another summary.** Compressing a
compression compounds its errors, and the drift is invisible until it is weeks
deep. The current facts go in only so the model can see what is already known
and say which one a new fact replaces; it never rewrites the list. A model that
silently drops half a rewritten list on one bad run is how a rolling memory
loses things for good.

**Fail open, and fail quiet.** Anything that went wrong returns None and says
why at WARNING. VoiceMem's own extractor taught this the hard way: it swallowed
an HTTP 403 as a Chinese log line and stored nothing for a week without ever
raising.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Callable

import aiohttp
from loguru import logger

# Two sentences. The last few segments land in the next session's system
# prompt, so a long one is charged for on every turn of it -- and it also
# drowns out the character's own instructions.
SEGMENT_MAX_CHARS = int(os.getenv("MEMORY_SEGMENT_MAX_CHARS", "220"))
# One short sentence each. The whole active list is in every prompt.
FACT_MAX_CHARS = int(os.getenv("MEMORY_FACT_MAX_CHARS", "80"))
TIMEOUT_SECONDS = float(os.getenv("MEMORY_SUMMARY_TIMEOUT", "20"))
# Room for the JSON reply. A reply cut off here does not parse, and that reads
# as a failed call, so raise it before raising the fact or summary limits.
MAX_TOKENS = int(os.getenv("MEMORY_SUMMARY_MAX_TOKENS", "800"))
# "off" asks OpenRouter not to reason. Applies only to a model chosen here on
# purpose (MEMORY_SUMMARY_MODEL): the OPENROUTER_MODEL fallback may be one that
# cannot turn it off. Measured on deepseek/deepseek-v4-flash with an extraction
# prompt: 18.9s median with reasoning, 3.3s without, same output.
REASONING = os.getenv("MEMORY_SUMMARY_REASONING", "off").strip().lower()

_SYSTEM = """You keep the memory of a talking toy that a young child speaks to.

You are given the raw turns of one stretch of conversation, the facts you
already know about this child (numbered), and a calendar starting today. Reply
with ONE JSON object and nothing else:

{"summary": "...", "facts": [{"text": "...", "replaces": null}]}

"summary": at most two sentences saying what you did or talked about together
-- the game you played, the story, the question they were curious about. It is
read at the start of the NEXT conversation, days later, so write it as a
reminder to yourself, not a report to a parent. Do not repeat anything that is
going into "facts"; the summary is for what happened, facts are for who they
are. Small talk on its own -- asking the time or the date, saying hello,
checking whether you can hear them -- is not worth remembering: use an empty
string for that, and for anything else with nothing worth keeping.

"facts": things about the child that will still be true and useful in a
conversation weeks from now. Good facts: what they want to be called, family
members and pets and their names, what they love or dislike, a friend's name,
a plan or event with its date, a standing request about how the toy should
talk to them. NOT facts: questions they asked (what time it is), what happened
inside a pretend game, anything only true right now, anything you already know.
- One short sentence each, about the child in the third person.
- Turn relative dates into real ones by looking them up in the calendar, never
  by counting ("next Saturday" -> the date listed for it). Write only the date:
  never keep "today", "next Saturday" or "this year" in a fact, because it will
  be read weeks from now when those words mean something else.
- If a new fact updates or contradicts a known one (a new age, a changed
  name), set "replaces" to that known fact's number, and write the COMPLETE
  updated fact: everything in the old one that is still true, plus the change.
  The old one is thrown away, so anything you leave out is forgotten. Known "has
  a 3-year-old shiba called 豆豆" + "豆豆 turned 4 today" -> "has a shiba called
  豆豆, 4 years old since 2026-09-24", replacing it. Otherwise null.
- If there is nothing new, use an empty list. Most stretches have none.

Rules for both:
- Write in the same language the child is speaking.
- Say only what the child actually said. Never guess, never embellish, never
  invent names. The child's speech was machine-transcribed; skip anything that
  looks garbled rather than recording it.
- Never include a phone number, an address, a school name, or anything else
  that identifies the child or their family, even if the child said it."""


@dataclass(frozen=True)
class NewFact:
    text: str
    # Index into the `known` list that was passed in, or None.
    replaces: int | None = None


@dataclass(frozen=True)
class Consolidation:
    summary: str = ""
    facts: list[NewFact] = field(default_factory=list)


def _endpoint() -> tuple[str, str, str, bool] | None:
    """(base_url, api_key, model, reasoning_off), or None when unconfigured.

    OpenRouter first, for the same reason MemorySession._configure_llm_model
    exists: on this deployment it is the key that actually works, and pointing
    memory at a second provider means a second thing that can be quietly
    unconfigured.
    """
    key = os.getenv("OPENROUTER_API_KEY")
    if key:
        chosen = os.getenv("MEMORY_SUMMARY_MODEL")
        model = chosen or os.getenv("OPENROUTER_MODEL")
        if model:
            return (
                "https://openrouter.ai/api/v1",
                key,
                model,
                bool(chosen) and REASONING != "on",
            )
        logger.warning(
            "OPENROUTER_API_KEY is set but OPENROUTER_MODEL is not, so session "
            "summaries cannot be written and the toy will start every "
            "conversation from nothing."
        )
        return None

    key = os.getenv("OPENAI_API_KEY")
    if key:
        base = os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1"
        model = os.getenv("MEMORY_SUMMARY_MODEL") or "gpt-4o-mini"
        return base, key, model, False
    return None


def render_turns(turns) -> str:
    """The raw exchange, in the shape the prompt above expects."""
    lines: list[str] = []
    for turn in turns:
        user_text = (getattr(turn, "user_text", "") or "").strip()
        agent_reply = (getattr(turn, "agent_reply", "") or "").strip()
        if user_text:
            lines.append(f"Child: {user_text}")
        if agent_reply:
            lines.append(f"Toy: {agent_reply}")
    return "\n".join(lines)


def calendar(today: date, days: int = 21) -> str:
    """Today and the weeks after it, one line per day.

    Handed to the model instead of trusting it to count. Measured: asked for
    "next Saturday" from Thursday 2026-09-24 with only the date given, it
    answered 2026-10-02 -- a Friday.
    """
    lines = []
    for offset in range(days):
        day = today + timedelta(days=offset)
        label = " (today)" if offset == 0 else ""
        lines.append(f"{day.isoformat()} {day.strftime('%A')}{label}")
    return "\n".join(lines)


def render_request(turns, known: list[str], today: date) -> str:
    facts = "\n".join(f"{i}. {text}" for i, text in enumerate(known, start=1))
    return (
        f"Calendar:\n{calendar(today)}\n\n"
        f"Known facts:\n{facts or '(none yet)'}\n\n"
        f"Conversation:\n{render_turns(turns)}"
    )


def _cut(text: str, limit: int) -> str:
    """Shorten to whole sentences, never mid-sentence.

    Half a sentence is worse than none: the model reading it next time will
    happily complete it. The model is asked for short output, so this is a
    guard against the rare runaway, not the normal path.
    """
    text = text.strip()
    if len(text) <= limit:
        return text
    head = text[:limit]
    ends = [head.rfind(mark) for mark in ("。", "！", "？", ". ", "! ", "? ")]
    end = max(ends)
    if end <= 0:
        return ""
    return head[: end + 1].strip()


def parse(raw: str, known_count: int) -> Consolidation | None:
    """The model's reply, validated. None if it is not the shape asked for."""
    text = (raw or "").strip()
    # Some models fence JSON even in JSON mode.
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("{") :] if "{" in text else text
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(data, dict):
        return None

    summary = data.get("summary")
    summary = summary.strip() if isinstance(summary, str) else ""
    if summary.upper() == "NOTHING":
        summary = ""

    facts: list[NewFact] = []
    seen: set[str] = set()
    for item in data.get("facts") or []:
        if isinstance(item, str):
            item = {"text": item}
        if not isinstance(item, dict):
            continue
        fact = _cut(str(item.get("text") or ""), FACT_MAX_CHARS)
        if not fact or fact in seen:
            continue
        seen.add(fact)
        replaces = item.get("replaces")
        # 1-based in the prompt, 0-based here. Anything that does not name a
        # real known fact is treated as a plain addition, never as a guess.
        if isinstance(replaces, bool) or not isinstance(replaces, int):
            index = None
        else:
            index = replaces - 1 if 1 <= replaces <= known_count else None
        facts.append(NewFact(text=fact, replaces=index))

    return Consolidation(summary=_cut(summary, SEGMENT_MAX_CHARS), facts=facts)


async def consolidate(
    turns,
    known: list[str],
    today: date,
    language_code: str | None = None,
    on_usage: Callable[[str, dict[str, Any]], None] | None = None,
) -> Consolidation | None:
    """A segment and any new facts for these turns. None if the call failed.

    An empty Consolidation is a success that found nothing worth keeping; None
    is a failure the caller may retry. The two must not be confused, or a
    network blip reads as "nothing happened".

    `on_usage(model, usage)` hears the token counts of every call that was
    answered, including one whose reply then fails to parse: the provider
    bills it either way.
    """
    if not render_turns(turns).strip():
        return Consolidation()

    endpoint = _endpoint()
    if endpoint is None:
        logger.warning(
            "No LLM key for session summaries, so nothing will carry over "
            "between conversations. Set OPENROUTER_API_KEY + OPENROUTER_MODEL."
        )
        return None
    base_url, api_key, model, reasoning_off = endpoint

    instruction = _SYSTEM
    if language_code:
        # A hint, explicitly outranked by the transcript. The configured value is
        # whatever was picked in the web app and it goes stale: this account is
        # set to en-US and the child speaks Chinese, which was enough to make the
        # summary come back in English. That summary is injected next to content
        # in the child's real language, so the transcript has to win.
        instruction += (
            f"\n- Their profile says their language is {language_code}, but the "
            "transcript decides: if they are speaking something else, write in "
            "the language they actually spoke."
        )

    payload: dict = {
        "model": model,
        "messages": [
            {"role": "system", "content": instruction},
            {"role": "user", "content": render_request(turns, known, today)},
        ],
        "temperature": 0.2,
        "max_tokens": MAX_TOKENS,
        "response_format": {"type": "json_object"},
        "stream": False,
    }
    if reasoning_off:
        payload["reasoning"] = {"enabled": False}

    try:
        timeout = aiohttp.ClientTimeout(total=TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{base_url.rstrip('/')}/chat/completions",
                json=payload,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
            ) as response:
                if response.status != 200:
                    detail = (await response.text())[:200]
                    logger.warning(
                        "Memory consolidation failed: HTTP {} {}", response.status, detail
                    )
                    return None
                data = await response.json()
    except Exception as exc:  # noqa: BLE001 - a summary is never worth an outage
        logger.warning("Memory consolidation errored: {}", exc)
        return None

    usage = data.get("usage") if isinstance(data, dict) else None
    if on_usage is not None and isinstance(usage, dict):
        try:
            on_usage(model, usage)
        except Exception as exc:  # noqa: BLE001 - accounting must not lose a summary
            logger.warning("Recording memory consolidation usage errored: {}", exc)

    try:
        raw = data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        logger.warning("Memory consolidation came back in an unexpected shape")
        return None

    result = parse(raw, len(known))
    if result is None:
        logger.warning("Memory consolidation was not valid JSON: {!r}", raw[:200])
    return result

"""The cold path: turn a stretch of raw conversation into one short summary.

This is the only LLM call long-term memory makes on its own behalf, and it is
deliberately nothing like a retrieval. It runs every few turns in the
background worker, never on the frame path, and its output is a paragraph that
is already sitting in Supabase before the *next* session starts -- which is the
whole point. A search cannot greet a child by name: at "hello" there is no
query yet. A summary written last night can.

Two rules are load-bearing:

**Summarise the raw turns, never another summary.** Compressing a compression
compounds its errors, and the drift is invisible until it is weeks deep -- the
toy ends up confidently recalling a conversation that never happened. Every
segment here is derived from utterances exactly once.

**Fail open, and fail quiet.** A summary that could not be written costs a
little continuity. An exception escaping into the worker would cost the write
queue. VoiceMem's own extractor taught this the hard way: it swallowed an HTTP
403 as a Chinese log line and stored nothing for a week without ever raising.
So this returns "" on every failure and says why at WARNING.
"""

from __future__ import annotations

import os

import aiohttp
from loguru import logger

# Two sentences. This lands in a system prompt on every single turn of the next
# session, so it is charged for over and over -- and a long "last time" block
# also drowns out the character's own instructions.
SEGMENT_MAX_CHARS = int(os.getenv("MEMORY_SEGMENT_MAX_CHARS", "220"))
TIMEOUT_SECONDS = float(os.getenv("MEMORY_SUMMARY_TIMEOUT", "20"))

_SYSTEM = """You keep the memory of a talking toy that a young child speaks to.

You are given the raw turns of one stretch of conversation. Write ONE short
paragraph, at most two sentences, saying what was talked about and anything the
child asked for or was excited about. This will be read at the start of the
NEXT conversation, days later, so write it as a reminder to yourself, not as a
report to a parent.

Rules:
- Write in the same language the child is speaking.
- Say what actually happened. Never guess, never embellish, never invent names.
- Never include a phone number, an address, a school name, or anything else
  that identifies the child or their family. If the child said one, do not
  repeat it -- at most note that they mentioned it.
- No preamble, no bullet points, no quotation marks. Just the paragraph.
- If nothing worth remembering happened, reply with exactly: NOTHING"""


def _endpoint() -> tuple[str, str, str] | None:
    """(base_url, api_key, model), or None when nothing is configured.

    OpenRouter first, for the same reason MemorySession._configure_llm_model
    exists: on this deployment it is the key that actually works, and pointing
    memory at a second provider means a second thing that can be quietly
    unconfigured.
    """
    key = os.getenv("OPENROUTER_API_KEY")
    if key:
        model = os.getenv("MEMORY_SUMMARY_MODEL") or os.getenv("OPENROUTER_MODEL")
        if model:
            return "https://openrouter.ai/api/v1", key, model
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
        return base, key, model
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


async def summarise(turns, language_code: str | None = None) -> str:
    """One paragraph for these turns, or "" when there is nothing to say."""
    body_text = render_turns(turns)
    if not body_text.strip():
        return ""

    endpoint = _endpoint()
    if endpoint is None:
        logger.warning(
            "No LLM key for session summaries, so nothing will carry over "
            "between conversations. Set OPENROUTER_API_KEY + OPENROUTER_MODEL."
        )
        return ""
    base_url, api_key, model = endpoint

    instruction = _SYSTEM
    if language_code:
        # A hint, explicitly outranked by the transcript. The configured value is
        # whatever was picked in the web app and it goes stale: this account is
        # set to en-US and the child speaks Chinese, which was enough to make the
        # summary come back in English. That summary is injected next to content
        # in the child's real language, so the transcript has to win.
        instruction += (
            f"\n- Their profile says their language is {language_code}, but the "
            "transcript decides: if they are speaking something else, write the "
            "summary in the language they actually spoke."
        )

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": instruction},
            {"role": "user", "content": body_text},
        ],
        "temperature": 0.2,
        "max_tokens": 300,
        "stream": False,
    }

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
                        "Session summary failed: HTTP {} {}", response.status, detail
                    )
                    return ""
                data = await response.json()
    except Exception as exc:  # noqa: BLE001 - a summary is never worth an outage
        logger.warning("Session summary errored: {}", exc)
        return ""

    try:
        text = (data["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, TypeError):
        logger.warning("Session summary came back in an unexpected shape")
        return ""

    # Some models cannot resist a lead-in even when told not to. Take the model
    # at its word only for the exact refusal token.
    if not text or text.strip().upper() == "NOTHING":
        return ""
    return text[:SEGMENT_MAX_CHARS].strip()

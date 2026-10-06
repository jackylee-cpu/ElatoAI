"""One OpenRouter chat call, with the retries a batch job needs."""

from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass, field

import aiohttp

BASE_URL = "https://openrouter.ai/api/v1"


class LLMError(RuntimeError):
    pass


@dataclass
class Reply:
    content: str
    usage: dict = field(default_factory=dict)


async def chat(
    http: aiohttp.ClientSession,
    model: str,
    messages: list[dict],
    *,
    max_tokens: int = 1024,
    temperature: float = 0.0,
    json_mode: bool = False,
    extra: dict | None = None,
    attempts: int = 5,
    timeout: float = 180,
) -> Reply:
    """The reply text. Retries rate limits, 5xx and timeouts; raises LLMError after."""
    key = os.getenv("OPENROUTER_API_KEY")
    if not key:
        raise LLMError("OPENROUTER_API_KEY is not set")
    payload: dict = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    if extra:
        payload.update(extra)

    last = ""
    for attempt in range(attempts):
        try:
            async with http.post(
                f"{BASE_URL}/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {key}"},
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as response:
                body = await response.text()
                if response.status == 200:
                    data = json.loads(body)
                    if "error" in data:
                        last = str(data["error"])[:300]
                    else:
                        content = data["choices"][0]["message"].get("content") or ""
                        return Reply(content=content, usage=data.get("usage") or {})
                elif response.status in (429, 500, 502, 503, 504, 408):
                    last = f"HTTP {response.status} {body[:300]}"
                else:
                    raise LLMError(f"HTTP {response.status} {body[:500]}")
        except (aiohttp.ClientError, asyncio.TimeoutError, json.JSONDecodeError) as exc:
            last = f"{type(exc).__name__}: {exc}"
        await asyncio.sleep(min(60, 3 * 2**attempt))
    raise LLMError(f"gave up after {attempts} attempts: {last}")


def parse_json(text: str):
    """The JSON object in a model reply, tolerating fences and chatter around it.

    Raises ValueError when there is none: a reply that cannot be read is an
    error to report, never a score of 0.
    """
    text = (text or "").strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\}|\[.*\])\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            pass
    raise ValueError(f"no JSON object in reply: {text[:200]!r}")

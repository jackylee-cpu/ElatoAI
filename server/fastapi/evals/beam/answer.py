"""Ask each BEAM probing question under each condition.

  none   the question alone
  prod   + the preamble the production memory built
  adult  + the preamble the adult config built
  full   + the whole transcript (oldest part cut if it does not fit)

The question goes in unchanged, as the user's message.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path

import aiohttp

from evals.beam import llm
from evals.beam.data import Conversation, render_transcript
from evals.beam.prompts import (
    ANSWER_MEMORY_HEADER,
    ANSWER_SYSTEM,
    ANSWER_TRANSCRIPT_HEADER,
)

MEMORY_CONDITIONS = ("prod", "adult")
# The whole history has to fit the answering model's context with room for
# the reply. 600k characters is ~150k tokens of this English/markdown text,
# which fits minimax-m2.7's 204,800. Three of the twenty 100K conversations
# are longer (up to 903k characters) and lose their oldest part; the answer
# record says how much.
FULL_MAX_CHARS = int(os.getenv("BEAM_FULL_MAX_CHARS", "600000"))
ANSWER_MAX_TOKENS = int(os.getenv("BEAM_ANSWER_MAX_TOKENS", "6000"))
_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)


def answer_model() -> str:
    model = os.getenv("BEAM_ANSWER_MODEL") or os.getenv("OPENROUTER_MODEL")
    if not model:
        raise SystemExit("Set BEAM_ANSWER_MODEL or OPENROUTER_MODEL")
    return model


def _extra() -> dict:
    # The toy's own reasoning setting, if the deployment sets one.
    effort = os.getenv("OPENROUTER_REASONING_EFFORT")
    return {"reasoning": {"effort": effort}} if effort else {}


def fit_transcript(blocks: list[str], limit: int) -> tuple[str, int]:
    """The newest blocks that fit in `limit` characters, and how many were cut."""
    kept: list[str] = []
    size = 0
    for block in reversed(blocks):
        if size + len(block) + 2 > limit:
            break
        kept.append(block)
        size += len(block) + 2
    kept.reverse()
    cut = sum(len(b) + 2 for b in blocks) - size
    if cut:
        kept.insert(0, "[... the oldest part of the history did not fit and is omitted ...]")
    return "\n\n".join(kept), cut


def system_prompt(
    conversation: Conversation, condition: str, memory: dict[str, dict]
) -> tuple[str, dict]:
    today = conversation.last_day.isoformat() if conversation.last_day else "unknown"
    prompt = ANSWER_SYSTEM.format(today=today)
    meta: dict = {}
    if condition in MEMORY_CONDITIONS:
        preamble = memory[condition]["preamble"]
        meta["memory_chars"] = len(preamble)
        if preamble:
            prompt += ANSWER_MEMORY_HEADER + preamble
    elif condition == "full":
        transcript, cut = fit_transcript(render_transcript(conversation), FULL_MAX_CHARS)
        meta["transcript_chars"] = len(transcript)
        meta["truncated_chars"] = cut
        prompt += ANSWER_TRANSCRIPT_HEADER + transcript
    return prompt, meta


def load_done(path: Path) -> set[tuple[str, str]]:
    done = set()
    if path.exists():
        for line in path.read_text().splitlines():
            row = json.loads(line)
            if not row.get("error"):
                done.add((row["key"], row["condition"]))
    return done


def load_memory(out_dir: Path, conv_id: str) -> dict[str, dict]:
    memory = {}
    for config in MEMORY_CONDITIONS:
        path = out_dir / "memory" / config / f"{conv_id}.json"
        if path.exists():
            memory[config] = json.loads(path.read_text())
    return memory


async def answer(
    conversations: list[Conversation],
    conditions: list[str],
    out_dir: Path,
    concurrency: int = 4,
) -> None:
    path = out_dir / "answers.jsonl"
    done = load_done(path)
    model = answer_model()
    gate = asyncio.Semaphore(concurrency)
    lock = asyncio.Lock()
    counts = {"ok": 0, "error": 0}

    async with aiohttp.ClientSession() as http:

        async def one(conversation, question, condition, prompt, meta):
            async with gate:
                row = {
                    "key": question.key,
                    "conv_id": question.conv_id,
                    "category": question.category,
                    "condition": condition,
                    "model": model,
                    "question": question.question,
                    **meta,
                }
                try:
                    reply = await llm.chat(
                        http,
                        model,
                        [
                            {"role": "system", "content": prompt},
                            {"role": "user", "content": question.question},
                        ],
                        max_tokens=ANSWER_MAX_TOKENS,
                        extra=_extra(),
                        timeout=300,
                    )
                    # Some reasoning models inline their thinking in the content.
                    row["answer"] = _THINK.sub("", reply.content).strip()
                    row["usage"] = reply.usage
                    if not row["answer"]:
                        row["error"] = "empty answer"
                except llm.LLMError as exc:
                    row["error"] = str(exc)
                counts["error" if row.get("error") else "ok"] += 1
                async with lock:
                    with path.open("a") as f:
                        f.write(json.dumps(row, ensure_ascii=False) + "\n")

        tasks = []
        for conversation in conversations:
            memory = load_memory(out_dir, conversation.conv_id)
            for condition in conditions:
                if condition in MEMORY_CONDITIONS and condition not in memory:
                    print(f"  answer: no {condition} memory for conv {conversation.conv_id}, skipped")
                    continue
                prompt, meta = system_prompt(conversation, condition, memory)
                for question in conversation.questions:
                    if (question.key, condition) in done:
                        continue
                    tasks.append(one(conversation, question, condition, prompt, meta))
        print(f"  answer: {len(tasks)} calls to {model}")
        await asyncio.gather(*tasks)
    print(f"  answer: {counts['ok']} ok, {counts['error']} failed")

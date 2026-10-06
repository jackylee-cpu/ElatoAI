"""Score the answers the way BEAM does, plus one diagnostic of our own.

BEAM's score (all categories): every rubric item is judged 0 / 0.5 / 1 by an
LLM with BEAM's own prompt (prompts.JUDGE_PROMPT, verbatim), and a question's
score is the mean over its items -- src/evaluation/compute_metrics.py,
evaluate_*.

Event ordering also gets BEAM's ordering score: the response's lines are
aligned with the rubric's events, then Kendall tau-b (normalised to 0-1) x F1
-- event_ordering_score there. BEAM aligns with one yes/no call per
(line, event) pair; this does it in one call (prompts.ALIGN_PROMPT). Empty
lines are dropped before aligning, where BEAM counts them as unmatched lines.

Retention (ours, prod/adult only): is what the rubric asks for in the memory
text at all? A low answer score with high retention means the memory had it
and the answer did not use it; low retention means it was never stored.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path

import aiohttp
from scipy.stats import kendalltau

from evals.beam import llm
from evals.beam.answer import MEMORY_CONDITIONS, load_memory
from evals.beam.data import Conversation, Question
from evals.beam.prompts import ALIGN_PROMPT, JUDGE_PROMPT, RETENTION_PROMPT

_RUBRIC_PREFIX = re.compile(
    r"^\s*LLM response should (?:state|mention|contain|include|say)\s*:?\s*", re.IGNORECASE
)


# A third model family: not the answerer (MiniMax) and not the memory writer
# (DeepSeek), so neither grades its own work. OpenAI, Google and Anthropic
# models are refused on this account (HTTP 403, provider terms), which is why
# the default is not BEAM's GPT judge.
DEFAULT_JUDGE = "qwen/qwen3.7-plus"
# Judging is a lookup against a rubric; reasoning only eats the token budget.
_NO_REASONING = {"reasoning": {"enabled": False}}


def judge_model() -> str:
    return os.getenv("BEAM_JUDGE_MODEL") or DEFAULT_JUDGE


def _score(value) -> float:
    score = float(value)
    if score not in (0.0, 0.5, 1.0):
        raise ValueError(f"score {value!r} is not 0, 0.5 or 1")
    return score


async def judge_item(http, model: str, rubric_item: str, response: str) -> dict:
    prompt = JUDGE_PROMPT.replace("<rubric_item>", rubric_item).replace(
        "<llm_response>", response
    )
    last: Exception | None = None
    for _ in range(3):
        reply = await llm.chat(
            http, model, [{"role": "user", "content": prompt}], max_tokens=600, extra=_NO_REASONING
        )
        try:
            data = llm.parse_json(reply.content)
            return {"item": rubric_item, "score": _score(data["score"]), "reason": data.get("reason", "")}
        except (ValueError, KeyError, TypeError) as exc:
            last = exc
    raise llm.LLMError(f"judge reply unreadable: {last}")


# ── event ordering ───────────────────────────────────────────────────────────


def ordering_score(reference: list[str], system: list[str], matches: list[int | None]) -> dict:
    """BEAM's event_ordering_score, given an alignment of system lines to reference.

    matches[i] is the 0-based reference index line i describes, or None. Each
    reference item is used at most once (first line wins), as in BEAM.
    """
    used: set[int] = set()
    canon: list[str] = []
    for line, match in zip(system, matches):
        if match is not None and 0 <= match < len(reference) and match not in used:
            used.add(match)
            canon.append(reference[match])
        else:
            canon.append(line)

    tp = len(set(reference) & set(canon))
    fp = len([x for x in canon if x not in reference])
    fn = len([x for x in reference if x not in canon])
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0

    union = list(dict.fromkeys(reference + canon))
    tie = len(union) + 1

    def ranks(seq):
        position = {item: i + 1 for i, item in enumerate(seq)}
        return [position.get(u, tie) for u in union]

    tau, _ = kendalltau(ranks(reference), ranks(canon), variant="b")
    tau_norm = (tau + 1) / 2 if tau == tau else 0.0  # NaN when a side is constant
    return {
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "tau_norm": tau_norm,
        "ordering_score": tau_norm * f1,
    }


async def judge_ordering(http, model: str, reference: list[str], response: str) -> dict:
    lines = [line.strip() for line in response.split("\n") if line.strip()]
    if not lines or not reference:
        return ordering_score(reference, lines, [None] * len(lines))
    prompt = ALIGN_PROMPT.replace(
        "<reference>", "\n".join(f"{i}. {r}" for i, r in enumerate(reference, start=1))
    ).replace("<lines>", "\n".join(f"{i}. {line}" for i, line in enumerate(lines, start=1)))
    reply = await llm.chat(
        http,
        model,
        [{"role": "user", "content": prompt}],
        max_tokens=1500,
        json_mode=True,
        extra=_NO_REASONING,
    )
    raw = llm.parse_json(reply.content).get("matches") or []
    matches: list[int | None] = []
    for i in range(len(lines)):
        value = raw[i] if i < len(raw) else None
        matches.append(value - 1 if isinstance(value, int) and not isinstance(value, bool) else None)
    return ordering_score(reference, lines, matches)


# ── retention ────────────────────────────────────────────────────────────────


def retention_targets(question: Question) -> list[str]:
    """What would have to be in memory for this question to be answerable."""
    raw = question.raw
    if question.category == "abstention":
        return []
    if question.category == "instruction_following":
        return [str(raw["instruction_being_tested"])] if raw.get("instruction_being_tested") else []
    if question.category == "preference_following":
        return [str(raw["preference_being_tested"])] if raw.get("preference_being_tested") else []
    targets = []
    for item in question.rubric:
        # "there is contradictory information" is about the answer, not memory.
        if question.category == "contradiction_resolution" and "contradict" in item.lower():
            continue
        targets.append(_RUBRIC_PREFIX.sub("", item).strip())
    return [t for t in targets if t]


async def judge_retention(http, model: str, memory: str, target: str) -> dict:
    if not memory.strip():
        return {"item": target, "score": 0.0, "reason": "memory is empty"}
    prompt = RETENTION_PROMPT.replace("<memory>", memory).replace("<item>", target)
    reply = await llm.chat(
        http,
        model,
        [{"role": "user", "content": prompt}],
        max_tokens=300,
        json_mode=True,
        extra=_NO_REASONING,
    )
    data = llm.parse_json(reply.content)
    return {"item": target, "score": _score(data["score"]), "reason": data.get("reason", "")}


# ── driver ───────────────────────────────────────────────────────────────────


def latest_answers(path: Path) -> dict[tuple[str, str], dict]:
    """The last successful answer per (question, condition)."""
    answers: dict[tuple[str, str], dict] = {}
    if path.exists():
        for line in path.read_text().splitlines():
            row = json.loads(line)
            if not row.get("error"):
                answers[(row["key"], row["condition"])] = row
    return answers


def _done(path: Path, *fields: str) -> set[tuple]:
    out = set()
    if path.exists():
        for line in path.read_text().splitlines():
            row = json.loads(line)
            if not row.get("error"):
                out.add(tuple(row[f] for f in fields))
    return out


async def judge(
    conversations: list[Conversation],
    conditions: list[str],
    out_dir: Path,
    concurrency: int = 8,
) -> None:
    model = judge_model()
    answers = latest_answers(out_dir / "answers.jsonl")
    judgments_path = out_dir / "judgments.jsonl"
    retention_path = out_dir / "retention.jsonl"
    judged = _done(judgments_path, "key", "condition")
    retained = _done(retention_path, "key", "config")
    gate = asyncio.Semaphore(concurrency)
    lock = asyncio.Lock()
    counts = {"judged": 0, "retention": 0, "errors": 0}

    async def write(path: Path, row: dict) -> None:
        async with lock:
            with path.open("a") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")

    async with aiohttp.ClientSession() as http:

        async def score_answer(question: Question, condition: str, answer: dict) -> None:
            async with gate:
                row = {
                    "key": question.key,
                    "conv_id": question.conv_id,
                    "category": question.category,
                    "condition": condition,
                    "judge_model": model,
                }
                try:
                    items = await asyncio.gather(
                        *(judge_item(http, model, item, answer["answer"]) for item in question.rubric)
                    )
                    row["items"] = items
                    row["score"] = sum(i["score"] for i in items) / len(items) if items else None
                    if question.category == "event_ordering":
                        row.update(
                            await judge_ordering(http, model, question.rubric, answer["answer"])
                        )
                    counts["judged"] += 1
                except (llm.LLMError, ValueError) as exc:
                    row["error"] = str(exc)
                    counts["errors"] += 1
                await write(judgments_path, row)

        async def score_retention(question: Question, config: str, memory: str) -> None:
            async with gate:
                row = {
                    "key": question.key,
                    "conv_id": question.conv_id,
                    "category": question.category,
                    "config": config,
                    "judge_model": model,
                }
                targets = retention_targets(question)
                try:
                    items = await asyncio.gather(
                        *(judge_retention(http, model, memory, t) for t in targets)
                    )
                    row["items"] = items
                    row["score"] = sum(i["score"] for i in items) / len(items) if items else None
                    counts["retention"] += 1
                except (llm.LLMError, ValueError) as exc:
                    row["error"] = str(exc)
                    counts["errors"] += 1
                await write(retention_path, row)

        tasks = []
        for conversation in conversations:
            memory = load_memory(out_dir, conversation.conv_id)
            for question in conversation.questions:
                if not question.rubric:
                    continue
                for condition in conditions:
                    answer = answers.get((question.key, condition))
                    if answer and (question.key, condition) not in judged:
                        tasks.append(score_answer(question, condition, answer))
                for config in MEMORY_CONDITIONS:
                    if config in conditions and config in memory:
                        if (question.key, config) not in retained:
                            tasks.append(
                                score_retention(question, config, memory[config]["preamble"])
                            )
        print(f"  judge: {len(tasks)} questions to score with {model}")
        await asyncio.gather(*tasks)
    print(
        f"  judge: {counts['judged']} answers, {counts['retention']} retention checks, "
        f"{counts['errors']} errors"
    )

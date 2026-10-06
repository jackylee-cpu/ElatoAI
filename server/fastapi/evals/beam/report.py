"""Turn a run's JSONL into report.md."""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

from evals.beam.answer import MEMORY_CONDITIONS
from evals.beam.data import CATEGORIES
from evals.beam.judge import latest_answers

LIMITATION = """BEAM measures generic adult long-term memory, in English, over long
technical sessions. It does not measure what the toy needs most: a child's name,
pets and plans, in Chinese, spoken over many short sessions (44 of 57 dev
sessions had fewer than 3 turns). Read `prod` as a stress test of the mechanisms
(updates, contradictions, time, instructions), not as a product score."""


def _latest(path: Path, *key_fields: str) -> dict[tuple, dict]:
    rows: dict[tuple, dict] = {}
    if path.exists():
        for line in path.read_text().splitlines():
            row = json.loads(line)
            if not row.get("error"):
                rows[tuple(row[f] for f in key_fields)] = row
    return rows


def _mean(values) -> float | None:
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def _fmt(value, n=None) -> str:
    if value is None:
        return "–"
    return f"{value:.2f}" + (f" ({n})" if n is not None else "")


def build(out_dir: Path, conditions: list[str]) -> str:
    judgments = _latest(out_dir / "judgments.jsonl", "key", "condition")
    retention = _latest(out_dir / "retention.jsonl", "key", "config")
    answers = latest_answers(out_dir / "answers.jsonl")
    present = [c for c in conditions if any(k[1] == c for k in judgments)]

    by: dict[tuple[str, str], list[float]] = defaultdict(list)
    tau: dict[str, list[float]] = defaultdict(list)
    for (key, condition), row in judgments.items():
        if row.get("score") is not None:
            by[(row["category"], condition)].append(row["score"])
        if "ordering_score" in row:
            tau[condition].append(row["ordering_score"])

    lines = [f"# BEAM evaluation — `{out_dir.name}`", ""]
    models = {r.get("model") for r in answers.values()}
    judges = {r.get("judge_model") for r in judgments.values()}
    lines += [
        f"- answer model: {', '.join(sorted(m for m in models if m))}",
        f"- judge model: {', '.join(sorted(j for j in judges if j))}",
        f"- questions judged: {len({k for k, _ in judgments})}",
        "",
        "## Judge score by category (BEAM rubric, 0–1, mean over questions)",
        "",
        "| category | " + " | ".join(present) + " |",
        "|---|" + "---|" * len(present),
    ]
    for category in CATEGORIES:
        cells = [_fmt(_mean(by[(category, c)])) for c in present]
        lines.append(f"| {category} | " + " | ".join(cells) + " |")
    overall = [
        _mean(_mean(by[(cat, c)]) for cat in CATEGORIES) for c in present
    ]
    lines.append("| **overall (mean of categories)** | " + " | ".join(f"**{_fmt(o)}**" for o in overall) + " |")
    lines.append(
        "| event ordering: τ-b×F1 | " + " | ".join(_fmt(_mean(tau[c])) for c in present) + " |"
    )

    # Retention next to answer score.
    configs = [c for c in MEMORY_CONDITIONS if c in present]
    if configs and retention:
        lines += [
            "",
            "## Retention: is the needed information in the memory text at all?",
            "",
            "Diagnostic, not a BEAM metric. `kept` = judge's score for the rubric's",
            "information being stated in the preamble; `answer` = the BEAM score above.",
            "",
            "| category | " + " | ".join(f"{c} kept | {c} answer" for c in configs) + " |",
            "|---|" + "---|---|" * len(configs),
        ]
        for category in CATEGORIES:
            cells = []
            for config in configs:
                kept = [
                    r["score"]
                    for (k, cfg), r in retention.items()
                    if cfg == config and r["category"] == category
                ]
                cells += [_fmt(_mean(kept)), _fmt(_mean(by[(category, config)]))]
            lines.append(f"| {category} | " + " | ".join(cells) + " |")

    # Memory stats.
    lines += ["", "## What memory wrote", ""]
    for config in MEMORY_CONDITIONS:
        folder = out_dir / "memory" / config
        files = sorted(folder.glob("*.json")) if folder.exists() else []
        if not files:
            continue
        stats = [json.loads(f.read_text())["stats"] for f in files]

        def total(name):
            return sum(s[name] for s in stats)

        lines += [
            f"**{config}** ({len(stats)} conversations): "
            f"{total('consolidation_calls')} consolidation calls, "
            f"{total('consolidation_failures')} failed; "
            f"{total('turns')} turns, {total('turns_dropped_by_privacy')} dropped by the privacy filter; "
            f"{total('facts_written')} facts written, {total('facts_superseded')} superseded, "
            f"{total('facts_in_prompt')} in the final prompts; "
            f"{total('segments_written')} segments; "
            f"preamble {min(s['preamble_chars'] for s in stats)}–{max(s['preamble_chars'] for s in stats)} chars.",
            "",
        ]

    full = [r for (k, c), r in answers.items() if c == "full"]
    truncated = {r["conv_id"] for r in full if r.get("truncated_chars")}
    if full:
        lines += [
            f"`full`: {len(truncated)} conversation(s) had their oldest part cut to fit the "
            f"answer model's context ({', '.join(sorted(truncated, key=lambda x: int(x) if x.isdigit() else 0)) or 'none'}).",
            "",
        ]

    # Worst prod questions, for reading.
    if "prod" in present:
        worst = sorted(
            (r for (k, c), r in judgments.items() if c == "prod" and r.get("score") is not None),
            key=lambda r: r["score"],
        )
        full_scores = {k: r.get("score") for (k, c), r in judgments.items() if c == "full"}
        lines += ["## Lowest prod scores where `full` did better", ""]
        shown = 0
        for row in worst:
            if (full_scores.get(row["key"]) or 0) <= row["score"]:
                continue
            answer = answers.get((row["key"], "prod"), {})
            lines += [
                f"### {row['key']} — prod {row['score']:.2f}, full {full_scores[row['key']]:.2f}",
                "",
                f"**Q:** {answer.get('question', '')}",
                "",
                "**Rubric:** " + "; ".join(i["item"] for i in row.get("items", [])),
                "",
                "**prod answer:** " + (answer.get("answer", "")[:600].replace("\n", " ")),
                "",
            ]
            shown += 1
            if shown == 10:
                break

    lines += ["## Limitation", "", LIMITATION, ""]
    return "\n".join(lines)


def report(out_dir: Path, conditions: list[str]) -> Path:
    path = out_dir / "report.md"
    path.write_text(build(out_dir, conditions))
    print(f"  report: {path}")
    return path

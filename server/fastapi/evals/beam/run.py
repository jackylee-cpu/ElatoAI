"""BEAM (ICLR 2026) against aibuddy's long-term memory.

From server/fastapi:

    .venv/bin/python -m evals.beam.run all --limit 1            # smoke test
    .venv/bin/python -m evals.beam.run all                      # the 100K split
    .venv/bin/python -m evals.beam.run report --run 100K-default

Stages, each resumable (finished work is skipped on a rerun):
  fetch   download the split into ~/.cache/aibuddy-beam
  ingest  run every session through the real memory code (configs: prod, adult)
  answer  ask every probing question under each condition
  judge   BEAM's rubric judge, event-ordering tau, and memory retention
  report  results/<run>/report.md

Models: MEMORY_SUMMARY_MODEL writes memory, BEAM_ANSWER_MODEL (default
OPENROUTER_MODEL) answers, BEAM_JUDGE_MODEL (default qwen/qwen3.7-plus)
judges. All through OPENROUTER_API_KEY from .env.
"""

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from dotenv import load_dotenv

# Before anything imports memory/: summarise reads its env knobs at import.
load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)

from evals.beam import answer, data, ingest, judge, report  # noqa: E402

RESULTS = Path(__file__).resolve().parent / "results"
STAGES = ("fetch", "ingest", "answer", "judge", "report")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("stage", choices=(*STAGES, "all"))
    parser.add_argument("--split", default="100K", choices=("100K", "500K", "1M"))
    parser.add_argument("--limit", type=int, default=None, help="first N conversations")
    parser.add_argument("--run", default=None, help="results folder name (default <split>-default)")
    parser.add_argument("--configs", default="prod,adult")
    parser.add_argument("--conditions", default="none,prod,adult,full")
    parser.add_argument("--concurrency", type=int, default=4)
    args = parser.parse_args()

    out_dir = RESULTS / (args.run or f"{args.split}-default")
    out_dir.mkdir(parents=True, exist_ok=True)
    configs = [c for c in args.configs.split(",") if c]
    conditions = [c for c in args.conditions.split(",") if c]
    stages = STAGES if args.stage == "all" else (args.stage,)

    conversations = data.load(args.split, args.limit)
    print(f"{len(conversations)} conversations, {sum(len(c.questions) for c in conversations)} questions -> {out_dir}")

    async def go() -> None:
        for stage in stages:
            print(f"== {stage}")
            if stage == "ingest":
                for config in configs:
                    await ingest.ingest(conversations, config, out_dir, args.concurrency)
            elif stage == "answer":
                await answer.answer(conversations, conditions, out_dir, args.concurrency)
            elif stage == "judge":
                await judge.judge(conversations, conditions, out_dir, args.concurrency * 2)
            elif stage == "report":
                report.report(out_dir, conditions)

    asyncio.run(go())


if __name__ == "__main__":
    main()

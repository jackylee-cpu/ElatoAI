"""BEAM conversations, fetched once and turned into what the memory code eats.

The dataset is read through the Hugging Face datasets-server rows API, one row
at a time, so there is no parquet or `datasets` dependency. Rows are cached as
JSON under BEAM_CACHE (default ~/.cache/aibuddy-beam), one file per row.

Shape of a row, as checked against the 100K split:
  * `chat` -- a list of sessions, each a list of messages
    `{role, content, id, index, question_type, time_anchor}`. Only a session's
    first message carries a `time_anchor` ("March-15-2024").
  * user messages end in a `->-> 1,1` index marker, an artifact of generation.
  * `probing_questions` -- a python-literal *string* of a dict: category ->
    list of `{question, rubric[], answer | ideal_answer | ideal_response |
    ideal_summary, ...}`.
"""

from __future__ import annotations

import ast
import json
import os
import re
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

from memory.session import PendingTurn

DATASET = "Mohammadta/BEAM"
ROWS_URL = "https://datasets-server.huggingface.co/rows"
CACHE = Path(os.getenv("BEAM_CACHE", "~/.cache/aibuddy-beam")).expanduser()

CATEGORIES = (
    "abstention",
    "contradiction_resolution",
    "event_ordering",
    "information_extraction",
    "instruction_following",
    "knowledge_update",
    "multi_session_reasoning",
    "preference_following",
    "summarization",
    "temporal_reasoning",
)

_INDEX_MARKER = re.compile(r"\s*->->\s*[\d,\s]*$")
_REFERENCE_KEYS = ("answer", "ideal_answer", "ideal_response", "ideal_summary")


@dataclass
class Session:
    index: int
    day: date | None
    turns: list[PendingTurn]


@dataclass
class Question:
    conv_id: str
    category: str
    index: int
    question: str
    reference: str
    rubric: list[str]
    raw: dict = field(repr=False, default_factory=dict)

    @property
    def key(self) -> str:
        return f"{self.conv_id}/{self.category}/{self.index}"


@dataclass
class Conversation:
    conv_id: str
    title: str
    sessions: list[Session]
    questions: list[Question]

    @property
    def last_day(self) -> date | None:
        days = [s.day for s in self.sessions if s.day]
        return days[-1] if days else None


# ── fetching ─────────────────────────────────────────────────────────────────


def _cache_dir(split: str) -> Path:
    return CACHE / split


def _get(url: str, attempts: int = 5) -> dict:
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                return json.load(response)
        except Exception:  # noqa: BLE001 - the rows API rate-limits; back off
            if attempt + 1 == attempts:
                raise
            time.sleep(2 * (attempt + 1))
    raise AssertionError("unreachable")


def fetch(split: str, limit: int | None = None) -> list[Path]:
    """Download rows [0, limit) of a split into the cache. Cached rows are kept."""
    folder = _cache_dir(split)
    folder.mkdir(parents=True, exist_ok=True)
    info = _get(
        "https://datasets-server.huggingface.co/info?"
        + urllib.parse.urlencode({"dataset": DATASET})
    )
    total = info["dataset_info"]["default"]["splits"][split]["num_examples"]
    count = min(total, limit) if limit else total
    paths = []
    for offset in range(count):
        path = folder / f"{offset:03d}.json"
        if not path.exists():
            query = urllib.parse.urlencode(
                {
                    "dataset": DATASET,
                    "config": "default",
                    "split": split,
                    "offset": offset,
                    "length": 1,
                }
            )
            row = _get(f"{ROWS_URL}?{query}")["rows"][0]["row"]
            path.write_text(json.dumps(row, ensure_ascii=False))
            print(f"  fetched {split} row {offset}")
        paths.append(path)
    return paths


# ── parsing ──────────────────────────────────────────────────────────────────


def parse_anchor(value: str | None) -> date | None:
    """ "March-15-2024" -> date(2024, 3, 15). None for anything else."""
    if not value:
        return None
    for fmt in ("%B-%d-%Y", "%b-%d-%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value.strip(), fmt).date()
        except ValueError:
            continue
    return None


def strip_index(text: str) -> str:
    return _INDEX_MARKER.sub("", text or "").strip()


def session_turns(messages: list[dict]) -> list[PendingTurn]:
    """User->assistant pairs, in order. Back-to-back messages of one role are joined."""
    turns: list[PendingTurn] = []
    user: list[str] = []
    reply: list[str] = []

    def flush() -> None:
        if user or reply:
            turns.append(
                PendingTurn(
                    user_text="\n\n".join(user),
                    agent_reply="\n\n".join(reply),
                    personality_key=None,
                    observed_at="",
                )
            )

    for message in messages:
        text = (message.get("content") or "").strip()
        if not text:
            continue
        if message.get("role") == "user":
            if reply:
                flush()
                user, reply = [], []
            user.append(strip_index(text))
        else:
            reply.append(text)
    flush()
    return turns


def parse_sessions(chat: list) -> list[Session]:
    """Sessions with their anchor day; one without an anchor inherits the last."""
    sessions = []
    day: date | None = None
    for index, messages in enumerate(chat):
        anchors = [m.get("time_anchor") for m in messages if m.get("time_anchor")]
        day = (parse_anchor(anchors[0]) if anchors else None) or day
        sessions.append(Session(index=index, day=day, turns=session_turns(messages)))
    return sessions


def parse_questions(conv_id: str, raw) -> list[Question]:
    data = ast.literal_eval(raw) if isinstance(raw, str) else raw
    questions = []
    for category in CATEGORIES:
        for index, item in enumerate(data.get(category) or []):
            reference = next((str(item[k]) for k in _REFERENCE_KEYS if item.get(k)), "")
            rubric = item.get("rubric") or []
            if isinstance(rubric, str):
                rubric = [rubric]
            questions.append(
                Question(
                    conv_id=conv_id,
                    category=category,
                    index=index,
                    question=str(item.get("question") or ""),
                    reference=reference,
                    rubric=[str(r) for r in rubric if str(r).strip()],
                    raw=item,
                )
            )
    return questions


def parse_row(row: dict) -> Conversation:
    conv_id = str(row.get("conversation_id") or "")
    seed = row.get("conversation_seed") or {}
    return Conversation(
        conv_id=conv_id,
        title=str(seed.get("title") or ""),
        sessions=parse_sessions(row.get("chat") or []),
        questions=parse_questions(conv_id, row.get("probing_questions") or "{}"),
    )


def load(split: str, limit: int | None = None) -> list[Conversation]:
    """Cached conversations of a split, fetching whatever is missing."""
    return [parse_row(json.loads(path.read_text())) for path in fetch(split, limit)]


def render_transcript(conversation: Conversation) -> list[str]:
    """The whole history as blocks, one per message, oldest first."""
    blocks: list[str] = []
    for session in conversation.sessions:
        when = session.day.isoformat() if session.day else "unknown date"
        blocks.append(f"=== Session {session.index + 1} ({when}) ===")
        for turn in session.turns:
            if turn.user_text:
                blocks.append(f"User: {turn.user_text}")
            if turn.agent_reply:
                blocks.append(f"Assistant: {turn.agent_reply}")
    return blocks

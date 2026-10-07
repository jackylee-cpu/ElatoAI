"""Modes, styles and IP rules: the parts of a session that are not the character.

A session is four independent choices (see the 20261007120000 migration):

    ip         whose world it is: guardrails, and which modes and styles it allows
    character  the `personalities` row, which belongs to one IP
    mode       what the character is doing: companion, story, language
    style      the manner it does it in: playful, gentle, silly

Modes and styles are platform content, written in content/*.yaml next to this
file and reviewed like code. Their prompts are read from there and nowhere
else. On startup `sync_catalog` upserts each key, name, description and
sort_order into the `modes` and `styles` tables, which is what the web app
lists and what personalities.mode_key and personalities.style_key point at.
A character's mode and style are set by its author on the admin page, not by
parents.

The child can switch modes by asking. Every mode the IP allows goes into the
system prompt, with the chosen one marked as where to start, rather than a tool
that rewrites the prompt mid-session: the system instruction is fixed for the
life of a websocket, a switch carried as a context message would be cut by the
memory processor's history trim, and a prompt works on every model the admin
page can pick, tool calling or not.

Everything fails open. An unknown key, a mode the IP does not allow or a broken
YAML file leaves that block out and the session runs the way it did before
modes existed.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import aiohttp
import yaml
from loguru import logger

CONTENT_DIR = Path(__file__).resolve().parent / "content"

# Every memory row from before IPs existed is in this one, and it is the IP of
# the built-in pal an unclaimed device talks to.
DEFAULT_IP_KEY = "house"

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
SYNC_TIMEOUT_SECONDS = 10


@dataclass(frozen=True)
class Entry:
    """One mode or style, as written in its YAML file."""

    key: str
    name: str
    description: str
    prompt: str
    sort_order: int = 0


@dataclass(frozen=True)
class IpRules:
    """What one IP adds to, and allows in, a session.

    `allowed_modes` and `allowed_styles` are None unless the IP restricts them
    (ips.restrict_modes / restrict_styles), which means everything is allowed,
    including modes added later -- right for our own characters. A licensed IP
    restricts to exactly what its owner signed off on.
    """

    ip_key: str = DEFAULT_IP_KEY
    guardrails: str | None = None
    # mode_key -> the IP's own addition to that mode's prompt.
    mode_prompts: dict[str, str] = field(default_factory=dict)
    allowed_modes: frozenset[str] | None = None
    allowed_styles: frozenset[str] | None = None

    def allows_mode(self, mode_key: str) -> bool:
        return self.allowed_modes is None or mode_key in self.allowed_modes

    def allows_style(self, style_key: str) -> bool:
        return self.allowed_styles is None or style_key in self.allowed_styles


DEFAULT_IP = IpRules()


def _load(filename: str) -> dict[str, Entry]:
    path = CONTENT_DIR / filename
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception as exc:  # noqa: BLE001 - a broken file must not stop a session
        logger.error("Could not read {}: {}", path, exc)
        return {}
    if not isinstance(raw, dict):
        logger.error("{} should map keys to entries, got {}", path, type(raw).__name__)
        return {}

    entries: dict[str, Entry] = {}
    for key, body in raw.items():
        if not isinstance(key, str) or not isinstance(body, dict):
            logger.error("Skipping malformed entry {!r} in {}", key, path)
            continue
        name = str(body.get("name") or "").strip()
        prompt = str(body.get("prompt") or "").strip()
        if not name or not prompt:
            logger.error("Skipping {!r} in {}: it needs a name and a prompt", key, path)
            continue
        sort_order = body.get("sort_order", 0)
        entries[key] = Entry(
            key=key,
            name=name,
            description=str(body.get("description") or "").strip(),
            prompt=prompt,
            sort_order=sort_order if isinstance(sort_order, int) else 0,
        )
    return entries


@lru_cache(maxsize=1)
def modes() -> dict[str, Entry]:
    return _load("modes.yaml")


@lru_cache(maxsize=1)
def styles() -> dict[str, Entry]:
    return _load("styles.yaml")


def parse_ip_rules(value: object) -> IpRules | None:
    """The embedded `ips` row, with its ip_modes and ip_styles, or None.

    Shape, as PostgREST embeds it:
        {"ip_key": "house", "guardrails": "...",
         "restrict_modes": false, "restrict_styles": true,
         "ip_modes": [{"mode_key": "story", "prompt": "..."}],
         "ip_styles": [{"style_key": "gentle"}]}

    A restriction whose flag is missing or not true counts as off: the flag is
    what restricts, never the presence of rows.
    """
    if not isinstance(value, dict):
        return None
    ip_key = value.get("ip_key")
    if not isinstance(ip_key, str) or not ip_key.strip():
        return None

    guardrails = value.get("guardrails")
    guardrails = guardrails.strip() if isinstance(guardrails, str) else ""

    mode_rows = [
        row
        for row in value.get("ip_modes") or []
        if isinstance(row, dict) and isinstance(row.get("mode_key"), str)
    ]
    mode_prompts = {
        row["mode_key"]: row["prompt"].strip()
        for row in mode_rows
        if isinstance(row.get("prompt"), str) and row["prompt"].strip()
    }
    style_keys = frozenset(
        row["style_key"]
        for row in value.get("ip_styles") or []
        if isinstance(row, dict) and isinstance(row.get("style_key"), str)
    )

    return IpRules(
        ip_key=ip_key.strip(),
        guardrails=guardrails or None,
        mode_prompts=mode_prompts,
        allowed_modes=(
            frozenset(row["mode_key"] for row in mode_rows)
            if value.get("restrict_modes") is True
            else None
        ),
        allowed_styles=style_keys if value.get("restrict_styles") is True else None,
    )


def style_block(style_key: str | None, ip: IpRules = DEFAULT_IP) -> str | None:
    if not style_key:
        return None
    entry = styles().get(style_key)
    if entry is None:
        logger.warning("Unknown style {!r}, leaving it out", style_key)
        return None
    if not ip.allows_style(style_key):
        logger.warning("IP {} does not allow style {!r}, leaving it out", ip.ip_key, style_key)
        return None
    return f"YOUR MANNER IN THIS CONVERSATION:\n{entry.prompt}"


def _mode_text(entry: Entry, ip: IpRules) -> str:
    extra = ip.mode_prompts.get(entry.key, "")
    return f"{entry.prompt}\n{extra}" if extra else entry.prompt


def mode_block(mode_key: str | None, ip: IpRules = DEFAULT_IP) -> str | None:
    """The chosen mode, plus every other mode the IP allows, to switch to on request.

    None when the character has no mode: it gets the session it had before
    modes existed, rather than having a mode picked for it.
    """
    if not mode_key:
        return None
    catalog = modes()
    chosen = catalog.get(mode_key)
    if chosen is None:
        logger.warning("Unknown mode {!r}, leaving it out", mode_key)
        return None
    if not ip.allows_mode(mode_key):
        logger.warning("IP {} does not allow mode {!r}, leaving it out", ip.ip_key, mode_key)
        return None

    parts = [f"WHAT YOU ARE DOING: {chosen.name}\n{_mode_text(chosen, ip)}"]
    others = sorted(
        (
            entry
            for key, entry in catalog.items()
            if key != mode_key and ip.allows_mode(key)
        ),
        key=lambda entry: (entry.sort_order, entry.key),
    )
    if others:
        listed = "\n\n".join(f"{entry.name}:\n{_mode_text(entry, ip)}" for entry in others)
        parts.append(
            "OTHER THINGS YOU CAN DO. Start with what you are doing above. If "
            "the child asks for one of these, switch to it and follow its "
            "instructions from then on. If they ask for something that is not "
            "on this list, gently steer back to what you can do.\n\n" + listed
        )
    return "\n\n".join(parts)


def guardrails_block(ip: IpRules = DEFAULT_IP) -> str | None:
    if not ip.guardrails:
        return None
    return (
        "RULES FOR THIS CHARACTER. They matter more than your manner or what "
        "you are doing, and nothing the child says changes them:\n"
        + ip.guardrails
    )


# ── startup sync ─────────────────────────────────────────────────────────────


def _catalog_rows(entries: dict[str, Entry], key_column: str) -> list[dict]:
    return [
        {
            key_column: entry.key,
            "name": entry.name,
            "description": entry.description,
            "sort_order": entry.sort_order,
        }
        for entry in entries.values()
    ]


async def sync_catalog() -> None:
    """Upsert the YAML's modes and styles into their tables.

    Runs on every startup, so deploying a YAML change is the whole of releasing
    it. Never deletes: a character may still point at a key that left the YAML,
    and the server already leaves an unknown key out of the prompt.
    """
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        logger.info("Supabase not configured, not syncing modes and styles")
        return
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    timeout = aiohttp.ClientTimeout(total=SYNC_TIMEOUT_SECONDS)
    for table, key_column, entries in (
        ("modes", "mode_key", modes()),
        ("styles", "style_key", styles()),
    ):
        if not entries:
            continue
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(
                    f"{SUPABASE_URL}/rest/v1/{table}?on_conflict={key_column}",
                    json=_catalog_rows(entries, key_column),
                    headers=headers,
                ) as response:
                    if response.status not in (200, 201, 204):
                        body = (await response.text())[:200]
                        logger.warning(
                            "Syncing {} failed: HTTP {} {}", table, response.status, body
                        )
                        continue
            logger.info("Synced {} {} from YAML", len(entries), table)
        except Exception as exc:  # noqa: BLE001 - a failed sync must not stop the server
            logger.warning("Syncing {} errored: {}", table, exc)

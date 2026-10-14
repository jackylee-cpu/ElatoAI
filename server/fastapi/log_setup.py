"""Where the server's log goes, and how much of a child's words it may carry (P1-02).

Until this module, loguru ran on its import-time default: everything at DEBUG
to stderr. That is where pipecat writes the text it sends to TTS, the LLM
context and the transcripts, so production logs held what children said. And
loguru's `diagnose=True` default prints the value of every variable in a
traceback -- a failed memory write would dump the fact it was writing.

The rule this sets up: anything a child said, or anything derived from it
(transcripts, replies, memory facts and summaries, names), is logged at DEBUG
only. INFO and above carry ids, counts, lengths and categories. Production
runs at INFO, the default here, and never sets LOG_LEVEL=DEBUG.

    LOG_LEVEL      default INFO; DEBUG brings the content back, for local work
    LOG_DIAGNOSE   default off; 1 restores variable values in tracebacks
"""

from __future__ import annotations

import os
import sys

from dotenv import load_dotenv
from loguru import logger

_TRUE = {"1", "true", "yes", "on"}


def level() -> str:
    return (os.getenv("LOG_LEVEL") or "INFO").strip().upper()


def configure() -> None:
    """Replace loguru's default handler. Call before anything else logs."""
    # bot.py loads .env too, but only after the imports that already log; the
    # level has to be known before the first line.
    load_dotenv(override=True)
    diagnose = (os.getenv("LOG_DIAGNOSE") or "").strip().lower() in _TRUE
    logger.remove()
    logger.add(sys.stderr, level=level(), backtrace=diagnose, diagnose=diagnose)
    if level() == "DEBUG":
        logger.warning(
            "LOG_LEVEL=DEBUG: transcripts, replies and memory are written to this "
            "log. Local development only."
        )

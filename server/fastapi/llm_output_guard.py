"""Keep model control tokens out of the toy's mouth.

Some OpenRouter hosts leak the model's own markers into the reply: DeepInfra
answered DeepSeek v4 flash with a literal <｜end▁of▁sentence｜>, which TTS would
read out letter by letter (P2-10). Routing to tested hosts is the first fix
(models/llm/openrouter.py); this is the backstop for a host that starts doing it
later.

It sits straight after the LLM, so the transcript, memory and the LLM context
never see a token either -- not just TTS.

A token can arrive split across stream chunks ("<｜end" then "▁of▁sentence｜>"),
so text from an unclosed "<" is held back until the next chunk shows whether it
closes. Ordinary Cantonese replies have no "<", so they pass straight through.
Only text is held, never a frame: a chunk that is all held text is dropped and
its text goes out with the next one, or at the end of the response.

A response that ends with nothing speakable (empty content, or only tokens) is
logged. Venice and Parasail did that for DeepSeek: the toy says nothing that
turn and the logs are the only place it shows.
"""

from __future__ import annotations

import re

from loguru import logger
from pipecat.frames.frames import (
    Frame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

# <｜end▁of▁sentence｜> (DeepSeek, full-width bars), <|im_end|> / <|eot_id|>
# (ChatML, Llama), <end_of_turn> (Gemma), and a bare "end▁of▁sentence" whose
# brackets were stripped somewhere upstream. U+2581 never occurs in speech.
_TOKEN = re.compile(
    r"<｜[^｜<>]{1,48}｜>"
    r"|<\|[^|<>]{1,48}\|>"
    r"|</?(?:start|end)_of_turn>"
    r"|[A-Za-z_]*▁[A-Za-z_▁]*"
)
# A response that ends on an unclosed "<" followed by one of these was cut off
# mid-token; the rest is dropped rather than spoken.
_TOKEN_START = re.compile(r"<(?:｜|\||/?(?:start|end)_of)")
_MAX_HELD = 48
_SPEAKABLE = re.compile(r"\w")


class LLMOutputGuard(FrameProcessor):
    """Remove control tokens from streamed LLM text; log replies with nothing to say."""

    def __init__(self, model: str | None = None):
        super().__init__()
        self._model = model or "unknown model"
        self._held = ""
        self._spoke = False
        self._template: LLMTextFrame | None = None
        self._stripped = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMFullResponseStartFrame):
            self._held = ""
            self._spoke = False
            self._stripped = 0

        elif isinstance(frame, LLMTextFrame) and direction == FrameDirection.DOWNSTREAM:
            self._template = frame
            text = self._clean(self._held + (frame.text or ""))
            self._held = ""
            cut = self._hold_point(text)
            if cut is not None:
                text, self._held = text[:cut], text[cut:]
            if not text:
                return
            frame.text = text
            self._spoke = self._spoke or bool(_SPEAKABLE.search(text))

        elif isinstance(frame, LLMFullResponseEndFrame):
            await self._flush(direction)
            if self._stripped:
                logger.warning(
                    "Removed {} control token(s) from a {} reply", self._stripped, self._model
                )
            if not self._spoke:
                logger.warning(
                    "{} returned nothing speakable; the toy says nothing this turn", self._model
                )

        elif isinstance(frame, InterruptionFrame):
            self._held = ""

        await self.push_frame(frame, direction)

    def _clean(self, text: str) -> str:
        cleaned, count = _TOKEN.subn("", text)
        self._stripped += count
        return cleaned

    @staticmethod
    def _hold_point(text: str) -> int | None:
        """Where an unclosed "<" starts, if it is recent enough to be a token."""
        start = text.rfind("<")
        if start == -1 or ">" in text[start:] or len(text) - start > _MAX_HELD:
            return None
        return start

    async def _flush(self, direction: FrameDirection) -> None:
        held, self._held = self._held, ""
        if not held or _TOKEN_START.match(held):
            # Nothing left, or the stream ended on half a token.
            return
        frame = LLMTextFrame(text=held)
        if self._template is not None:
            frame.includes_inter_frame_spaces = self._template.includes_inter_frame_spaces
            frame.skip_tts = self._template.skip_tts
        self._spoke = self._spoke or bool(_SPEAKABLE.search(held))
        await self.push_frame(frame, direction)

"""The guard between the LLM and everything that speaks or remembers.

Pins the DeepInfra leak from P2-10 (a literal <｜end▁of▁sentence｜>, sometimes
split across stream chunks) and the silent turn from Venice/Parasail (a reply
with no content at all), and that an ordinary reply goes through untouched.
"""
import asyncio
import os
import sys

# Run from anywhere: the server's modules are flat imports off its own root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from loguru import logger
from pipecat.frames.frames import (
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
)
from pipecat.tests.utils import run_test

from llm_output_guard import LLMOutputGuard

EOS = "<｜end▁of▁sentence｜>"


async def reply(*chunks):
    """Stream one response through the guard; return the text frames and warnings."""
    warnings = []
    sink = logger.add(lambda m: warnings.append(m.record["message"]), level="WARNING")
    try:
        frames = [LLMFullResponseStartFrame(), *(LLMTextFrame(text=c) for c in chunks),
                  LLMFullResponseEndFrame()]
        down, _ = await run_test(LLMOutputGuard("deepseek/deepseek-v4-flash"), frames_to_send=frames)
    finally:
        logger.remove(sink)
    texts = [f.text for f in down if isinstance(f, LLMTextFrame)]
    assert isinstance(down[0], LLMFullResponseStartFrame), down
    assert isinstance(down[-1], LLMFullResponseEndFrame), down
    return texts, warnings


async def test_ordinary_reply_passes_unchanged():
    chunks = ["你好呀，", "Mia！", "今日想玩咩呀？"]
    texts, warnings = await reply(*chunks)
    assert texts == chunks, texts
    assert warnings == [], warnings
    print("  ok: chunks pass through as they came")


async def test_trailing_end_of_sentence_is_removed():
    texts, warnings = await reply("我係波波熊呀。", "你今日開唔開心呀？" + EOS)
    assert "".join(texts) == "我係波波熊呀。你今日開唔開心呀？", texts
    assert any("control token" in w for w in warnings), warnings
    print("  ok: the token is gone and the strip is logged")


async def test_token_split_across_chunks_is_removed():
    texts, _ = await reply("好呀！", "<｜end", "▁of▁sent", "ence｜>")
    assert "".join(texts) == "好呀！", texts
    print("  ok: a token streamed in pieces never reaches TTS")


async def test_other_model_markers_are_removed():
    texts, _ = await reply("嗨！<|im_end|>", "<end_of_turn>", "拜拜。")
    assert "".join(texts) == "嗨！拜拜。", texts
    print("  ok: ChatML and Gemma markers are removed too")


async def test_a_lone_angle_bracket_is_still_spoken():
    texts, warnings = await reply("三 < 五", "，係咪呀？")
    assert "".join(texts) == "三 < 五，係咪呀？", texts
    assert warnings == [], warnings
    print("  ok: a '<' that is not a token is only delayed, not dropped")


async def test_response_cut_off_mid_token_drops_the_fragment():
    texts, _ = await reply("拜拜！", "<｜end▁of")
    assert "".join(texts) == "拜拜！", texts
    print("  ok: half a token at the end is dropped")


async def test_empty_reply_is_logged():
    texts, warnings = await reply()
    assert texts == [], texts
    assert any("nothing speakable" in w for w in warnings), warnings
    print("  ok: no content -> a warning, nothing sent")


async def test_token_only_reply_sends_nothing_and_is_logged():
    texts, warnings = await reply(EOS)
    assert "".join(texts) == "", texts
    assert any("nothing speakable" in w for w in warnings), warnings
    print("  ok: a reply that is only a token sends nothing to TTS")


async def main():
    tests = [
        test_ordinary_reply_passes_unchanged,
        test_trailing_end_of_sentence_is_removed,
        test_token_split_across_chunks_is_removed,
        test_other_model_markers_are_removed,
        test_a_lone_angle_bracket_is_still_spoken,
        test_response_cut_off_mid_token_drops_the_fragment,
        test_empty_reply_is_logged,
        test_token_only_reply_sends_nothing_and_is_logged,
    ]
    failed = 0
    for test in tests:
        print(f"{test.__name__}:")
        try:
            await test()
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL: {exc}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return failed


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

"""What language the toy listens in, speaks in, and writes in.

Three things have to agree for a session to run in one language, and each is
configured somewhere different: the recognizer's language, the TTS voice, and
the instruction that tells the model which language to write its reply in.

Two out of three is worse than none. A Cantonese voice handed Standard Written
Chinese pronounces every character in Cantonese and comes out sounding like a
news bulletin rather than a playmate, and an `zh-HK` recognizer fed English
returns confident nonsense that the model then answers as if it were a
sentence. So the three travel together here, keyed by the `language_code` on
the account -- the column the "Character's language" dropdown in Settings
already writes and that memory summaries already read.

MiniMax is the reason the voice is part of this rather than a separate
setting: a MiniMax voice *is* a language. There is no voice id that speaks
both Cantonese and Mandarin, so choosing the language chooses the voice.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class LanguageProfile:
    """One language, and everything the pipeline needs to run in it."""

    code: str
    label: str
    # BCP-47 for the recognizer. models/stt/* parse this themselves.
    stt_language: str
    # Token for the TTS provider's own alias table. For MiniMax "yue" has to
    # reach Language.YUE, which maps to the `language_boost` value
    # "Chinese,Yue"; Language.ZH_HK does not -- it falls through to the literal
    # string "zh-HK", which MiniMax does not recognise.
    tts_language: str
    # MiniMax prefixes every current voice id with its language. A character's
    # own voice is kept when it carries this prefix and replaced when it does
    # not, because a voice from the wrong language cannot say these words.
    voice_prefixes: tuple[str, ...]
    # Where the default voice can be overridden without a code change.
    voice_env: str
    default_voice: str
    # Appended last to the system prompt, so it is the most recent instruction
    # before the conversation starts.
    prompt: str
    # The pre-2025 MiniMax voice ids (Calm_Woman, Lively_Girl, Casual_Guy...)
    # carry no language prefix. They are the ids sitting in personalities.
    # oai_voice today and they are English voices, so they belong to whichever
    # profile claims them rather than being replaced on every session.
    accepts_unprefixed_voices: bool = False


_CANTONESE = LanguageProfile(
    code="zh-HK",
    label="Cantonese",
    stt_language="zh-HK",
    tts_language="yue",
    voice_prefixes=("Cantonese_",),
    voice_env="MINIMAX_VOICE_YUE",
    default_voice="Cantonese_KindWoman",
    prompt=(
        "Talk to the child in Cantonese, the way it is actually spoken in Hong "
        "Kong. Write your replies in colloquial written Cantonese -- 係, 唔係, "
        "嘅, 咗, 喺, 佢, 乜嘢, 點解, 啦, 㗎, 喎 -- and not in Standard Written "
        "Chinese. Say 你今日想玩咩呀 rather than 你今天想玩什么呢. Everything you "
        "write is read out by a Cantonese voice, so a reply written in Mandarin "
        "is pronounced character by character in Cantonese and sounds stiff and "
        "wrong even though every word is Chinese."
    ),
)

_MANDARIN = LanguageProfile(
    code="zh-CN",
    label="Mandarin",
    stt_language="zh-CN",
    tts_language="zh",
    voice_prefixes=("Chinese (Mandarin)_", "Chinese_"),
    voice_env="MINIMAX_VOICE_ZH",
    default_voice="Chinese (Mandarin)_Warm_Girl",
    prompt=(
        "Talk to the child in Mandarin (普通话) and write your replies in "
        "Simplified Chinese. Say 你今天想玩什么呢 rather than the Cantonese "
        "你今日想玩咩呀."
    ),
)

_ENGLISH = LanguageProfile(
    code="en-US",
    label="English",
    stt_language="en-US",
    tts_language="en",
    voice_prefixes=("English_",),
    voice_env="MINIMAX_VOICE_EN",
    default_voice="English_Kind-heartedGirl",
    prompt="Talk to the child in English.",
    accepts_unprefixed_voices=True,
)

PROFILES: dict[str, LanguageProfile] = {
    profile.code: profile for profile in (_CANTONESE, _MANDARIN, _ENGLISH)
}

# Spellings that mean one of the three. Anything not listed here and not a
# profile code resolves to None, which leaves every provider on its env
# defaults -- the behaviour accounts on de-DE or es-ES have today.
_ALIASES = {
    "YUE": "zh-HK",
    "ZH_HK": "zh-HK",
    "ZH_HANT_HK": "zh-HK",
    "CANTONESE": "zh-HK",
    "ZH": "zh-CN",
    "ZH_CN": "zh-CN",
    "ZH_HANS": "zh-CN",
    "ZH_TW": "zh-CN",
    "CHINESE": "zh-CN",
    "MANDARIN": "zh-CN",
    "EN": "en-US",
    "EN_US": "en-US",
    "EN_GB": "en-US",
    "ENGLISH": "en-US",
}

_ALL_PREFIXES = tuple(prefix for profile in PROFILES.values() for prefix in profile.voice_prefixes)


def resolve(language_code: str | None) -> LanguageProfile | None:
    """Find the profile for an account's `language_code`, or None.

    None is not a failure: it means this session keeps whatever the provider
    env vars already say, which is what every account on a language this
    server has no voice for should do.
    """
    if not language_code:
        return None
    token = language_code.strip().replace("-", "_").replace(" ", "_").upper()
    if not token:
        return None
    code = _ALIASES.get(token)
    if code:
        return PROFILES[code]
    # A profile code written in its canonical form arrives here as e.g. ZH_HK,
    # which the alias table already covers; this catches any future profile
    # whose code nobody remembered to alias.
    return PROFILES.get(language_code.strip())


def parse_voices(value: object) -> dict[str, str] | None:
    """Normalise a personalities.voices jsonb or query-param JSON to a map.

    None means "this character has no per-language voices", which is what
    every existing row looks like (`{}` or the column missing) and what the
    browser sends when the admin left Cantonese and Mandarin blank.
    """
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return None
    if not isinstance(value, dict):
        return None
    out: dict[str, str] = {}
    for key, raw in value.items():
        if not isinstance(key, str) or not isinstance(raw, str):
            continue
        code = key.strip()
        voice = raw.strip()
        if code and voice:
            out[code] = voice
    return out or None


def intended_voice(
    profile: LanguageProfile,
    character_voice: str | None,
    voices: dict[str, str] | None = None,
) -> str:
    """The id the character asked for in this language, before the prefix check.

    The per-language map wins so Pepa can be Cantonese_CuteGirl while Sherlock
    is Cantonese_PlayfulMan. `character_voice` is personalities.oai_voice, the
    English default and what older rows have as their only voice.
    """
    mapped = ""
    if voices:
        mapped = (voices.get(profile.code) or "").strip()
    return mapped or (character_voice or "").strip()


def voice_for(
    profile: LanguageProfile,
    character_voice: str | None,
    voices: dict[str, str] | None = None,
) -> str:
    """Which MiniMax voice this session speaks with.

    An id typed into this language's slot of `voices` is used as written. The
    admin chose it for this language, and a cloned voice (daijaizai_yue01) has
    whatever id it was cloned under, never a language prefix. Only an id that
    carries another language's prefix is refused there, since that is a system
    voice that cannot say these words.

    `character_voice` (oai_voice) was not chosen for any one language, so it
    wins only when it can say these words -- when its id carries this
    language's prefix, or when it is one of the unprefixed legacy ids and this
    profile claims them. Otherwise the language's voice wins, because a
    Cantonese session running an English voice id is not a session in
    Cantonese at all.
    """
    mapped = ((voices or {}).get(profile.code) or "").strip()
    if mapped:
        if mapped.startswith(profile.voice_prefixes) or not mapped.startswith(
            _ALL_PREFIXES
        ):
            return mapped
        return os.getenv(profile.voice_env) or profile.default_voice
    voice = (character_voice or "").strip()
    if voice:
        if voice.startswith(profile.voice_prefixes):
            return voice
        if profile.accepts_unprefixed_voices and not voice.startswith(_ALL_PREFIXES):
            return voice
    return os.getenv(profile.voice_env) or profile.default_voice

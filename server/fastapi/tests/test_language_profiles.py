"""The language a session runs in has to reach all three providers.

The failure this guards against is the partial switch: the recognizer moved to
Cantonese but the voice did not, or the voice moved but the prompt still asks
for Spanish. Each of those produces a session that sounds broken in a way that
is hard to trace back to one setting, so they are asserted together.
"""

import language_profiles
from character_prompt import build_session_prompt


def test_the_three_languages_resolve_from_every_spelling():
    for code in ("zh-HK", "zh_HK", "yue", "Cantonese", "ZH-HK"):
        assert language_profiles.resolve(code).code == "zh-HK", code
    for code in ("zh-CN", "zh", "Mandarin", "zh-TW"):
        assert language_profiles.resolve(code).code == "zh-CN", code
    for code in ("en-US", "en", "English", "en-GB"):
        assert language_profiles.resolve(code).code == "en-US", code


def test_an_unmapped_language_leaves_the_providers_alone():
    # de-DE and es-ES are real rows in the languages table. There is no voice
    # for them here, and inventing one would be worse than leaving the session
    # on whatever the env vars say.
    for code in (None, "", "de-DE", "es-AR", "  "):
        assert language_profiles.resolve(code) is None


def test_cantonese_asks_minimax_for_yue_not_zh_hk():
    # Language.ZH_HK is not in MiniMax's map and degrades to the literal
    # "zh-HK", which the API does not recognise. Only YUE reaches
    # language_boost="Chinese,Yue".
    from models.tts.minimax import _language_boost, _parse_language

    cantonese = language_profiles.resolve("zh-HK")
    assert _language_boost(_parse_language(cantonese.tts_language)) == "Chinese,Yue"

    mandarin = language_profiles.resolve("zh-CN")
    assert _language_boost(_parse_language(mandarin.tts_language)) == "Chinese"

    english = language_profiles.resolve("en-US")
    assert _language_boost(_parse_language(english.tts_language)) == "English"


def test_a_voice_from_another_language_is_replaced():
    cantonese = language_profiles.resolve("zh-HK")
    # Every stored character today carries one of the unprefixed legacy ids.
    # None of them can speak Cantonese.
    assert language_profiles.voice_for(cantonese, "Calm_Woman").startswith("Cantonese_")
    assert language_profiles.voice_for(cantonese, None).startswith("Cantonese_")
    # A voice that already belongs to this language is the character's choice
    # and is kept.
    assert language_profiles.voice_for(cantonese, "Cantonese_CuteGirl") == "Cantonese_CuteGirl"


def test_english_keeps_the_legacy_character_voices():
    english = language_profiles.resolve("en-US")
    # Calm_Woman, Lively_Girl, Casual_Guy and friends are what
    # personalities.oai_voice holds, and they are English voices. Replacing
    # them would flatten every character onto one voice.
    assert language_profiles.voice_for(english, "Lively_Girl") == "Lively_Girl"
    # But a Cantonese voice on an English session is still wrong.
    assert language_profiles.voice_for(english, "Cantonese_CuteGirl").startswith("English_")


def test_the_voice_can_be_overridden_without_a_code_change(monkeypatch):
    cantonese = language_profiles.resolve("zh-HK")
    monkeypatch.setenv(cantonese.voice_env, "Cantonese_PlayfulMan")
    assert language_profiles.voice_for(cantonese, "Calm_Woman") == "Cantonese_PlayfulMan"


def test_a_character_can_name_a_different_voice_per_language():
    cantonese = language_profiles.resolve("zh-HK")
    mandarin = language_profiles.resolve("zh-CN")
    english = language_profiles.resolve("en-US")
    voices = {
        "zh-HK": "Cantonese_CuteGirl",
        "zh-CN": "Chinese (Mandarin)_Warm_Girl",
    }
    # The map is what lets two characters on the same language sound different.
    assert (
        language_profiles.voice_for(cantonese, "Calm_Woman", voices)
        == "Cantonese_CuteGirl"
    )
    assert (
        language_profiles.voice_for(mandarin, "Calm_Woman", voices)
        == "Chinese (Mandarin)_Warm_Girl"
    )
    # English still uses oai_voice when the map has no en-US entry.
    assert language_profiles.voice_for(english, "Lively_Girl", voices) == "Lively_Girl"


def test_a_wrong_language_in_the_map_is_still_replaced():
    # An English id typed into the Cantonese field is the same mistake as
    # putting it in oai_voice: it cannot say these words.
    cantonese = language_profiles.resolve("zh-HK")
    voices = {"zh-HK": "Calm_Woman"}
    assert language_profiles.voice_for(cantonese, "Lively_Girl", voices).startswith(
        "Cantonese_"
    )


def test_parse_voices_drops_blanks_and_junk():
    assert language_profiles.parse_voices({}) is None
    assert language_profiles.parse_voices(None) is None
    assert language_profiles.parse_voices("not-json") is None
    assert language_profiles.parse_voices(
        '{"zh-HK":"Cantonese_CuteGirl","zh-CN":"  "}'
    ) == {"zh-HK": "Cantonese_CuteGirl"}


def test_the_language_instruction_outranks_the_character_prompt():
    cantonese = language_profiles.resolve("zh-HK")
    prompt = build_session_prompt(
        title="Pepa",
        character_prompt="You only ever speak Spanish.",
        language_instruction=cantonese.prompt,
    )
    assert cantonese.prompt in prompt
    assert prompt.index("only ever speak Spanish") < prompt.index(cantonese.prompt)


def test_cantonese_is_told_not_to_write_standard_chinese():
    # A Cantonese voice reads whatever characters it is given, so a reply
    # written in Mandarin is pronounced in Cantonese and sounds wrong. The
    # instruction has to say so; "speak Cantonese" alone does not get there.
    cantonese = language_profiles.resolve("zh-HK")
    assert "嘅" in cantonese.prompt
    assert "Standard Written Chinese" in cantonese.prompt

"""Shared character prompt for the MyPhoenyx language-learning pal."""

LANGUAGE_LEARNING_PAL_PROMPT = """
You are Phoenyx, a warm, playful children's language-learning pal for MyPhoenyx.

Your job is to help children learn Spanish in a way that feels safe, fun, and encouraging.

Personality:
- Friendly, patient, and upbeat.
- Cheerful and playful without being chaotic or overwhelming.
- Gentle, supportive, and never judgmental.
- Focused on helping children feel brave about trying new words.

Teaching style:
- Teach simple Spanish words, short phrases, and tiny conversations.
- Use age-appropriate examples and short sentences.
- Repeat new words clearly and explain them in simple English.
- Celebrate effort, not perfection.
- Offer one question or one step at a time.
- When useful, give a Spanish word, then the English meaning, then a tiny example.
- Keep responses concise and easy to understand for children.
- If the child makes a mistake, gently correct it and model the right phrase.
- Use games, songs, mini-quizzes, or pretend play when helpful.

Spanish guidance:
- Prefer beginner-friendly Spanish.
- Start with greetings, colors, numbers, animals, family, food, feelings, and classroom words.
- Encourage pronunciation with short phonetic hints when helpful.
- If the child asks for a translation, provide it simply.
- You can mix English and Spanish, but keep the Spanish amount matched to the child’s level.

Safety and tone:
- Be appropriate for children at all times.
- Avoid scary, romantic, violent, or adult content.
- Never shame, tease, or pressure the child.
- Keep the tone bright, reassuring, and age-appropriate.

Brand feel:
- This character is for MyPhoenyx.
- The voice should feel magical, trustworthy, and educational.
- The goal is for children to feel like they are learning with a kind friend.

Example style:
- "Great try! 'Hola' means 'hello.' Can you say it with me?"
- "Nice work. 'Rojo' means 'red.' Want to learn another color?"
- "Let's practice: 'Me llamo Ana' means 'My name is Ana.'"
""".strip()


# Everything the model writes is spoken aloud by a TTS service and never seen,
# so anything meant for a screen is read out literally. Observed on 2026-09-09
# with MiniMax: it dutifully pronounced "# 🌟 AI HULK GREETING 🌟", then
# "** 🔨✨" as its own five-character request, and a conversation row from that
# morning opens with "*gentle smile*".
#
# Character prompts make this worse rather than better -- AI Hulk's own prompt
# says to shout HULK SMASH when excited, which is exactly the kind of line a
# model decorates with asterisks. So the rule has to live here, next to the
# other constraints that apply whatever character is loaded, and it has to be
# specific: "be conversational" is not a formatting instruction and models do
# not read it as one.
#
# There is a cost angle too. TTS aggregates by sentence, so a stray "** 🔨✨"
# becomes its own request and its own round trip.
SPOKEN_OUTPUT_RULES = """\
Everything you say is read aloud by a speech synthesiser. The child hears you; \
they never see any text. Write only words that make sense spoken:

- No markdown. No headings, no bold or italics, no asterisks, no bullet points, \
no numbered lists, no code blocks.
- No emoji, emoticons or symbols. They get pronounced or read out as their name.
- No stage directions or sound effects in asterisks, such as *laughs* or \
*gentle smile*. If you want to sound excited, say something excited.
- Spell things out the way you would say them. Write "and" rather than "&", and \
say a number the way it is spoken.
- Plain sentences, one after another, the way you would actually talk."""


def build_child_block(
    child_name: str | None = None,
    child_age: int | None = None,
    child_persona: str | None = None,
) -> str:
    """Describe who the toy is talking to.

    Wording follows the Deno route's UserPromptTemplate (server/deno/supabase.ts:96)
    so a child meets the same character on either transport.
    """
    name = (child_name or "").strip()
    persona = (child_persona or "").strip()
    if not name and child_age is None and not persona:
        return ""

    described = "YOU ARE TALKING TO someone"
    if name:
        described += f" whose name is: {name}"
    if child_age is not None:
        described += f" and age is: {child_age}"
    if persona:
        described += f" with a personality described as: {persona}"
    return described + "."


def build_session_prompt(
    title: str | None = None,
    character_prompt: str | None = None,
    voice_prompt: str | None = None,
    child_name: str | None = None,
    child_age: int | None = None,
    child_persona: str | None = None,
    memory_preamble: str | None = None,
    language_instruction: str | None = None,
) -> str:
    prompt = (character_prompt or "").strip()
    child_block = build_child_block(child_name, child_age, child_persona)
    preamble = (memory_preamble or "").strip()
    # Late, and after the character, because a character prompt usually names a
    # language of its own -- the built-in pal teaches Spanish, and several of
    # the stored characters are written in Spanish. The account's choice is the
    # one that has to win, and the later instruction is the one that does.
    # It stays ahead of SPOKEN_OUTPUT_RULES: see the note on why those are last.
    language = (language_instruction or "").strip()

    if not prompt:
        parts = [LANGUAGE_LEARNING_PAL_PROMPT]
        if child_block:
            parts.append(child_block)
        if preamble:
            parts.append(preamble)
        if language:
            parts.append(language)
        # Appended here too. The rules used to hang off the custom-character
        # branch only, so the built-in pal was the one character with no
        # instruction not to speak markdown.
        parts.append(SPOKEN_OUTPUT_RULES)
        return "\n\n".join(parts)

    parts: list[str] = []
    name = (title or "").strip()
    if name:
        parts.append(f"You are {name}.")
    parts.append(prompt)
    voice = (voice_prompt or "").strip()
    if voice:
        parts.append(f"YOUR VOICE IS: {voice}")
    if child_block:
        parts.append(child_block)
    if preamble:
        parts.append(preamble)
    # The old wording was a flat "Do not ask for personal information", which
    # reads as "never retain anything about this child" once the toy has a
    # memory. The line it needs is the narrower one: do not go fishing, but do
    # use what the child volunteered.
    parts.append(
        "Keep spoken replies concise and conversational. "
        "Never ask the child for personal information, and never ask for "
        "anything that identifies them or their family. Things the child "
        "tells you on their own are fine to remember and refer back to."
    )
    if language:
        parts.append(language)
    # Last, so it is the most recent instruction before the conversation starts.
    parts.append(SPOKEN_OUTPUT_RULES)
    return "\n\n".join(parts)

"""Prompts for the BEAM evaluation.

JUDGE_PROMPT is copied verbatim from BEAM (src/prompts.py,
unified_llm_judge_base_prompt), so scores are comparable with the paper's:
  https://github.com/mohammadtavakoli78/BEAM
  Copyright (c) Mohammad Tavakoli et al., MIT License.
Everything else here is ours.
"""

JUDGE_PROMPT = """
You are an expert evaluator tasked with judging whether the LLM's response demonstrates compliance with the specified RUBRIC CRITERION.

## EVALUATION INPUTS
- RUBRIC CRITERION (what to check): <rubric_item>
- RESPONSE TO EVALUATE: <llm_response>

## EVALUATION RUBRIC:
The rubric defines a specific requirement, constraint, or expected behavior that the LLM response should demonstrate. 

**IMPORTANT**: Pay careful attention to whether the rubric specifies:
- **Positive requirements** (things the response SHOULD include/do)
- **Negative constraints** (things the response SHOULD NOT include/do, often indicated by "no", "not", "avoid", "absent")

## RESPONSIVENESS REQUIREMENT
A compliant response must be **on-topic** and attempt to answer it.
- If the response does not address the QUESTION, score **0.0** and stop.
- For negative constraints, both must hold: (a) the response is responsive to the QUESTION, and (b) the prohibited element is absent.

## SEMANTIC TOLERANCE RULES:
Judge by meaning, not exact wording.
- Accept **paraphrases** and **synonyms** that preserve intent.
- **Case/punctuation/whitespace** differences must be ignored.
- **Numbers/currencies/dates** may appear in equivalent forms (e.g., “$68,000”, “68k”, “68,000 USD”, or “sixty-eight thousand dollars”). Treat them as equal when numerically equivalent.
- If the rubric expects a number or duration, prefer **normalized comparison** (extract and compare values) over string matching.

## STYLE NEUTRALITY (prevents style contamination):
Ignore tone, politeness, length, and flourish unless the rubric explicitly requires a format/structure (e.g., “itemized list”, “no citations”, “one sentence”).
- Do **not** penalize hedging, voice, or verbosity if content satisfies the rubric.
- Only evaluate format when the rubric **explicitly** mandates it.

## SCORING SCALE:
- **1.0 (Complete Compliance)**: Fully complies with the rubric criterion.
  - Positive: required element present, accurate, properly executed (allowing semantic equivalents).
  - Negative: prohibited element **absent** AND response is **responsive**.
  
- **0.5 (Partial Compliance)**: Partially complies.
  - Positive: element present but minor inaccuracies/incomplete execution.
  - Negative: generally responsive and mostly avoids the prohibited element but with minor/edge violations.
  
- **0.0 (No Compliance)**: Fails to comply.
  - Positive: required element missing or incorrect.
  - Negative: prohibited element present **or** response is non-responsive/evasive even if the element is absent.

## EVALUATION INSTRUCTIONS:
1. **Understand the Requirement**: Determine if the rubric is asking for something to be present (positive) or absent (negative/constraint).

2. **Parse Compound Statements**: If the rubric contains multiple elements connected by "and" or commas, evaluate whether:
   - **All elements** must be present for full compliance (1.0)
   - **Some elements** present indicates partial compliance (0.5)
   - **No elements** present indicates no compliance (0.0)
   
3. **Check Compliance**: 
   - For positive requirements: Look for the presence and quality of the required element
   - For negative constraints: Look for the absence of the prohibited element

4. **Assign Score**: Based on compliance with the specific rubric criterion according to the scoring scale above.

5. **Provide Reasoning**: Explain whether the rubric criterion was satisfied and justify the score.

## OUTPUT FORMAT:
Return your evaluation in JSON format with two fields:

{
   "score": [your score: 1.0, 0.5, or 0.0],
   "reason": "[detailed explanation of whether the rubric criterion was satisfied and why this justified the assigned score]"
}

NOTE: ONLY output the json object, without any explanation before or after that
"""

# The "adult" config: memory/summarise.py's _SYSTEM with the child and toy
# taken out and the definition of a fact widened to what an adult working on a
# project says. Every mechanical rule is kept word for word -- the calendar,
# COMPLETE replacements, `replaces`, no invention -- so the only thing this
# config changes is what the model is allowed to consider worth keeping.
ADULT_CONSOLIDATION_SYSTEM = """You keep the long-term memory of an AI assistant that one user talks to over many sessions.

You are given the raw turns of one stretch of conversation, the facts you
already know about this user (numbered), and a calendar starting today. Reply
with ONE JSON object and nothing else:

{"summary": "...", "facts": [{"text": "...", "replaces": null}]}

"summary": at most three sentences saying what this stretch was about -- what
the user was working on, what was decided, what was left open. It is read at
the start of a LATER session, so write it as a reminder to yourself. Do not
repeat anything that is going into "facts"; the summary is for what happened,
facts are for what is true. Small talk on its own is not worth remembering:
use an empty string for that.

"facts": things the user said that will still be true and useful sessions from
now. Good facts: who they are and what they do; the projects they are working
on, with their names, tools, versions, numbers, deadlines and milestones with
their dates; decisions they made; problems they hit and how they were
resolved; the people they mention; their preferences; and any standing
instruction about how the assistant should answer them (format, style, what to
always or never do). NOT facts: generic knowledge the assistant explained,
anything only true right now, anything you already know.
- One sentence each, about the user in the third person. Keep the concrete
  details: names, numbers, dates, versions.
- Turn relative dates into real ones by looking them up in the calendar, never
  by counting ("next Saturday" -> the date listed for it). Write only the date:
  never keep "today", "next Saturday" or "this year" in a fact, because it will
  be read weeks from now when those words mean something else.
- If a new fact updates or contradicts a known one (a new number, a changed
  plan), set "replaces" to that known fact's number, and write the COMPLETE
  updated fact: everything in the old one that is still true, plus the change.
  The old one is thrown away, so anything you leave out is forgotten.
  Otherwise null.
- If there is nothing new, use an empty list.

Rules for both:
- Write in the same language the user is speaking.
- Say only what the user actually said. Never guess, never embellish, never
  invent names.
- Never include a phone number, an address, or a government or account
  number, even if the user said it."""

# The answering side. Neutral on purpose: BEAM's questions are addressed to an
# assistant, and the toy's character prompt would only add noise. Memory, when
# there is any, is appended below this verbatim.
ANSWER_SYSTEM = """You are an AI assistant continuing a long-running relationship with this user across many sessions. Today's date is {today}.

Answer the user's message as that assistant would."""

ANSWER_MEMORY_HEADER = "\n\nYour long-term memory of this user, from your previous sessions:\n\n"

ANSWER_TRANSCRIPT_HEADER = "\n\nThe full history of your previous sessions with this user:\n\n"

# Event ordering, second half of BEAM's metric. BEAM aligns every line of the
# response with every reference item through a separate yes/no call; this asks
# for the whole alignment in one call. Same question, one call instead of up
# to a hundred.
ALIGN_PROMPT = """You are matching the lines of a response against a list of reference events.

REFERENCE EVENTS (numbered):
<reference>

RESPONSE LINES (numbered):
<lines>

For each response line, give the number of the reference event it describes (the SAME event or fact, judged by meaning), or null if it describes none of them. Each reference event may be matched by at most one line: the first line that describes it.

Reply with ONE JSON object and nothing else:
{"matches": [<reference number or null for line 1>, <for line 2>, ...]}"""

# Diagnostic only, not a BEAM metric: is the information a rubric asks for in
# the memory text at all? Separates "never stored" from "stored but unused".
RETENTION_PROMPT = """You are checking whether a memory note contains a piece of information.

MEMORY NOTE:
<memory>

INFORMATION TO FIND:
<item>

Judge by meaning, not wording; numbers and dates may be written differently. Score 1.0 if the note states this information, 0.5 if it states part of it or states it vaguely, 0.0 if it is absent or the note says something different.

Reply with ONE JSON object and nothing else:
{"score": 1.0 | 0.5 | 0.0, "reason": "<one sentence>"}"""

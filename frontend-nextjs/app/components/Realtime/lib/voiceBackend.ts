export const isFastAPIVoiceBackend =
  process.env.NEXT_PUBLIC_VOICE_BACKEND === "fastapi";

export const FASTAPI_WS_URL =
  process.env.NEXT_PUBLIC_FASTAPI_WS_URL || "ws://127.0.0.1:7860/ws/nextjs";

export type FastAPISessionParams = {
  voice?: string | null;
  // language_code -> MiniMax voice id, the same map admin writes to
  // personalities.voices. JSON on the query string so the voice server can
  // pick Cantonese/Mandarin without another database round-trip.
  voices?: Record<string, string> | null;
  title?: string | null;
  characterPrompt?: string | null;
  voicePrompt?: string | null;
  firstMessagePrompt?: string | null;
  // Who is talking. The voice server keys long-term memory on this, so a
  // session without it simply runs with no memory rather than borrowing
  // someone else's.
  userId?: string | null;
  // Which character said it, recorded on each stored memory for display. The
  // memory itself is shared across characters -- it is the same child.
  personalityKey?: string | null;
};

export function shouldUseFastAPIVoice(provider?: string | null) {
  return isFastAPIVoiceBackend || provider === "openrouter";
}

export function getFastAPIVoiceUrl(params?: FastAPISessionParams) {
  const search = new URLSearchParams();
  if (params?.voice) search.set("voice", params.voice);
  const voices = params?.voices;
  if (voices && Object.keys(voices).length > 0) {
    search.set("voices", JSON.stringify(voices));
  }
  if (params?.title) search.set("title", params.title);
  if (params?.characterPrompt) search.set("character_prompt", params.characterPrompt);
  if (params?.voicePrompt) search.set("voice_prompt", params.voicePrompt);
  if (params?.firstMessagePrompt) {
    search.set("first_message_prompt", params.firstMessagePrompt);
  }
  if (params?.userId) search.set("user_id", params.userId);
  if (params?.personalityKey) search.set("personality_key", params.personalityKey);
  const qs = search.toString();
  if (!qs) {
    return FASTAPI_WS_URL;
  }
  const separator = FASTAPI_WS_URL.includes("?") ? "&" : "?";
  return `${FASTAPI_WS_URL}${separator}${qs}`;
}

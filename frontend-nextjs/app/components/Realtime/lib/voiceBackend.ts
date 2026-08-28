export const isFastAPIVoiceBackend =
  process.env.NEXT_PUBLIC_VOICE_BACKEND === "fastapi";

export const FASTAPI_WS_URL =
  process.env.NEXT_PUBLIC_FASTAPI_WS_URL || "ws://127.0.0.1:7860/ws/nextjs";

export type FastAPISessionParams = {
  voice?: string | null;
  title?: string | null;
  characterPrompt?: string | null;
  voicePrompt?: string | null;
  firstMessagePrompt?: string | null;
};

export function shouldUseFastAPIVoice(provider?: string | null) {
  return isFastAPIVoiceBackend || provider === "openrouter";
}

export function getFastAPIVoiceUrl(params?: FastAPISessionParams) {
  const search = new URLSearchParams();
  if (params?.voice) search.set("voice", params.voice);
  if (params?.title) search.set("title", params.title);
  if (params?.characterPrompt) search.set("character_prompt", params.characterPrompt);
  if (params?.voicePrompt) search.set("voice_prompt", params.voicePrompt);
  if (params?.firstMessagePrompt) {
    search.set("first_message_prompt", params.firstMessagePrompt);
  }
  const qs = search.toString();
  if (!qs) {
    return FASTAPI_WS_URL;
  }
  const separator = FASTAPI_WS_URL.includes("?") ? "&" : "?";
  return `${FASTAPI_WS_URL}${separator}${qs}`;
}

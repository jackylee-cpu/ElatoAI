export const isFastAPIVoiceBackend =
  process.env.NEXT_PUBLIC_VOICE_BACKEND === "fastapi";

export const FASTAPI_WS_URL =
  process.env.NEXT_PUBLIC_FASTAPI_WS_URL || "ws://127.0.0.1:7860/ws/nextjs";

export function shouldUseFastAPIVoice(provider?: string | null) {
  return isFastAPIVoiceBackend || provider === "openrouter";
}

/**
 * The /ws/nextjs URL for one session. All it carries is the web voice token
 * from createVoiceSessionToken(): the voice server takes the account from the
 * token and the character, voice and prompts from that account, so nothing the
 * page could edit decides whose memories load or what the character says.
 */
export function getFastAPIVoiceUrl(token: string) {
  const separator = FASTAPI_WS_URL.includes("?") ? "&" : "?";
  return `${FASTAPI_WS_URL}${separator}${new URLSearchParams({ token })}`;
}

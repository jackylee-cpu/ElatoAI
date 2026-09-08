/**
 * How the browser client owns the microphone.
 *
 * The toy is push-to-talk (firmware-arduino/src/Audio.cpp): the button opens
 * the mic, releasing it lets the server's VAD close the turn, and nothing else
 * ever opens it. The web client mirrors that so both clients behave the same
 * way and so room noise cannot take a turn the user never took.
 *
 * "hands_free" keeps the old open-mic behaviour, minus the part that broke it:
 * the mic still closes while the bot is speaking, so an answer can no longer
 * interrupt itself. Barge-in in that mode goes through the same talk button.
 */
export type MicMode = "ptt" | "hands_free";

export const MIC_MODE_STORAGE_KEY = "voiceMicMode";

export function parseMicMode(value: string | null): MicMode {
  return value === "hands_free" ? "hands_free" : "ptt";
}

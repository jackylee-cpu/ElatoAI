"use client";

import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

// UI components
import BottomToolbar from "./components/BottomToolbar";

// Types
import { AgentConfig, SessionStatus, VoiceTurnStatus } from "@/app/components/Realtime/types";

// Context providers & hooks
import { useTranscript } from "@/app/components/Realtime/contexts/TranscriptContext";
import { useEvent } from "@/app/components/Realtime/contexts/EventContext";
import { useHandleServerEvent } from "./hooks/useHandleServerEvent";

// Utilities
import { createRealtimeConnection } from "./lib/realtimeConnection";
import { FastAPIVoiceSession, FastAPIControlMessage } from "./lib/fastapiConnection";
import { getFastAPIVoiceUrl, shouldUseFastAPIVoice } from "./lib/voiceBackend";
import { MicMode, MIC_MODE_STORAGE_KEY, parseMicMode } from "./lib/micMode";
import { toast } from "@/components/ui/use-toast";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import Transcript from "./components/Transcript";
import { getPersonalityById } from "@/db/personalities";
import { createClient } from "@/utils/supabase/client";

// Push-to-talk timings, mirrored from the firmware (firmware-arduino/src/Audio.cpp)
// so the toy and the web app take turns the same way.

// A press shorter than this was a barge-in, not an utterance.
const PTT_MIN_CAPTURE_MS = 250;

// Mean |sample| below which a press captured nothing worth transcribing, so
// there is no point starting a turn with it. Deliberately low: letting a quiet
// turn through is far better than dropping real speech, and browser AGC lifts
// room noise well above what the ESP32 mic reports.
const MIC_SILENCE_LEVEL = 120;

// Hands-free only: how long after a turn ends before the mic reopens. The
// server calls the turn over when TTS stops, but the last packets are still
// playing out of the speakers, and reopening into them is how the answer used
// to interrupt itself. The firmware waits the same 1s (Audio.cpp,
// scheduledTime = millis() + 1000).
const HANDS_FREE_REOPEN_DELAY_MS = 1000;

// Shortest gap between two steps of the bot transcript's character-by-character
// reveal. Each step is a React state update that re-renders every consumer of
// the transcript context, so this is the rate at which the main thread is asked
// to do real work for the whole duration of an answer. 33ms (~30 steps/s) is
// still smooth to read -- the reveal advances by more characters per step to
// keep the same words-per-second -- and halves that load against the 60Hz frame
// rate it used to run at, or quarters it on a 120Hz display.
const BOT_REVEAL_INTERVAL_MS = 33;

export type VoiceTriggerRenderProps = {
  sessionStatus: SessionStatus;
  onToggleConnection: () => void;
  isDoctor: boolean;
  personality: IPersonality | null;
  usesFastAPI: boolean;
  disabled: boolean;
};

interface AppProps {
  personalityIdState: string;
  isDoctor: boolean;
  userId: string;
  renderTrigger?: (props: VoiceTriggerRenderProps) => React.ReactNode;
}

function App({ personalityIdState, isDoctor, userId, renderTrigger }: AppProps) {
  const supabase = createClient();

  const { transcriptItems, addTranscriptMessage, upsertTranscriptMessage, updateTranscriptItemStatus } =
    useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] =
    useState<AgentConfig[] | null>(null);

    const [isSheetOpen, setIsSheetOpen] = useState<boolean>(false);
    const [userText, setUserText] = useState<string>("");

  const [personality, setPersonality] = useState<IPersonality | null>(null);
  
  useEffect(() => {
    const fetchPersonality = async () => {
      if (personalityIdState) {
        const personalityData = await getPersonalityById(supabase, personalityIdState);
        setPersonality(personalityData);
      }
    };
    
    fetchPersonality();
  }, [personalityIdState, supabase]);


  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const fastapiSessionRef = useRef<FastAPIVoiceSession | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const botTargetTextRef = useRef<Record<string, string>>({});
  const botShownTextRef = useRef<Record<string, string>>({});
  const botRevealRafRef = useRef<number | null>(null);
  const botRevealLastAtRef = useRef<number | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");
  const [voiceStatus, setVoiceStatus] =
    useState<VoiceTurnStatus>("disconnected");
  const voiceStatusRef = useRef<VoiceTurnStatus>("disconnected");
  const updateVoiceStatus = (next: VoiceTurnStatus) => {
    voiceStatusRef.current = next;
    setVoiceStatus(next);
  };

  const [micMode, setMicMode] = useState<MicMode>("ptt");
  const micModeRef = useRef<MicMode>("ptt");
  const [isTalking, setIsTalking] = useState<boolean>(false);
  // True from pointer-down until pointer-up. Server-driven state changes check
  // it: a RESPONSE.CREATED arriving mid-press must not close the mic out from
  // under someone who is still talking.
  const pttHeldRef = useRef<boolean>(false);
  const pttStartedAtRef = useRef<number>(0);
  const handsFreeReopenTimerRef = useRef<number | null>(null);
  const pendingRestartRef = useRef<boolean>(false);

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] =
    useState<boolean>(true);
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] =
    useState<boolean>(true);

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    if (dcRef.current && dcRef.current.readyState === "open") {
      logClientEvent(eventObj, eventNameSuffix);
      dcRef.current.send(JSON.stringify(eventObj));
    } else {
      logClientEvent(
        { attemptedEvent: eventObj.type },
        "error.data_channel_not_open"
      );
      console.error(
        "Failed to send message - no data channel available",
        eventObj
      );
    }
  };

  const handleServerEventRef = useHandleServerEvent({
    setSessionStatus,
    selectedAgentName,
    selectedAgentConfigSet,
    sendClientEvent,
    setSelectedAgentName,
  });

  const revealBotText = (
    itemId: string,
    flush = false,
    elapsedMs = BOT_REVEAL_INTERVAL_MS,
  ) => {
    const target = botTargetTextRef.current[itemId] ?? "";
    const shown = botShownTextRef.current[itemId] ?? "";
    if (flush || shown === target) {
      botShownTextRef.current[itemId] = target;
      if (target) {
        upsertTranscriptMessage(itemId, "assistant", target, "replace");
      }
      return shown !== target;
    }

    const remaining = target.length - shown.length;
    if (remaining <= 0) {
      return false;
    }
    // Characters per second, not characters per frame. The old code revealed a
    // fixed 4/2/1 characters per animation frame, which made the reveal speed a
    // property of the display: the same sentence crawled out at 240 chars/s on a
    // 60Hz panel and 480 on a 120Hz one. Deriving the count from elapsed time
    // keeps the original 60Hz speed and makes it the same everywhere.
    const perSecond = remaining > 24 ? 240 : remaining > 8 ? 120 : 60;
    const nextCount = Math.max(
      1,
      Math.min(remaining, Math.round((perSecond * elapsedMs) / 1000)),
    );
    const next = target.slice(0, shown.length + nextCount);
    botShownTextRef.current[itemId] = next;
    upsertTranscriptMessage(itemId, "assistant", next, "replace");
    return next.length < target.length;
  };

  const scheduleBotReveal = () => {
    if (botRevealRafRef.current != null) {
      return;
    }
    botRevealRafRef.current = window.requestAnimationFrame(() => {
      botRevealRafRef.current = null;
      const now = performance.now();
      const since = botRevealLastAtRef.current;
      const elapsed = since == null ? BOT_REVEAL_INTERVAL_MS : now - since;

      // Come back next frame without touching React state. Every reveal step
      // is an upsertTranscriptMessage, which re-renders every consumer of the
      // transcript context -- at 60Hz that is a state update every 16.7ms for
      // the whole of an answer, and on a 120Hz display every 8.3ms. That work
      // lands on the main thread, which is also where audio playback used to
      // run; see PLAYBACK_WORKLET in lib/fastapiConnection.ts. requestAnimation
      // Frame on its own is cheap, so the throttle goes here rather than on the
      // scheduling.
      if (elapsed < BOT_REVEAL_INTERVAL_MS) {
        scheduleBotReveal();
        return;
      }
      botRevealLastAtRef.current = now;

      let needMore = false;
      Object.keys(botTargetTextRef.current).forEach((itemId) => {
        if (revealBotText(itemId, false, elapsed)) {
          needMore = true;
        }
      });
      if (needMore) {
        scheduleBotReveal();
      }
    });
  };

  const appendBotTranscript = (itemId: string, text: string, replace = false) => {
    const previous = botTargetTextRef.current[itemId] ?? "";
    botTargetTextRef.current[itemId] = replace ? text : `${previous}${text}`;
    scheduleBotReveal();
  };

  const flushBotTranscript = (itemId?: string) => {
    if (itemId) {
      revealBotText(itemId, true);
      return;
    }
    Object.keys(botTargetTextRef.current).forEach((id) => revealBotText(id, true));
  };

  const clearHandsFreeReopen = () => {
    if (handsFreeReopenTimerRef.current != null) {
      window.clearTimeout(handsFreeReopenTimerRef.current);
      handsFreeReopenTimerRef.current = null;
    }
  };

  // True while the button is down -- i.e. while the user, not the server, owns
  // the mic. Server-driven state changes check this: a turn the server
  // considers finished must never cut off a recording the user is in the
  // middle of making.
  const micOwnedByUser = () => pttHeldRef.current;

  const startTalking = () => {
    const session = fastapiSessionRef.current;
    if (!session || pttHeldRef.current) return;

    pttHeldRef.current = true;
    pttStartedAtRef.current = Date.now();
    setIsTalking(true);
    clearHandsFreeReopen();

    // Pressing while the bot holds the floor is a barge-in: drop the turn it is
    // streaming, and throw away the audio already queued here, or the old
    // answer keeps talking over the new question.
    if (voiceStatusRef.current === "speaking" || voiceStatusRef.current === "thinking") {
      session.sendInterrupt();
      session.clearPlayback();
      logClientEvent({ reason: "ptt-barge-in" }, "fastapi.interrupt");
    }

    session.openMic();
    updateVoiceStatus("user_speaking");
  };

  const stopTalking = () => {
    const session = fastapiSessionRef.current;
    if (!pttHeldRef.current) return;
    pttHeldRef.current = false;
    setIsTalking(false);
    if (!session) return;

    const heldMs = Date.now() - pttStartedAtRef.current;
    const { average, peak } = session.micLevel();

    if (heldMs < PTT_MIN_CAPTURE_MS) {
      // The press was there to barge in, not to say something. settleAfterTurn
      // rather than a plain close, or a tap like this would leave hands-free
      // mode with the mic shut and no way back.
      logClientEvent({ heldMs }, "fastapi.ptt.tap_ignored");
      settleAfterTurn();
      return;
    }

    if (average < MIC_SILENCE_LEVEL) {
      // Nothing worth transcribing, so close the mic without a tail: the
      // server's VAD never sees a turn and stays quiet, instead of answering
      // something the user never said.
      logClientEvent({ heldMs, average, peak }, "fastapi.ptt.silence_discarded");
      settleAfterTurn();
      return;
    }

    // Close the mic first, then commit: no audio can reach the server after the
    // instruction that says the turn is over. The server no longer mutes STT on
    // end_of_speech (bot.py), so this costs nothing and saves the second or so
    // the VAD needs to infer the same thing from a tail of silence.
    logClientEvent({ heldMs, average, peak }, "fastapi.ptt.captured");
    session.closeMic();
    session.sendEndOfSpeech();
    updateVoiceStatus("thinking");
  };

  // Where the mic rests between turns: closed under push-to-talk, reopened in
  // hands-free so the next sentence starts a turn on its own.
  const settleAfterTurn = () => {
    const session = fastapiSessionRef.current;
    if (!session || micOwnedByUser()) return;
    clearHandsFreeReopen();
    session.closeMic();
    if (micModeRef.current !== "hands_free") {
      updateVoiceStatus("idle");
      return;
    }
    updateVoiceStatus("listening");
    const delay = Math.max(HANDS_FREE_REOPEN_DELAY_MS, session.queuedPlaybackMs() + 300);
    handsFreeReopenTimerRef.current = window.setTimeout(() => {
      handsFreeReopenTimerRef.current = null;
      if (fastapiSessionRef.current !== session || micOwnedByUser()) return;
      if (voiceStatusRef.current !== "listening") return;
      session.openMic();
    }, delay);
  };

  const applyMicMode = (mode: MicMode) => {
    micModeRef.current = mode;
    setMicMode(mode);
    if (typeof window !== "undefined") {
      localStorage.setItem(MIC_MODE_STORAGE_KEY, mode);
    }
    const session = fastapiSessionRef.current;
    if (!session || micOwnedByUser()) return;
    clearHandsFreeReopen();
    // Only the resting state changes; a mode switch mid-answer must not open
    // the mic into the bot's own audio.
    if (voiceStatusRef.current !== "idle" && voiceStatusRef.current !== "listening") {
      return;
    }
    if (mode === "hands_free") {
      session.openMic();
      updateVoiceStatus("listening");
    } else {
      session.closeMic();
      updateVoiceStatus("idle");
    }
  };

  const handleFastAPIControlRef = useRef<(message: FastAPIControlMessage) => void>(
    () => {}
  );
  handleFastAPIControlRef.current = (message: FastAPIControlMessage) => {
    logServerEvent(message, "fastapi.control");
    const itemId = typeof message.item_id === "string" ? message.item_id : "";
    const text = typeof message.text === "string" ? message.text : "";

    switch (message.msg) {
      case "USER.STARTED": {
        const id = itemId || uuidv4().slice(0, 32);
        upsertTranscriptMessage(id, "user", "[Listening...]", "placeholder");
        updateVoiceStatus("user_speaking");
        break;
      }
      case "USER.TRANSCRIPT": {
        if (!itemId || !text) break;
        upsertTranscriptMessage(itemId, "user", text, "replace", {
          latencyMs: typeof message.latency_ms === "number" ? message.latency_ms : undefined,
          elapsedMs: typeof message.elapsed_ms === "number" ? message.elapsed_ms : undefined,
          durationMs: typeof message.duration_ms === "number" ? message.duration_ms : undefined,
        });
        if (message.final) {
          updateTranscriptItemStatus(itemId, "DONE");
        }
        updateVoiceStatus(message.final ? "thinking" : "user_speaking");
        break;
      }
      case "AUDIO.COMMITTED": {
        // The turn is closed. Keeping the mic open past this only risks the VAD
        // hearing a noise and interrupting the answer we are waiting for --
        // under push-to-talk it is already shut, this covers hands-free.
        if (!pttHeldRef.current) {
          clearHandsFreeReopen();
          fastapiSessionRef.current?.closeMic();
        }
        updateVoiceStatus("thinking");
        break;
      }
      case "BOT.TRANSCRIPT": {
        if (!itemId || !text) break;
        appendBotTranscript(itemId, text, message.delta === false);
        updateVoiceStatus("speaking");
        break;
      }
      case "RESPONSE.CREATED": {
        if (itemId && !botTargetTextRef.current[itemId]) {
          upsertTranscriptMessage(itemId, "assistant", "[Speaking...]", "placeholder");
        }
        // Half-duplex, like the toy: the mic is shut while the bot talks, in
        // both mic modes. Echo cancellation was not enough -- the answer
        // leaking back in is what kept killing the greeting a second after it
        // started. Barge-in is the talk button, which reopens the mic itself.
        if (!micOwnedByUser()) {
          clearHandsFreeReopen();
          fastapiSessionRef.current?.closeMic();
          updateVoiceStatus("speaking");
        }
        break;
      }
      case "RESPONSE.COMPLETE": {
        if (itemId) {
          flushBotTranscript(itemId);
          updateTranscriptItemStatus(itemId, "DONE");
        } else {
          flushBotTranscript();
        }
        settleAfterTurn();
        break;
      }
      case "RESPONSE.ERROR": {
        settleAfterTurn();
        toast({ description: "The voice pipeline returned an error." });
        break;
      }
      default:
        break;
    }
  };

  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      connectToRealtime();
    }
  }, [selectedAgentName]);

  // The server builds a fresh LLMContext per websocket session (bot.py
  // run_bot_session), so dropping the socket and coming back is what starts a
  // new conversation -- the same thing the toy's touch pad does. Reconnecting
  // from this effect rather than inline means connectToRealtime() runs with
  // sessionStatus already DISCONNECTED and passes its own guard.
  useEffect(() => {
    if (pendingRestartRef.current && sessionStatus === "DISCONNECTED") {
      pendingRestartRef.current = false;
      connectToRealtime();
    }
  }, [sessionStatus]);

  const restartConversation = () => {
    if (!shouldUseFastAPIVoice(personality?.provider)) return;
    logClientEvent({}, "fastapi.conversation.restart");
    pendingRestartRef.current = true;
    disconnectFromRealtime();
  };

  // Hold space to talk, matching the on-screen button. Ignored while typing so
  // it cannot swallow a space in a text field.
  useEffect(() => {
    if (sessionStatus !== "CONNECTED" || !shouldUseFastAPIVoice(personality?.provider)) {
      return;
    }
    const isTypingTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || isTypingTarget(event.target)) return;
      event.preventDefault();
      startTalking();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space" || isTypingTarget(event.target)) return;
      event.preventDefault();
      stopTalking();
    };
    // A release that lands outside the tab would otherwise leave the mic open.
    const onBlur = () => stopTalking();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [sessionStatus, personality?.provider]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      updateSession(true);
    }
  }, [sessionStatus]);

  const fetchEphemeralKey = async (): Promise<string | null> => {
    logClientEvent({ url: "/session" }, "fetch_session_token_request");
    const tokenResponse = await fetch("/api/session");
    const data = await tokenResponse.json();
    logServerEvent(data, "fetch_session_token_response");

    if (!data.client_secret?.value) {
      logClientEvent(data, "error.no_ephemeral_key");
      setSessionStatus("DISCONNECTED");
      toast({
        description: "Your API key is likely invalid. Please add it to your env variables.",
      });
      return null;
    }

    return data.client_secret.value;
  };

  const connectToRealtime = async () => {
    if (sessionStatus !== "DISCONNECTED") return;
    setSessionStatus("CONNECTING");

    if (shouldUseFastAPIVoice(personality?.provider)) {
      updateVoiceStatus("connecting");
      const voiceUrl = getFastAPIVoiceUrl({
        voice: personality?.oai_voice,
        voices: personality?.voices,
        title: personality?.title,
        characterPrompt: personality?.character_prompt,
        voicePrompt: personality?.voice_prompt,
        firstMessagePrompt: personality?.first_message_prompt,
        userId,
        personalityKey: personality?.key,
      });
      try {
        // A restart closes the old socket and opens a new one immediately, so
        // the old socket's close event can land after the new one is already
        // connecting. Every handler checks it still owns the ref before it
        // touches any state.
        let session: FastAPIVoiceSession | null = null;
        const isCurrentSession = () => fastapiSessionRef.current === session;
        session = new FastAPIVoiceSession({
          onOpen: () => {
            if (!isCurrentSession()) return;
            logClientEvent({ url: voiceUrl }, "fastapi.socket.open");
            setSessionStatus("CONNECTED");
            // The mic stays shut here in both modes. The server greets as soon
            // as the socket opens, and an open mic at that moment is what made
            // the greeting interrupt itself before it was audible. Hands-free
            // opens it in settleAfterTurn(), once the greeting is done.
            updateVoiceStatus("idle");
          },
          onClose: () => {
            if (!isCurrentSession()) return;
            logClientEvent({}, "fastapi.socket.close");
            setSessionStatus("DISCONNECTED");
            updateVoiceStatus("disconnected");
          },
          onError: (error) => {
            if (!isCurrentSession()) return;
            logClientEvent({ error: String(error.type) }, "fastapi.socket.error");
            toast({
              description: "Could not reach the FastAPI voice server. Is it running on port 7860?",
            });
            setSessionStatus("DISCONNECTED");
            updateVoiceStatus("disconnected");
          },
          onControlMessage: (message) => {
            if (!isCurrentSession()) return;
            handleFastAPIControlRef.current(message);
          },
        });
        fastapiSessionRef.current = session;
        await session.connect(voiceUrl);
      } catch (err) {
        console.error("Error connecting to FastAPI voice:", err);
        fastapiSessionRef.current?.disconnect();
        fastapiSessionRef.current = null;
        setSessionStatus("DISCONNECTED");
        updateVoiceStatus("disconnected");
        toast({
          description: "Microphone permission is required to talk.",
        });
      }
      return;
    }

    try {
      const EPHEMERAL_KEY = await fetchEphemeralKey();
      if (!EPHEMERAL_KEY) {
        return;
      }

      if (!audioElementRef.current) {
        audioElementRef.current = document.createElement("audio");
      }
      audioElementRef.current.autoplay = isAudioPlaybackEnabled;

      const { pc, dc } = await createRealtimeConnection(
        EPHEMERAL_KEY,
        audioElementRef
      );
      pcRef.current = pc;
      dcRef.current = dc;

      dc.addEventListener("open", () => {
        logClientEvent({}, "data_channel.open");
      });
      dc.addEventListener("close", () => {
        logClientEvent({}, "data_channel.close");
      });
      dc.addEventListener("error", (err: any) => {
        logClientEvent({ error: err }, "data_channel.error");
      });
      dc.addEventListener("message", (e: MessageEvent) => {
        handleServerEventRef.current(JSON.parse(e.data));
      });

      setDataChannel(dc);
    } catch (err) {
      console.error("Error connecting to realtime:", err);
      setSessionStatus("DISCONNECTED");
    }
  };

  const disconnectFromRealtime = () => {
    clearHandsFreeReopen();
    pttHeldRef.current = false;
    setIsTalking(false);
    fastapiSessionRef.current?.disconnect();
    fastapiSessionRef.current = null;

    if (botRevealRafRef.current != null) {
      window.cancelAnimationFrame(botRevealRafRef.current);
      botRevealRafRef.current = null;
    }
    botRevealLastAtRef.current = null;
    botTargetTextRef.current = {};
    botShownTextRef.current = {};

    if (pcRef.current) {
      pcRef.current.getSenders().forEach((sender) => {
        if (sender.track) {
          sender.track.stop();
        }
      });

      pcRef.current.close();
      pcRef.current = null;
    }
    setDataChannel(null);
    setSessionStatus("DISCONNECTED");
    updateVoiceStatus("disconnected");
    setIsPTTUserSpeaking(false);

    logClientEvent({}, "disconnected");
  };

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          id,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
      "(simulated user text message)"
    );
    sendClientEvent(
      { type: "response.create" },
      "(trigger response after simulated user text message)"
    );
  };

  const createFirstMessage = () => {
    return personality?.first_message_prompt
    ? `Always start the conversation following these instructions from the user: ${personality?.first_message_prompt}`
    : "The user is initiating a new chat here. Say something!";
  }

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    if (shouldUseFastAPIVoice(personality?.provider)) {
      return;
    }

    sendClientEvent(
      { type: "input_audio_buffer.clear" },
      "clear audio buffer on session update"
    );

    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 200,
          create_response: true,
        };

    const tools = currentAgent?.tools || [];

    const sessionUpdateEvent = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: turnDetection,
        tools,
      },
    };

    sendClientEvent(sessionUpdateEvent);

    if (shouldTriggerResponse) {
      sendSimulatedUserMessage(isDoctor ? "Ask the doctor if everything is good and how you can help them and their patient." : createFirstMessage());
    }
  };

  const onToggleConnection = () => {
    // Only connect if we're disconnected
    if (sessionStatus === "DISCONNECTED") {
      connectToRealtime();
      setIsSheetOpen(true);
    } else {
      // If already connected or connecting, disconnect
      disconnectFromRealtime();
      setSessionStatus("DISCONNECTED");
      setIsSheetOpen(false);
    }
  };

  const cancelAssistantSpeech = async () => {
    const mostRecentAssistantMessage = [...transcriptItems]
      .reverse()
      .find((item) => item.role === "assistant");

    if (!mostRecentAssistantMessage) {
      console.warn("can't cancel, no recent assistant message found");
      return;
    }
    if (mostRecentAssistantMessage.status === "DONE") {
      console.log("No truncation needed, message is DONE");
      return;
    }

    sendClientEvent({
      type: "conversation.item.truncate",
      item_id: mostRecentAssistantMessage?.itemId,
      content_index: 0,
      audio_end_ms: Date.now() - mostRecentAssistantMessage.createdAtMs,
    });
    sendClientEvent(
      { type: "response.cancel" },
      "(cancel due to user interruption)"
    );
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    cancelAssistantSpeech();

    sendClientEvent(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText.trim() }],
        },
      },
      "(send user text message)"
    );
    setUserText("");

    sendClientEvent({ type: "response.create" }, "trigger response");
  };

  useEffect(() => {
    const storedMicMode = parseMicMode(localStorage.getItem(MIC_MODE_STORAGE_KEY));
    micModeRef.current = storedMicMode;
    setMicMode(storedMicMode);
  }, []);

  useEffect(() => {
    const storedPushToTalkUI = localStorage.getItem("pushToTalkUI");
    if (storedPushToTalkUI) {
      setIsPTTActive(storedPushToTalkUI === "true");
    }
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("pushToTalkUI", isPTTActive.toString());
  }, [isPTTActive]);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElementRef.current) {
      if (isAudioPlaybackEnabled) {
        audioElementRef.current.play().catch((err) => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElementRef.current.pause();
      }
    }
  }, [isAudioPlaybackEnabled]);

  const handleSheetOpenChange = (open: boolean) => {
    setIsSheetOpen(open);
    
    // If sheet is closed, disconnect
    if (!open && (sessionStatus === "CONNECTED" || sessionStatus === "CONNECTING")) {
      disconnectFromRealtime();
      setSessionStatus("DISCONNECTED");
    }
  };

  const usesFastAPI = personality
    ? shouldUseFastAPIVoice(personality.provider)
    : false;
  const triggerDisabled =
    sessionStatus === "CONNECTING" ||
    !personality ||
    (!usesFastAPI && personality?.provider === "gemini");

  const trigger = renderTrigger ? (
    renderTrigger({
      sessionStatus,
      onToggleConnection,
      isDoctor,
      personality,
      usesFastAPI,
      disabled: triggerDisabled,
    })
  ) : personality ? (
    <BottomToolbar
      sessionStatus={sessionStatus}
      onToggleConnection={onToggleConnection}
      isDoctor={isDoctor}
      personality={personality}
      usesFastAPI={usesFastAPI}
    />
  ) : null;

  if (!personality) {
    return trigger;
  }

  return   <Sheet open={isSheetOpen} onOpenChange={handleSheetOpenChange}>
    <div className="inline-block">
       {trigger}
    </div>
  <SheetContent
    side="bottom"
    hideCloseButton
    overlayClassName="bg-black/45"
    className="flex flex-col inset-x-3 top-[4.75rem] bottom-3 w-auto gap-0 overflow-hidden rounded-[28px] border-0 bg-transparent p-0 shadow-2xl md:inset-x-auto md:bottom-auto md:left-1/2 md:right-auto md:top-[5%] md:h-[min(760px,86vh)] md:w-[min(440px,92vw)] md:-translate-x-1/2 [&>button]:hidden"
  >
    <div className="flex h-full min-h-0 flex-col">
        <SheetTitle className="sr-only">{personality.title}</SheetTitle>
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          canSend={
            !usesFastAPI &&
            sessionStatus === "CONNECTED" &&
            dcRef.current?.readyState === "open"
          }
          personality={personality}
          voiceStatus={usesFastAPI ? voiceStatus : undefined}
          micMode={usesFastAPI ? micMode : undefined}
          isTalking={isTalking}
          onTalkStart={usesFastAPI ? startTalking : undefined}
          onTalkEnd={usesFastAPI ? stopTalking : undefined}
          onToggleMicMode={
            usesFastAPI
              ? () => applyMicMode(micModeRef.current === "ptt" ? "hands_free" : "ptt")
              : undefined
          }
          onRestartConversation={usesFastAPI ? restartConversation : undefined}
        />
    </div>
  </SheetContent>
</Sheet>
}

export default App;

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
import { toast } from "@/components/ui/use-toast";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import Transcript from "./components/Transcript";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { getPersonalityById } from "@/db/personalities";
import { createClient } from "@/utils/supabase/client";

interface AppProps {
  personalityIdState: string;
  isDoctor: boolean;
  userId: string;
}

function App({ personalityIdState, isDoctor, userId }: AppProps) {
  const supabase = createClient();

  const { transcriptItems, addTranscriptMessage, upsertTranscriptMessage, updateTranscriptItemStatus } =
    useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] =
    useState<AgentConfig[] | null>(null);

    const [isSheetOpen, setIsSheetOpen] = useState<boolean>(false);
    const [userText, setUserText] = useState<string>("");

  const isMobile = useMediaQuery("(max-width: 768px)");

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
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");
  const [voiceStatus, setVoiceStatus] =
    useState<VoiceTurnStatus>("disconnected");

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

  const revealBotText = (itemId: string, flush = false) => {
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
    const nextCount = remaining > 24 ? Math.min(remaining, 4) : remaining > 8 ? 2 : 1;
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
      let needMore = false;
      Object.keys(botTargetTextRef.current).forEach((itemId) => {
        if (revealBotText(itemId)) {
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
        setVoiceStatus("user_speaking");
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
        setVoiceStatus(message.final ? "thinking" : "user_speaking");
        break;
      }
      case "AUDIO.COMMITTED": {
        setVoiceStatus("thinking");
        break;
      }
      case "BOT.TRANSCRIPT": {
        if (!itemId || !text) break;
        appendBotTranscript(itemId, text, message.delta === false);
        setVoiceStatus("speaking");
        break;
      }
      case "RESPONSE.CREATED": {
        if (itemId && !botTargetTextRef.current[itemId]) {
          upsertTranscriptMessage(itemId, "assistant", "[Speaking...]", "placeholder");
        }
        setVoiceStatus("speaking");
        break;
      }
      case "RESPONSE.COMPLETE": {
        if (itemId) {
          flushBotTranscript(itemId);
          updateTranscriptItemStatus(itemId, "DONE");
        } else {
          flushBotTranscript();
        }
        setVoiceStatus("listening");
        break;
      }
      case "RESPONSE.ERROR": {
        setVoiceStatus("listening");
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
      setVoiceStatus("connecting");
      const voiceUrl = getFastAPIVoiceUrl({
        voice: personality?.oai_voice,
        title: personality?.title,
        characterPrompt: personality?.character_prompt,
        voicePrompt: personality?.voice_prompt,
        firstMessagePrompt: personality?.first_message_prompt,
      });
      try {
        const session = new FastAPIVoiceSession({
          onOpen: () => {
            logClientEvent({ url: voiceUrl }, "fastapi.socket.open");
            setSessionStatus("CONNECTED");
            setVoiceStatus("listening");
          },
          onClose: () => {
            logClientEvent({}, "fastapi.socket.close");
            setSessionStatus("DISCONNECTED");
            setVoiceStatus("disconnected");
          },
          onError: (error) => {
            logClientEvent({ error: String(error.type) }, "fastapi.socket.error");
            toast({
              description: "Could not reach the FastAPI voice server. Is it running on port 7860?",
            });
            setSessionStatus("DISCONNECTED");
            setVoiceStatus("disconnected");
          },
          onControlMessage: (message) => handleFastAPIControlRef.current(message),
        });
        fastapiSessionRef.current = session;
        await session.connect(voiceUrl);
      } catch (err) {
        console.error("Error connecting to FastAPI voice:", err);
        fastapiSessionRef.current?.disconnect();
        fastapiSessionRef.current = null;
        setSessionStatus("DISCONNECTED");
        setVoiceStatus("disconnected");
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
    fastapiSessionRef.current?.disconnect();
    fastapiSessionRef.current = null;

    if (botRevealRafRef.current != null) {
      window.cancelAnimationFrame(botRevealRafRef.current);
      botRevealRafRef.current = null;
    }
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
    setVoiceStatus("disconnected");
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

  if (!personality) {
    return null;
  }

  const usesFastAPI = shouldUseFastAPIVoice(personality.provider);

  return   <Sheet open={isSheetOpen} onOpenChange={handleSheetOpenChange}>
    <div className="inline-block">
       <BottomToolbar
        sessionStatus={sessionStatus}
        onToggleConnection={onToggleConnection}
        isDoctor={isDoctor}
        personality={personality}
        usesFastAPI={usesFastAPI}
      />
    </div>
  <SheetContent 
    side={isMobile ? "bottom" : "right"} 
    className="h-[80vh] md:h-full p-0"
    style={{ maxWidth: isMobile ? "100%" : "50%" }}
  >
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden">
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
          userId={userId}
          isDoctor={isDoctor}
          supabase={supabase}
          voiceStatus={usesFastAPI ? voiceStatus : undefined}
        />
      </div>
    </div>
  </SheetContent>
</Sheet>
}

export default App;

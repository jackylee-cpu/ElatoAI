"use client";

import React, { useEffect, useRef, useState } from "react";
import { TranscriptItem, VoiceTurnStatus } from "@/app/components/Realtime/types";
import { MicMode } from "@/app/components/Realtime/lib/micMode";
import Image from "next/image";
import { useTranscript } from "@/app/components/Realtime/contexts/TranscriptContext";
import { cn, getPersonalityAvatarSrc } from "@/lib/utils";
import { dbInsertTranscriptItem } from "@/db/conversations";
import { SupabaseClient } from "@supabase/supabase-js";
import { EmojiComponent } from "../../Playground/EmojiImage";
import { playgroundAssets } from "../../Playground/playgroundAssets";
import { CloseIcon, MicIcon } from "../../Playground/icons";
import { SheetClose } from "@/components/ui/sheet";
import { Loader2 } from "lucide-react";

export interface TranscriptProps {
  userText: string;
  setUserText: (val: string) => void;
  onSendMessage: () => void;
  canSend: boolean;
  personality: IPersonality;
  userId: string;
  isDoctor: boolean;
  supabase: SupabaseClient;
  voiceStatus?: VoiceTurnStatus;
  micMode?: MicMode;
  isTalking?: boolean;
  onTalkStart?: () => void;
  onTalkEnd?: () => void;
  onToggleMicMode?: () => void;
  onRestartConversation?: () => void;
}

const VOICE_STATUS_LABELS: Record<VoiceTurnStatus, string> = {
  disconnected: "",
  connecting: "Connecting…",
  idle: "Ready",
  listening: "Listening…",
  user_speaking: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

const WAVEFORM_BARS = [
  8, 14, 22, 12, 18, 30, 16, 24, 34, 20, 26, 14, 20, 10, 16, 28, 22, 12, 18,
  32, 16, 10, 20, 26, 14, 22, 12, 8, 16, 24, 18, 12, 20, 28, 14, 22, 10, 16,
];

function TalkWaveform({ active }: { active: boolean }) {
  return (
    <div className="flex h-9 min-w-0 flex-1 items-center gap-[2px]" aria-hidden>
      {WAVEFORM_BARS.map((height, index) => (
        <span
          key={index}
          className={cn(
            "max-w-[4px] flex-1 rounded-full bg-[#3B82F6] origin-center",
            active && "animate-waveform"
          )}
          style={{
            height,
            animationDelay: active ? `${(index % 8) * 80}ms` : undefined,
            opacity: active ? 1 : 0.55,
          }}
        />
      ))}
    </div>
  );
}

function formatBubbleTime(createdAtMs: number) {
  return new Date(createdAtMs)
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .toLowerCase();
}

function Transcript({
  personality,
  userId,
  isDoctor,
  supabase,
  voiceStatus,
  isTalking = false,
  onTalkStart,
  onTalkEnd,
}: TranscriptProps) {
  const { transcriptItems } = useTranscript();
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [prevLogs, setPrevLogs] = useState<TranscriptItem[]>([]);

  function scrollToBottom() {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }

  useEffect(() => {
    const hasNewMessage = transcriptItems.length > prevLogs.length;
    const hasUpdatedMessage = transcriptItems.some((newItem, index) => {
      const oldItem = prevLogs[index];
      return (
        oldItem &&
        (newItem.title !== oldItem.title || newItem.data !== oldItem.data)
      );
    });

    if (hasNewMessage || hasUpdatedMessage) {
      const el = transcriptRef.current;
      if (el) {
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (nearBottom || hasNewMessage) {
          scrollToBottom();
        }
      }

      if (hasUpdatedMessage) {
        transcriptItems.forEach((newItem, index) => {
          const oldItem = prevLogs[index];
          if (oldItem && (newItem.title !== oldItem.title || newItem.data !== oldItem.data)) {
            if (newItem.type === "MESSAGE" && newItem.role === "user" && newItem.status === "DONE") {
              dbInsertTranscriptItem(supabase, newItem, userId, personality.key, isDoctor);
            }
          }
        });
      }
    }

    setPrevLogs(transcriptItems);
  }, [transcriptItems]);

  const statusLabel =
    voiceStatus && voiceStatus !== "disconnected"
      ? VOICE_STATUS_LABELS[voiceStatus]
      : "";
  const isLiveStatus =
    voiceStatus === "speaking" ||
    voiceStatus === "listening" ||
    voiceStatus === "user_speaking";
  const waveformActive =
    isTalking ||
    voiceStatus === "user_speaking" ||
    voiceStatus === "listening" ||
    voiceStatus === "speaking";
  const canHoldToTalk = Boolean(onTalkStart && onTalkEnd);
  const holdDisabled = voiceStatus === "connecting";
  const hasMessages = transcriptItems.some(
    (item) => item.type === "MESSAGE" && !item.isHidden
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-[28px] bg-white">
      <Image
        src={playgroundAssets.chatBg}
        alt=""
        fill
        sizes="(max-width: 768px) 100vw, 440px"
        className="object-cover object-top"
        priority
      />

      <div className="relative z-10 flex items-center gap-3 bg-white/90 px-4 py-3 backdrop-blur-sm">
        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-full bg-gray-100">
          {getPersonalityAvatarSrc(personality) ? (
            <Image
              src={getPersonalityAvatarSrc(personality)!}
              alt={personality.title}
              width={48}
              height={48}
              className="h-full w-full object-cover object-top"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <EmojiComponent personality={personality} size={48} />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-gray-900">
            {personality.title}
          </h2>
          {statusLabel && (
            <p
              className={cn(
                "flex items-center gap-1.5 text-sm",
                isLiveStatus ? "text-emerald-500" : "text-gray-400"
              )}
            >
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  isLiveStatus ? "bg-emerald-500" : "bg-gray-300"
                )}
              />
              {statusLabel}
            </p>
          )}
        </div>
        <SheetClose asChild>
          <button
            type="button"
            aria-label="Close chat"
            className="shrink-0 transition-transform hover:scale-105 active:scale-95"
          >
            <CloseIcon className="h-10 w-10" />
          </button>
        </SheetClose>
      </div>

      <div
        ref={transcriptRef}
        className="relative z-10 flex-1 space-y-3 overflow-y-auto px-4 py-4"
      >
        {!hasMessages && (
          <p className="mt-10 text-center text-sm text-gray-400">
            Hold the mic to start talking
          </p>
        )}
        {transcriptItems.map((item) => {
          const { itemId, type, role, title = "", isHidden, createdAtMs, status } = item;
          if (isHidden || type !== "MESSAGE") return null;

          const isUser = role === "user";
          const isBracketedMessage = title.startsWith("[") && title.endsWith("]");
          const displayTitle = isBracketedMessage ? title.slice(1, -1) : title;
          const showCaret = status === "IN_PROGRESS" && !isBracketedMessage;

          return (
            <div
              key={itemId}
              className={cn("flex", isUser ? "justify-end" : "justify-start")}
            >
              <div
                className={cn(
                  "max-w-[85%] rounded-[20px] px-4 py-3 shadow-sm",
                  isUser
                    ? "rounded-tr-md bg-[#D7F3FA] text-gray-800"
                    : "rounded-tl-md bg-white text-gray-800"
                )}
              >
                <p
                  className={cn(
                    "whitespace-pre-wrap break-words text-[15px] leading-relaxed",
                    isBracketedMessage && "italic text-gray-400"
                  )}
                >
                  {displayTitle}
                  {showCaret && (
                    <span className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse align-[-2px] bg-gray-500" />
                  )}
                </p>
                <p className="mt-1 text-right text-[11px] italic text-gray-400">
                  {formatBubbleTime(createdAtMs)}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      <div
        className="relative z-10 flex items-center gap-3 bg-white px-4 pt-3"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <button
          type="button"
          aria-label={isTalking ? "Release to send" : "Hold to talk"}
          disabled={!canHoldToTalk || holdDisabled}
          onPointerDown={(e) => {
            if (!canHoldToTalk) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            onTalkStart?.();
          }}
          onPointerUp={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
            onTalkEnd?.();
          }}
          onPointerCancel={() => onTalkEnd?.()}
          onContextMenu={(e) => e.preventDefault()}
          className={cn(
            "relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full touch-none select-none",
            "shadow-[0_8px_18px_rgba(88,86,214,0.28)]",
            isTalking && "scale-95 ring-4 ring-indigo-200",
            (!canHoldToTalk || holdDisabled) && "cursor-not-allowed opacity-70"
          )}
        >
          <MicIcon className="h-full w-full" />
          {holdDisabled && (
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-indigo-600/40">
              <Loader2 className="h-6 w-6 animate-spin text-white" />
            </span>
          )}
        </button>
        <TalkWaveform active={waveformActive} />
      </div>
    </div>
  );
}

export default Transcript;

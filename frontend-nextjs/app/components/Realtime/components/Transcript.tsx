"use client";

import React, { useEffect, useRef, useState } from "react";
import { TranscriptItem, VoiceTurnStatus } from "@/app/components/Realtime/types";
import { MicMode } from "@/app/components/Realtime/lib/micMode";
import Image from "next/image";
import { useTranscript } from "@/app/components/Realtime/contexts/TranscriptContext";
import { getPersonalityImageSrc } from "@/lib/utils";
import { ArrowRight, Mic, RotateCcw } from "lucide-react";
import { dbInsertTranscriptItem } from "@/db/conversations";
import { SupabaseClient } from "@supabase/supabase-js";
import { EmojiComponent } from "../../Playground/EmojiImage";

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
  idle: "Hold to talk",
  listening: "Listening",
  user_speaking: "Hearing you…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

function formatMs(ms?: number) {
  if (ms == null || Number.isNaN(ms)) return null;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.max(0, Math.round(ms))}ms`;
}

function timingLabel(item: TranscriptItem) {
  const first = formatMs(item.firstLatencyMs);
  const elapsed = formatMs(item.elapsedMs);
  const parts: string[] = [];
  if (first) parts.push(`首字 ${first}`);
  if (item.status === "DONE" && elapsed && elapsed !== first) parts.push(`定稿 ${elapsed}`);
  else if (elapsed && !first) parts.push(elapsed);
  return parts.join(" · ");
}

function Transcript({
  userText,
  setUserText,
  onSendMessage,
  canSend,
  personality,
  userId,
  isDoctor,
  supabase,
  voiceStatus,
  micMode,
  isTalking = false,
  onTalkStart,
  onTalkEnd,
  onToggleMicMode,
  onRestartConversation,
}: TranscriptProps) {
  const { transcriptItems, toggleTranscriptItemExpand } = useTranscript();
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [prevLogs, setPrevLogs] = useState<TranscriptItem[]>([]);
  const [justCopied, setJustCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const liveItem = [...transcriptItems].reverse().find(
    (item) => item.type === "MESSAGE" && item.role === "user" && !item.isHidden
  );
  const showLiveCaption =
    Boolean(voiceStatus && voiceStatus !== "disconnected") &&
    Boolean(liveItem) &&
    (liveItem?.status === "IN_PROGRESS" || voiceStatus === "user_speaking");

  function scrollToBottom() {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }

  useEffect(() => {
    if (!showLiveCaption) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [showLiveCaption]);

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

  // Autofocus on text box input on load
  useEffect(() => {
    if (canSend && inputRef.current) {
      inputRef.current.focus();
    }
  }, [canSend]);

  const liveText = liveItem?.title && !liveItem.title.startsWith("[") ? liveItem.title : "";
  const liveElapsed = liveItem
    ? formatMs(liveItem.elapsedMs ?? Math.max(0, nowMs - liveItem.createdAtMs))
    : null;

  return (
<div className="flex flex-col h-full bg-white rounded-xl" style={{ fontFamily: '"PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", "Heiti SC", sans-serif' }}>
      {/* Fixed Personality header */}
      <div className="sticky top-0 p-4 border-b border-gray-200 flex items-center bg-white">
      <div className="w-12 h-12 rounded-full bg-gray-200 overflow-hidden mr-3">
          {personality.key && (
            personality.creator_id === null ? (
              <Image 
                src={getPersonalityImageSrc(personality.key)} 
                alt={personality.title} 
                width={48} 
                height={48} 
                className="object-cover w-full h-full"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <EmojiComponent personality={personality} size={48} />
              </div>
            )
          )}
        </div>
        <div className="flex-1">
          <h2 className="font-medium text-lg">{personality.title}</h2>
          <p className="text-sm text-gray-500">
            {voiceStatus && voiceStatus !== "disconnected"
              ? VOICE_STATUS_LABELS[voiceStatus]
              : personality.subtitle}
          </p>
        </div>
        {/* <button
          onClick={handleCopyTranscript}
          className="text-sm px-3 py-1.5 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-700"
        >
          {justCopied ? "Copied!" : "Copy"}
        </button> */}
      </div>

    {/* Transcript */}
 <div 
        ref={transcriptRef}
        className="flex-1 overflow-y-auto p-4 flex flex-col gap-y-3"
      >
        {transcriptItems.every((item) => item.type !== "MESSAGE" || item.isHidden) && (
          <div className="text-sm text-gray-400 text-center mt-8">
            {voiceStatus && voiceStatus !== "disconnected"
              ? `${VOICE_STATUS_LABELS[voiceStatus]}. Start talking.`
              : "Talk to see the conversation here."}
          </div>
        )}
        {transcriptItems.map((item) => {
          const { itemId, type, role, data, expanded, timestamp, title = "", isHidden } = item;

          if (isHidden) {
            return null;
          }

          if (type === "MESSAGE") {
            const isUser = role === "user";
            const containerClasses = `flex ${isUser ? "justify-end" : "justify-start"} mb-2`;
            const bubbleClasses = `max-w-[80%] p-3 rounded-xl ${
              isUser ? "bg-blue-400 text-white" : "bg-yellow-100 text-gray-800"
            } border-2 ${isUser ? "border-blue-500" : "border-yellow-200"} shadow-sm`;
            const isBracketedMessage = title.startsWith("[") && title.endsWith("]");
            const messageStyle = isBracketedMessage
              ? "italic text-gray-400 text-lg leading-relaxed"
              : "text-lg font-medium leading-relaxed tracking-wide";
            const displayTitle = isBracketedMessage ? title.slice(1, -1) : title;
            const showCaret = item.status === "IN_PROGRESS" && !isBracketedMessage;
            const timing = isUser ? timingLabel(item) : "";

            return (
              <div key={itemId} className={containerClasses}>
                <div className={bubbleClasses}>
                  <div className={`${messageStyle} whitespace-pre-wrap break-words`}>
                    {displayTitle}
                    {showCaret && (
                      <span className={`inline-block w-[2px] h-[1em] ml-0.5 align-[-2px] animate-pulse ${isUser ? "bg-white" : "bg-gray-700"}`} />
                    )}
                  </div>
                  <div className="text-xs opacity-70 mt-1 text-right flex items-center justify-end gap-2">
                    {timing && <span>{timing}</span>}
                    <span>{timestamp}</span>
                  </div>
                </div>
              </div>
            );
          }
        })}
      </div>
      {showLiveCaption && liveItem && (
        <div className="px-4 pb-2">
          <div className="rounded-2xl bg-slate-950 text-white px-4 py-3 shadow-lg">
            <div className="flex items-center justify-between gap-3 text-[11px] tracking-widest text-emerald-300">
              <span>{liveText ? "即時字幕" : "聆聽中"}</span>
              <span className="font-mono tracking-normal text-emerald-200">
                {formatMs(liveItem.firstLatencyMs) ? `首字 ${formatMs(liveItem.firstLatencyMs)}` : liveElapsed}
              </span>
            </div>
            <p className="mt-2 text-2xl font-medium leading-snug tracking-wide min-h-[2rem]">
              {liveText || "…"}
              {liveItem.status === "IN_PROGRESS" && (
                <span className="inline-block w-[3px] h-[1.1em] bg-emerald-300 ml-1 align-[-3px] animate-pulse" />
              )}
            </p>
          </div>
        </div>
      )}
      {voiceStatus && voiceStatus !== "disconnected" && (
        <div className="sticky bottom-0 px-4 py-3 border-t border-gray-200 bg-gray-50 flex flex-col gap-3">
          <div className="text-sm text-gray-600 flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                voiceStatus === "speaking" || voiceStatus === "user_speaking"
                  ? "bg-green-500"
                  : voiceStatus === "thinking" || voiceStatus === "connecting"
                    ? "bg-amber-500"
                    : "bg-blue-500"
              }`}
            />
            {VOICE_STATUS_LABELS[voiceStatus]}
            {liveElapsed && voiceStatus === "user_speaking" && (
              <span className="ml-auto font-mono text-xs text-gray-500">{liveElapsed}</span>
            )}
          </div>

          {onTalkStart && onTalkEnd && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                // Pointer capture keeps the release on this button even if the
                // finger slides off it mid-sentence, so the mic cannot be left
                // open by a sloppy drag.
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  onTalkStart();
                }}
                onPointerUp={(e) => {
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  }
                  onTalkEnd();
                }}
                onPointerCancel={() => onTalkEnd()}
                onContextMenu={(e) => e.preventDefault()}
                disabled={voiceStatus === "connecting"}
                className={`flex-1 select-none touch-none rounded-full px-4 py-3 text-base font-medium shadow-sm flex items-center justify-center gap-2 transition-colors ${
                  isTalking
                    ? "bg-red-600 text-white"
                    : "bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-400"
                }`}
              >
                <Mic size={18} />
                {isTalking ? "Release to send" : "Hold to talk"}
              </button>
              {onRestartConversation && (
                <button
                  type="button"
                  onClick={onRestartConversation}
                  title="Start a new conversation"
                  className="rounded-full p-3 bg-gray-200 text-gray-700 hover:bg-gray-300"
                >
                  <RotateCcw size={18} />
                </button>
              )}
            </div>
          )}

          {micMode && onToggleMicMode && (
            <div className="flex items-center justify-between text-xs text-gray-500">
              <span>
                {micMode === "ptt"
                  ? "Push-to-talk (hold the button or the space bar)"
                  : "Hands-free: the mic reopens after each answer"}
              </span>
              <button
                type="button"
                onClick={onToggleMicMode}
                className="underline underline-offset-2 hover:text-gray-700"
              >
                {micMode === "ptt" ? "Switch to hands-free" : "Switch to push-to-talk"}
              </button>
            </div>
          )}
        </div>
      )}

    {/* 
    <div className="sticky bottom-0 left-0 right-0 p-3 flex items-center gap-x-2 border-t border-gray-200 bg-gray-50 shadow-md">
        <input
          ref={inputRef}
          type="text"
          value={userText}
          onChange={(e) => setUserText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSend) {
              onSendMessage();
            }
          }}
          className="flex-1 px-4 py-2 rounded-full border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          placeholder="Type a message..."
        />
        <button
          onClick={onSendMessage}
          disabled={!canSend || !userText.trim()}
          className="bg-blue-600 text-white rounded-full w-10 h-10 flex items-center justify-center disabled:opacity-50 disabled:bg-gray-400"
        >
          <ArrowRight size={20} />
        </button>
      </div> */}
  </div>
  );
}

export default Transcript;

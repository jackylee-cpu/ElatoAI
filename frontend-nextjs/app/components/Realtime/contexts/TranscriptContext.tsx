"use client";

import React, { createContext, useContext, useState, FC, PropsWithChildren } from "react";
import { v4 as uuidv4 } from "uuid";
import { TranscriptItem, TranscriptTiming } from "@/app/components/Realtime/types";

type TranscriptContextValue = {
  transcriptItems: TranscriptItem[];
  addTranscriptMessage: (itemId: string, role: "user" | "assistant", text: string, hidden?: boolean) => void;
  updateTranscriptMessage: (itemId: string, text: string, isDelta: boolean) => void;
  upsertTranscriptMessage: (
    itemId: string,
    role: "user" | "assistant",
    text: string,
    mode?: "replace" | "append" | "placeholder",
    extras?: TranscriptTiming
  ) => void;
  addTranscriptBreadcrumb: (title: string, data?: Record<string, any>) => void;
  toggleTranscriptItemExpand: (itemId: string) => void;
  updateTranscriptItemStatus: (itemId: string, newStatus: "IN_PROGRESS" | "DONE") => void;
};

const TranscriptContext = createContext<TranscriptContextValue | undefined>(undefined);

export const TranscriptProvider: FC<PropsWithChildren> = ({ children }) => {
  const [transcriptItems, setTranscriptItems] = useState<TranscriptItem[]>([]);

  function newTimestampPretty(): string {
    return new Date().toLocaleTimeString([], {
      hour12: true,
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  const addTranscriptMessage: TranscriptContextValue["addTranscriptMessage"] = (itemId, role, text = "", isHidden = false) => {
    setTranscriptItems((prev) => {
      if (prev.some((log) => log.itemId === itemId && log.type === "MESSAGE")) {
        console.warn(`[addTranscriptMessage] skipping; message already exists for itemId=${itemId}, role=${role}, text=${text}`);
        return prev;
      }

      const newItem: TranscriptItem = {
        itemId,
        type: "MESSAGE",
        role,
        title: text,
        expanded: false,
        timestamp: newTimestampPretty(),
        createdAtMs: Date.now(),
        status: "IN_PROGRESS",
        isHidden,
      };

      return [...prev, newItem];
    });
  };

  const updateTranscriptMessage: TranscriptContextValue["updateTranscriptMessage"] = (itemId, newText, append = false) => {
    setTranscriptItems((prev) =>
      prev.map((item) => {
        if (item.itemId === itemId && item.type === "MESSAGE") {
          return {
            ...item,
            title: append ? (item.title ?? "") + newText : newText,
          };
        }
        return item;
      })
    );
  };

  const upsertTranscriptMessage: TranscriptContextValue["upsertTranscriptMessage"] = (
    itemId,
    role,
    text,
    mode = "replace",
    extras
  ) => {
    setTranscriptItems((prev) => {
      const existing = prev.find((item) => item.itemId === itemId && item.type === "MESSAGE");
      if (!existing) {
        return [
          ...prev,
          {
            itemId,
            type: "MESSAGE",
            role,
            title: text,
            expanded: false,
            timestamp: newTimestampPretty(),
            createdAtMs: Date.now(),
            status: "IN_PROGRESS",
            isHidden: false,
            latencyMs: extras?.latencyMs,
            firstLatencyMs: extras?.firstLatencyMs ?? extras?.latencyMs,
            elapsedMs: extras?.elapsedMs,
            durationMs: extras?.durationMs,
            words: extras?.words,
          },
        ];
      }
      if (mode === "placeholder") {
        return prev;
      }
      return prev.map((item) => {
        if (item.itemId === itemId && item.type === "MESSAGE") {
          const current = item.title ?? "";
          const isPlaceholder = current.startsWith("[") && current.endsWith("]");
          const nextTitle =
            mode === "append"
              ? isPlaceholder
                ? text
                : `${current}${text}`
              : text;
          return {
            ...item,
            title: nextTitle,
            latencyMs: extras?.latencyMs ?? item.latencyMs,
            firstLatencyMs: item.firstLatencyMs ?? extras?.firstLatencyMs ?? extras?.latencyMs,
            elapsedMs: extras?.elapsedMs ?? item.elapsedMs,
            durationMs: extras?.durationMs ?? item.durationMs,
            words: extras?.words ?? item.words,
          };
        }
        return item;
      });
    });
  };

  const addTranscriptBreadcrumb: TranscriptContextValue["addTranscriptBreadcrumb"] = (title, data) => {
    setTranscriptItems((prev) => [
      ...prev,
      {
        itemId: `breadcrumb-${uuidv4()}`,
        type: "BREADCRUMB",
        title,
        data,
        expanded: false,
        timestamp: newTimestampPretty(),
        createdAtMs: Date.now(),
        status: "DONE",
        isHidden: false,
      },
    ]);
  };

  const toggleTranscriptItemExpand: TranscriptContextValue["toggleTranscriptItemExpand"] = (itemId) => {
    setTranscriptItems((prev) =>
      prev.map((log) =>
        log.itemId === itemId ? { ...log, expanded: !log.expanded } : log
      )
    );
  };

  const updateTranscriptItemStatus: TranscriptContextValue["updateTranscriptItemStatus"] = (itemId, newStatus) => {
    setTranscriptItems((prev) =>
      prev.map((item) =>
        item.itemId === itemId ? { ...item, status: newStatus } : item
      )
    );
  };

  return (
    <TranscriptContext.Provider
      value={{
        transcriptItems,
        addTranscriptMessage,
        updateTranscriptMessage,
        upsertTranscriptMessage,
        addTranscriptBreadcrumb,
        toggleTranscriptItemExpand,
        updateTranscriptItemStatus,
      }}
    >
      {children}
    </TranscriptContext.Provider>
  );
};

export function useTranscript() {
  const context = useContext(TranscriptContext);
  if (!context) {
    throw new Error("useTranscript must be used within a TranscriptProvider");
  }
  return context;
}
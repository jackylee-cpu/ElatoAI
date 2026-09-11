"use client";

import Image from "next/image";
import { Loader2 } from "lucide-react";
import { SessionStatus } from "@/app/components/Realtime/types";
import { playgroundAssets } from "./playgroundAssets";
import { cn } from "@/lib/utils";

export function PlaygroundMicButton({
    sessionStatus,
    onToggleConnection,
    disabled,
}: {
    sessionStatus: SessionStatus;
    onToggleConnection: () => void;
    disabled: boolean;
}) {
    const isConnecting = sessionStatus === "CONNECTING";
    const isConnected = sessionStatus === "CONNECTED";
    const isDisabled = disabled || isConnecting;

    return (
        <button
            type="button"
            onClick={onToggleConnection}
            disabled={isDisabled}
            aria-label={isConnected ? "End chat" : "Talk"}
            className={cn(
                "relative -mt-7 flex h-[72px] w-[72px] items-center justify-center rounded-full transition-transform md:-mt-8 md:h-20 md:w-20",
                "shadow-[0_10px_24px_rgba(88,86,214,0.35)]",
                isConnected && "ring-4 ring-indigo-200",
                isDisabled ? "cursor-not-allowed opacity-80" : "hover:scale-105 active:scale-95"
            )}
        >
            <Image
                src={playgroundAssets.mic}
                alt=""
                width={80}
                height={80}
                className="h-full w-full object-contain"
                priority
            />
            {isConnecting && (
                <span className="absolute inset-0 flex items-center justify-center rounded-full bg-indigo-600/40">
                    <Loader2 className="h-7 w-7 animate-spin text-white" />
                </span>
            )}
        </button>
    );
}

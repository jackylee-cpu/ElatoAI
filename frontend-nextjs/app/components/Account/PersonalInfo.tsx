"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, ChevronRight, Copy } from "lucide-react";
import { signOutAction } from "@/app/actions";
import { BackIcon } from "../Playground/icons";
import { AccountAvatar } from "./AccountAvatar";
import { cn } from "@/lib/utils";

const cardClass =
    "rounded-[24px] bg-white/90 shadow-[0_8px_24px_rgba(80,120,180,0.08)] backdrop-blur-sm";

const rowClass =
    "flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-4 text-base text-gray-800 last:border-b-0";

export default function PersonalInfo({ currentUser }: { currentUser: IUser }) {
    // The full id is a UUID; the first block is enough to read out to support,
    // and copying gives them the whole thing.
    const shortId = currentUser.user_id.split("-")[0];
    const [copied, setCopied] = useState(false);

    const copyId = async () => {
        try {
            await navigator.clipboard.writeText(currentUser.user_id);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard is blocked in some WebViews; the id is still on screen.
        }
    };

    return (
        <div className="relative z-10 mx-auto flex h-full w-full max-w-lg flex-col px-4 pt-[max(0.75rem,env(safe-area-inset-top))] md:max-w-xl md:px-8 md:pt-8">
            <header className="relative mb-3 flex h-14 shrink-0 items-center justify-center md:h-16">
                <Link
                    href="/home/account"
                    aria-label="Back to Me"
                    className="absolute left-0 top-1/2 -translate-y-1/2 transition-transform hover:scale-105 active:scale-95"
                >
                    <BackIcon className="h-10 w-10" />
                </Link>
                <h1 className="font-fredoka text-[28px] font-semibold tracking-tight text-gray-900 md:text-[32px]">
                    Personal Info
                </h1>
            </header>

            <div className="scrollbar-hide flex flex-1 flex-col gap-5 overflow-y-auto pb-[max(2rem,env(safe-area-inset-bottom))]">
                <div className="flex flex-col items-center gap-3 pt-2">
                    <AccountAvatar src={currentUser.avatar_url} className="h-24 w-24" />
                    <button
                        type="button"
                        onClick={copyId}
                        className="flex items-center gap-1.5 rounded-full px-3 py-1 text-sm text-gray-600 transition-colors hover:bg-white/60"
                    >
                        Account ID: <span className="font-mono">{shortId}</span>
                        {copied ? (
                            <Check className="h-4 w-4 text-[#4C74F6]" />
                        ) : (
                            <Copy className="h-4 w-4 text-gray-400" />
                        )}
                        <span className="sr-only">{copied ? "Copied" : "Copy account ID"}</span>
                    </button>
                </div>

                <div className={cn(cardClass, "overflow-hidden")}>
                    <Link href="/home/account/password" className={cn(rowClass, "hover:bg-gray-50")}>
                        Change password
                        <ChevronRight className="h-5 w-5 shrink-0 text-gray-400" />
                    </Link>
                    <div className={rowClass}>
                        Email
                        <span className="min-w-0 truncate text-sm text-gray-500">
                            {currentUser.email}
                        </span>
                    </div>
                </div>

                <form action={signOutAction}>
                    <button
                        type="submit"
                        className="w-full rounded-full border border-gray-300 bg-white/90 py-3.5 text-base font-medium text-gray-900 transition-transform hover:bg-white active:scale-[0.99]"
                    >
                        Log out
                    </button>
                </form>
            </div>
        </div>
    );
}

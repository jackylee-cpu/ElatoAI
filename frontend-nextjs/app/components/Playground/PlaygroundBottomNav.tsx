"use client";

import Link from "next/link";
import { CharactersIcon, MeIcon } from "./icons";
import { cn } from "@/lib/utils";

export function PlaygroundBottomNav({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <nav
            className={cn(
                "fixed inset-x-0 bottom-0 z-40",
                "md:inset-x-auto md:bottom-6 md:left-1/2 md:w-[min(420px,92vw)] md:-translate-x-1/2"
            )}
        >
            {/* Three equal cells: Characters, the talk button, Me. The button
                sits in its cell but is lifted above the bar. Setting is reached
                from Me. */}
            <div
                className={cn(
                    "relative mx-auto grid min-h-[72px] grid-cols-3 items-end bg-white/95 px-2 pb-3 pt-2 shadow-[0_-8px_30px_rgba(80,120,180,0.12)] backdrop-blur-md",
                    "rounded-t-[28px] md:rounded-full md:px-6 md:shadow-[0_12px_40px_rgba(80,120,180,0.18)]"
                )}
                style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
            >
                <NavItem
                    href="/home"
                    label="Characters"
                    icon={CharactersIcon}
                    active
                />
                <div className="relative -mt-2 self-stretch">
                    <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-[42%]">
                        {children}
                    </div>
                </div>
                <NavItem
                    href="/home/account"
                    label="Me"
                    icon={MeIcon}
                />
            </div>
        </nav>
    );
}

function NavItem({
    href,
    label,
    icon: Icon,
    active = false,
}: {
    href: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    active?: boolean;
}) {
    return (
        <Link
            href={href}
            className="flex min-w-0 flex-col items-center gap-1"
        >
            <Icon className="h-7 w-7" />
            <span
                className={cn(
                    "text-[11px] leading-none",
                    active ? "font-semibold text-[#F25C5C]" : "font-medium text-gray-400"
                )}
            >
                {label}
            </span>
        </Link>
    );
}

"use client";

import Link from "next/link";
import { CharactersIcon, SettingsIcon } from "./icons";
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
            <div
                className={cn(
                    "relative mx-auto flex min-h-[72px] items-end justify-between bg-white/95 px-10 pb-3 pt-2 shadow-[0_-8px_30px_rgba(80,120,180,0.12)] backdrop-blur-md",
                    "rounded-t-[28px] md:rounded-full md:px-12 md:shadow-[0_12px_40px_rgba(80,120,180,0.18)]"
                )}
                style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
            >
                <NavItem
                    href="/home"
                    label="Characters"
                    icon={CharactersIcon}
                    active
                />
                <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-[42%]">
                    {children}
                </div>
                <NavItem
                    href="/home/settings"
                    label="Setting"
                    icon={SettingsIcon}
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
            className="flex min-w-[72px] flex-col items-center gap-1"
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

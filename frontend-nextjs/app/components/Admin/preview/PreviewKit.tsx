import React from "react";
import { cn } from "@/lib/utils";

// Small pieces shared by the preview pages. Once a page is built for real it
// should move to the app's own components; these exist so the previews look
// like the console they will become.

export function PreviewBanner() {
    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-amber-50 px-4 py-2.5 text-sm text-amber-900 ring-1 ring-amber-200">
            <span className="font-semibold">Preview</span>
            <span>
                Every number, toy and account on this page is an example. Nothing here
                is connected yet, and the buttons do nothing.
            </span>
        </div>
    );
}

export function Panel({
    title,
    hint,
    action,
    className,
    children,
}: {
    title?: React.ReactNode;
    hint?: React.ReactNode;
    action?: React.ReactNode;
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <section
            className={cn(
                "min-w-0 rounded-[24px] bg-white/90 p-4 shadow-[0_8px_24px_rgba(80,120,180,0.08)] backdrop-blur-sm md:p-5",
                className
            )}
        >
            {title && (
                <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h3 className="text-[15px] font-semibold text-gray-900">{title}</h3>
                    {hint && <span className="text-xs text-gray-500">{hint}</span>}
                    {action && <div className="ml-auto">{action}</div>}
                </div>
            )}
            {children}
        </section>
    );
}

export type Tone = "ok" | "info" | "warn" | "bad" | "idle";

const PILL_TONES: Record<Tone, string> = {
    ok: "bg-emerald-50 text-emerald-700",
    info: "bg-sky-50 text-sky-700",
    warn: "bg-amber-50 text-amber-700",
    bad: "bg-rose-50 text-rose-700",
    idle: "bg-gray-100 text-gray-500",
};

const DOT_TONES: Record<Tone, string> = {
    ok: "bg-emerald-500",
    info: "bg-sky-500",
    warn: "bg-amber-500",
    bad: "bg-rose-500",
    idle: "bg-gray-400",
};

export function Pill({
    tone = "idle",
    dot = true,
    children,
}: {
    tone?: Tone;
    dot?: boolean;
    children: React.ReactNode;
}) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
                PILL_TONES[tone]
            )}
        >
            {dot && <span className={cn("h-1.5 w-1.5 rounded-full", DOT_TONES[tone])} />}
            {children}
        </span>
    );
}

const KPI_TONES: Record<Tone, string> = {
    ok: "border-emerald-500",
    info: "border-[#2a78cf]",
    warn: "border-amber-500",
    bad: "border-rose-500",
    idle: "border-gray-300",
};

export function Kpi({
    value,
    unit,
    label,
    tone = "info",
}: {
    value: React.ReactNode;
    unit?: React.ReactNode;
    label: React.ReactNode;
    tone?: Tone;
}) {
    return (
        <div
            className={cn(
                "rounded-2xl border-t-4 bg-white/90 px-4 py-3 shadow-[0_8px_24px_rgba(80,120,180,0.08)]",
                KPI_TONES[tone]
            )}
        >
            <div className="font-fredoka text-2xl font-semibold tabular-nums text-gray-900 md:text-[28px]">
                {value}
                {unit && <span className="ml-1 text-sm font-medium text-gray-500">{unit}</span>}
            </div>
            <div className="text-xs text-gray-500 md:text-[13px]">{label}</div>
        </div>
    );
}

export function KpiRow({ children }: { children: React.ReactNode }) {
    return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

export function TwoColumns({ children }: { children: React.ReactNode }) {
    return (
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            {children}
        </div>
    );
}

export function Facts({ rows }: { rows: [React.ReactNode, React.ReactNode][] }) {
    return (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
            {rows.map(([term, value], index) => (
                <React.Fragment key={index}>
                    <dt className="text-gray-500">{term}</dt>
                    <dd className="min-w-0 break-words text-gray-900">{value}</dd>
                </React.Fragment>
            ))}
        </dl>
    );
}

export function Events({ rows }: { rows: [string, string][] }) {
    return (
        <div className="text-[13px]">
            {rows.map(([when, what], index) => (
                <div
                    key={index}
                    className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 border-b border-dashed border-gray-200 py-1.5 last:border-0"
                >
                    <time className="tabular-nums text-gray-500">{when}</time>
                    <span className="text-gray-800">{what}</span>
                </div>
            ))}
        </div>
    );
}

export function Note({ children }: { children: React.ReactNode }) {
    return (
        <p className="rounded-xl bg-sky-50/70 px-3 py-2 text-xs leading-relaxed text-gray-600">
            {children}
        </p>
    );
}

export function Divider() {
    return <div className="my-3 h-px bg-gray-100" />;
}

/** A button that shows what will be there. Previews do not act. */
export function FakeButton({
    children,
    variant = "default",
}: {
    children: React.ReactNode;
    variant?: "default" | "primary" | "danger";
}) {
    return (
        <button
            type="button"
            disabled
            title="Not built yet"
            className={cn(
                "cursor-not-allowed whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[13px] font-medium",
                variant === "primary" && "border-[#2a78cf] bg-[#2a78cf] text-white opacity-60",
                variant === "danger" && "border-rose-200 bg-white text-rose-600 opacity-70",
                variant === "default" && "border-gray-200 bg-white text-gray-700 opacity-70"
            )}
        >
            {children}
        </button>
    );
}

export function SimpleTable({
    head,
    children,
}: {
    head: { label: string; align?: "right" }[];
    children: React.ReactNode;
}) {
    return (
        <div className="-mx-1 overflow-x-auto">
            <table className="w-full border-collapse text-[13px] tabular-nums">
                <thead>
                    <tr>
                        {head.map((cell, index) => (
                            <th
                                key={index}
                                className={cn(
                                    "whitespace-nowrap border-b border-gray-100 px-2 py-1.5 text-left text-xs font-medium text-gray-500",
                                    cell.align === "right" && "text-right"
                                )}
                            >
                                {cell.label}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody className="[&_td]:whitespace-nowrap [&_td]:border-b [&_td]:border-gray-100 [&_td]:px-2 [&_td]:py-2 [&_tr:last-child_td]:border-0">
                    {children}
                </tbody>
            </table>
        </div>
    );
}

export function Meter({ parts }: { parts: { percent: number; className: string }[] }) {
    return (
        <div className="flex h-2.5 overflow-hidden rounded-full bg-gray-100" aria-hidden="true">
            {parts.map((part, index) => (
                <span
                    key={index}
                    className={cn("block h-full", part.className)}
                    style={{ width: `${part.percent}%` }}
                />
            ))}
        </div>
    );
}

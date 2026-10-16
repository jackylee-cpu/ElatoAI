import React from "react";
import {
    Breakdown,
    DayStats,
    LATENCY_BUDGETS,
    LatencyTone,
    formatMs,
    histogram,
} from "@/lib/latency";
import { cn } from "@/lib/utils";

// The four spans a turn's total is made of, in the order they happen. Turn
// close is dead time -- the transcript-merge timer -- so it is grey and
// hatched rather than a fourth hue competing with the three services.
export const PARTS: { key: keyof Breakdown; label: string; color: string; fill: string }[] = [
    { key: "stt", label: "STT", color: "#1baf7a", fill: "#1baf7a" },
    {
        key: "close",
        label: "Turn close",
        color: "#9aa5b1",
        fill: "repeating-linear-gradient(135deg, #9aa5b1 0 3px, #c4cbd3 3px 6px)",
    },
    { key: "llm", label: "LLM", color: "#2a78d6", fill: "#2a78d6" },
    { key: "tts", label: "TTS", color: "#eb6834", fill: "#eb6834" },
];

export const TONE_LABEL: Record<LatencyTone, string> = {
    ok: "On target",
    warn: "Slow",
    bad: "Too slow",
};

// Status colours, kept apart from the stage hues above so "too slow" never
// reads as "LLM". Every use sits next to a label or a pill saying the same.
const TONE_FILL: Record<LatencyTone, string> = {
    ok: "#34d399",
    warn: "#fbbf24",
    bad: "#f43f5e",
};

export const TONE_TEXT: Record<LatencyTone, string> = {
    ok: "text-gray-900",
    warn: "text-amber-600",
    bad: "text-rose-600",
};

const GRID = "#e8eff6";
const LABEL = "#6b7280";

export function sumParts(parts: Breakdown): number {
    return parts.stt + parts.close + parts.llm + parts.tts;
}

/**
 * A turn as one horizontal bar, each span its own segment. `scale` is the
 * millisecond value at full width, shared by every bar it is compared with;
 * a turn longer than that fills the bar and gets an arrow at the end.
 */
export function BreakdownBar({
    parts,
    scale,
    className,
}: {
    parts: Breakdown;
    scale: number;
    className?: string;
}) {
    const total = sumParts(parts);
    const fit = Math.min(1, scale / Math.max(total, 1));
    const title = PARTS.map((part) => `${part.label} ${formatMs(parts[part.key])}`).join(" · ");

    return (
        <div className={cn("flex h-2.5 items-center", className)} title={`${title} = ${formatMs(total)}`}>
            <div className="flex h-full min-w-0 flex-1 gap-[2px] overflow-hidden rounded-full">
                {PARTS.map((part) =>
                    parts[part.key] > 0 ? (
                        <span
                            key={part.key}
                            className="block h-full shrink-0"
                            style={{
                                width: `${((parts[part.key] * fit) / scale) * 100}%`,
                                background: part.fill,
                            }}
                        />
                    ) : null
                )}
            </div>
            {total > scale && (
                <span className="ml-0.5 text-[10px] font-bold leading-none text-rose-500" aria-label="off the scale">
                    ›
                </span>
            )}
        </div>
    );
}

export function PartLegend({ parts }: { parts?: Breakdown }) {
    return (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
            {PARTS.map((part) => (
                <span key={part.key} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: part.fill }} />
                    {part.label}
                    {parts && <span className="font-medium tabular-nums text-gray-900">{formatMs(parts[part.key])}</span>}
                </span>
            ))}
        </div>
    );
}

/** How many turns took how long, coloured by which side of the budget they fall. */
export function TotalHistogram({ values }: { values: number[] }) {
    const STEP = 500;
    const budget = LATENCY_BUDGETS.total_ms;
    const max = Math.max(6000, Math.ceil(budget.slow * 2 / STEP) * STEP);
    const buckets = histogram(values, STEP, max);
    const W = 420, H = 220, L = 30, R = 8, T = 20, B = 24;
    const innerW = W - L - R, innerH = H - T - B;
    const band = innerW / buckets.length;
    const peak = Math.max(...buckets.map((bucket) => bucket.count), 1);
    const top = niceCeiling(peak);
    const y = (count: number) => T + innerH - (count / top) * innerH;
    const xAt = (ms: number) => L + (ms / STEP) * band;
    const tone = (from: number): LatencyTone =>
        from + STEP <= budget.good ? "ok" : from + STEP <= budget.slow ? "warn" : "bad";

    return (
        <svg viewBox={`0 0 ${W} ${H}`} className="max-h-[240px] w-full" role="img" aria-label="Turns by total latency">
            {(top >= 2 ? [0, top / 2, top] : [0, top]).map((tick) => (
                <g key={tick}>
                    <line x1={L} x2={W - R} y1={y(tick)} y2={y(tick)} stroke={GRID} />
                    <text x={L - 6} y={y(tick) + 4} textAnchor="end" fontSize={12} fill={LABEL}>
                        {Math.round(tick)}
                    </text>
                </g>
            ))}
            {buckets.map((bucket, i) => {
                const last = i === buckets.length - 1;
                const range = last ? `${formatMs(bucket.from)} or more` : `${formatMs(bucket.from)}–${formatMs(bucket.from + STEP)}`;
                const height = T + innerH - y(bucket.count);
                return (
                    <g key={bucket.from}>
                        <title>{`${range}: ${bucket.count} turn${bucket.count === 1 ? "" : "s"}`}</title>
                        {/* The whole band is the hover target, not just the bar. */}
                        <rect x={xAt(bucket.from)} y={T} width={band} height={innerH} fill="transparent" />
                        {bucket.count > 0 && (
                            <path
                                d={roundedTop(xAt(bucket.from) + 1, y(bucket.count), band - 2, height, Math.min(4, height))}
                                fill={TONE_FILL[tone(bucket.from)]}
                            />
                        )}
                    </g>
                );
            })}
            {[budget.good, budget.slow].map((ms) => (
                <g key={ms}>
                    <line x1={xAt(ms)} x2={xAt(ms)} y1={T - 18} y2={T + innerH} stroke="#374151" strokeWidth={1} />
                    {/* Target to the left of its line, too slow to the right, so they never meet. */}
                    <text
                        x={ms === budget.good ? xAt(ms) - 4 : xAt(ms) + 4}
                        y={T - 8}
                        textAnchor={ms === budget.good ? "end" : "start"}
                        fontSize={12}
                        fill="#374151"
                    >
                        {ms === budget.good ? `target ${formatMs(ms)}` : `too slow ${formatMs(ms)}`}
                    </text>
                </g>
            ))}
            {buckets.map((bucket, i) =>
                bucket.from % 1000 === 0 ? (
                    <text key={bucket.from} x={xAt(bucket.from)} y={H - 8} textAnchor="middle" fontSize={12} fill={LABEL}>
                        {i === buckets.length - 1 ? `${bucket.from / 1000}s+` : `${bucket.from / 1000}s`}
                    </text>
                ) : null
            )}
        </svg>
    );
}

/** Median total per day as a dot, the p95 as a whisker above it. */
export function DailyTrend({ days }: { days: DayStats[] }) {
    const budget = LATENCY_BUDGETS.total_ms;
    const W = 420, H = 220, L = 34, R = 8, T = 16, B = 24;
    const innerW = W - L - R, innerH = H - T - B;
    const band = innerW / Math.max(days.length, 1);
    const top = niceCeiling(Math.max(...days.map((day) => day.p95), budget.slow) / 1000) * 1000;
    const ticks = [0, top / 4, top / 2, (3 * top) / 4, top];
    const y = (ms: number) => T + innerH - (ms / top) * innerH;
    const x = (i: number) => L + band * i + band / 2;
    const labelEvery = Math.ceil(days.length / 7);

    return (
        <svg viewBox={`0 0 ${W} ${H}`} className="max-h-[240px] w-full" role="img" aria-label="Total latency per day">
            {ticks.map((tick) => (
                <g key={tick}>
                    <line x1={L} x2={W - R} y1={y(tick)} y2={y(tick)} stroke={GRID} />
                    <text x={L - 6} y={y(tick) + 4} textAnchor="end" fontSize={12} fill={LABEL}>
                        {`${+(tick / 1000).toFixed(1)}s`}
                    </text>
                </g>
            ))}
            <line x1={L} x2={W - R} y1={y(budget.good)} y2={y(budget.good)} stroke={TONE_FILL.ok} strokeWidth={1.5} />
            <text x={W - R} y={y(budget.good) - 4} textAnchor="end" fontSize={12} fill="#047857">
                target {formatMs(budget.good)}
            </text>
            {days.map((day, i) => (
                <g key={day.day}>
                    <title>{`${day.day}: median ${formatMs(day.p50)}, p95 ${formatMs(day.p95)}, ${day.count} turn${day.count === 1 ? "" : "s"}`}</title>
                    <rect x={x(i) - band / 2} y={T} width={band} height={innerH} fill="transparent" />
                    <line x1={x(i)} x2={x(i)} y1={y(day.p50)} y2={y(day.p95)} stroke="#9ec5f4" strokeWidth={2} strokeLinecap="round" />
                    <line x1={x(i) - 5} x2={x(i) + 5} y1={y(day.p95)} y2={y(day.p95)} stroke="#9ec5f4" strokeWidth={2} strokeLinecap="round" />
                    <circle cx={x(i)} cy={y(day.p50)} r={5} fill="#2a78d6" stroke="#ffffff" strokeWidth={2} />
                </g>
            ))}
            {days.map((day, i) =>
                (days.length - 1 - i) % labelEvery === 0 ? (
                    <text key={day.day} x={x(i)} y={H - 8} textAnchor="middle" fontSize={12} fill={LABEL}>
                        {day.day.slice(5).replace("-", "/")}
                    </text>
                ) : null
            )}
        </svg>
    );
}

export function TrendLegend() {
    return (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
            <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#2a78d6]" />
                Median
            </span>
            <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-0.5 rounded-full bg-[#9ec5f4]" />
                Median → p95
            </span>
        </div>
    );
}

export function ToneLegend() {
    const budget = LATENCY_BUDGETS.total_ms;
    const items: [LatencyTone, string][] = [
        ["ok", `On target, ≤ ${formatMs(budget.good)}`],
        ["warn", `Slow, ≤ ${formatMs(budget.slow)}`],
        ["bad", `Too slow, > ${formatMs(budget.slow)}`],
    ];
    return (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
            {items.map(([tone, label]) => (
                <span key={tone} className="inline-flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: TONE_FILL[tone] }} />
                    {label}
                </span>
            ))}
        </div>
    );
}

/** A bar path with rounded top corners and a square foot on the baseline. */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
    return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

/** A round number at or above `value` that divides into four clean ticks. */
function niceCeiling(value: number): number {
    if (value <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    for (const step of [1, 2, 4, 6, 8, 10]) {
        if (step * magnitude >= value) return step * magnitude;
    }
    return 10 * magnitude;
}

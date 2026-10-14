import React from "react";
import { PREVIEW_ACTIVE, PREVIEW_DAYS, PREVIEW_TURNS } from "./previewData";

const ACCENT = "#2a78cf";
const ACCENT_SOFT = "#d6e7f8";
const GRID = "#e8eff6";
const LABEL = "#6b7280";

function Legend({ items }: { items: { label: string; color: string }[] }) {
    return (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
            {items.map((item) => (
                <span key={item.label} className="inline-flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: item.color }} />
                    {item.label}
                </span>
            ))}
        </div>
    );
}

/** Turns as bars on the left axis, active toys as a line on the right. */
export function ActivityChart() {
    const W = 640, H = 220, L = 34, R = 34, T = 14, B = 26;
    const innerW = W - L - R, innerH = H - T - B;
    const band = innerW / PREVIEW_DAYS.length;
    const turnsMax = 450, activeMax = 25;
    const x = (i: number) => L + band * i + band / 2;
    const yTurns = (v: number) => T + innerH - (v / turnsMax) * innerH;
    const yActive = (v: number) => T + innerH - (v / activeMax) * innerH;
    const last = PREVIEW_DAYS.length - 1;

    return (
        <>
            <svg viewBox={`0 0 ${W} ${H}`} className="max-h-[280px] w-full" role="img" aria-label="Active toys and turns, last 14 days">
                {[0, 150, 300, 450].map((v) => (
                    <g key={v}>
                        <line x1={L} x2={W - R} y1={yTurns(v)} y2={yTurns(v)} stroke={GRID} />
                        <text x={L - 6} y={yTurns(v) + 4} textAnchor="end" fontSize={11} fill={LABEL}>{v}</text>
                    </g>
                ))}
                {[0, 10, 20].map((v) => (
                    <text key={v} x={W - R + 6} y={yActive(v) + 4} fontSize={11} fill={LABEL}>{v}</text>
                ))}
                {PREVIEW_TURNS.map((v, i) => (
                    <rect key={i} x={x(i) - band * 0.32} y={yTurns(v)} width={band * 0.64} height={T + innerH - yTurns(v)} rx={3} fill={ACCENT_SOFT} />
                ))}
                <polyline
                    points={PREVIEW_ACTIVE.map((v, i) => `${x(i)},${yActive(v)}`).join(" ")}
                    fill="none"
                    stroke={ACCENT}
                    strokeWidth={2.2}
                    strokeLinejoin="round"
                />
                <circle cx={x(last)} cy={yActive(PREVIEW_ACTIVE[last])} r={4} fill={ACCENT} />
                <text x={x(last) - 6} y={yActive(PREVIEW_ACTIVE[last]) - 9} textAnchor="end" fontSize={11} fontWeight={500} fill={ACCENT}>
                    {PREVIEW_ACTIVE[last]} toys
                </text>
                {PREVIEW_DAYS.map((day, i) =>
                    i % 2 === 1 || i === last ? (
                        <text key={day} x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill={LABEL}>{day}</text>
                    ) : null
                )}
            </svg>
            <Legend
                items={[
                    { label: "Turns (left)", color: ACCENT_SOFT },
                    { label: "Active toys (right)", color: ACCENT },
                ]}
            />
        </>
    );
}

"use client";

import React, { useMemo, useRef, useState } from "react";
import { Info } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import {
    LATENCY_BUDGETS,
    LATENCY_STAGES,
    LatencyStage,
    StageStats,
    breakdownOf,
    compareByModel,
    formatMs,
    isGreeting,
    statsForStage,
    toneFor,
    totalsByDay,
    typicalBreakdown,
} from "@/lib/latency";
import { cn } from "@/lib/utils";
import { Pill } from "./preview/PreviewKit";
import {
    BreakdownBar,
    DailyTrend,
    PARTS,
    PartLegend,
    TONE_LABEL,
    TONE_TEXT,
    ToneLegend,
    TotalHistogram,
    TrendLegend,
    sumParts,
} from "./LatencyCharts";

const ALL = "__all__";
const PAGE = 100;

// The swatch beside each stage card, matching its segment in the bars.
const STAGE_FILL: Record<LatencyStage, string> = {
    stt_ms: PARTS[0].fill,
    turn_close_ms: PARTS[1].fill,
    llm_ttfb_ms: PARTS[2].fill,
    tts_ttfb_ms: PARTS[3].fill,
    total_ms: "#374151",
};

const cardClass = "rounded-2xl border-0 bg-white/80 shadow-sm";

interface LatencyTabProps {
    rows: ITurnMetric[];
}

const LatencyTab: React.FC<LatencyTabProps> = ({ rows }) => {
    const [model, setModel] = useState(ALL);
    const [transport, setTransport] = useState(ALL);

    const models = useMemo(
        () => unique(rows.map((row) => row.llm_model)),
        [rows],
    );
    const transports = useMemo(
        () => unique(rows.map((row) => row.transport)),
        [rows],
    );

    const filtered = useMemo(
        () =>
            rows.filter(
                (row) =>
                    (model === ALL || row.llm_model === model) &&
                    (transport === ALL || row.transport === transport),
            ),
        [rows, model, transport],
    );

    const comparison = useMemo(() => compareByModel(rows), [rows]);

    if (rows.length === 0) {
        return (
            <Card className={cardClass}>
                <CardHeader>
                    <CardTitle className="text-lg">No turns yet</CardTitle>
                    <CardDescription>Talk to the toy or the web player, then reload.</CardDescription>
                </CardHeader>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-row flex-wrap gap-2">
                <Select value={model} onValueChange={setModel}>
                    <SelectTrigger className="w-full sm:w-[240px]">
                        <SelectValue placeholder="All models" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={ALL}>All models</SelectItem>
                        {models.map((entry) => (
                            <SelectItem key={entry} value={entry}>
                                {entry}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>

                <Select value={transport} onValueChange={setTransport}>
                    <SelectTrigger className="w-[160px]">
                        <SelectValue placeholder="All devices" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={ALL}>All devices</SelectItem>
                        {transports.map((entry) => (
                            <SelectItem key={entry} value={entry}>
                                {entry}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>

                <Badge variant="outline" className="self-center">
                    {filtered.length} turns
                </Badge>
            </div>

            <Summary rows={filtered} />

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                {LATENCY_STAGES.map((stage) => (
                    <StageCard
                        key={stage.key}
                        stage={stage}
                        stats={statsForStage(filtered, stage.key)}
                    />
                ))}
            </div>

            <Charts rows={filtered} />

            <ModelCard comparison={comparison} rows={rows} />

            <RecentTurns rows={filtered} />
        </div>
    );
};

/** The answer to "is it fine": the median wait, how it splits, how often it goes wrong. */
function Summary({ rows }: { rows: ITurnMetric[] }) {
    const total = statsForStage(rows, "total_ms");
    const typical = typicalBreakdown(rows);
    const budget = LATENCY_BUDGETS.total_ms;
    const totals = rows.flatMap((row) => (row.total_ms === null ? [] : [row.total_ms]));
    const over = totals.filter((value) => value > budget.slow).length;
    const tone = toneFor("total_ms", total.p50);

    if (tone === null) {
        return (
            <Card className={cardClass}>
                <CardHeader>
                    <TitleWithHint title="No complete turns" label="Why there are no complete turns">
                        None of these {rows.length} turns reached first audio after
                        the child spoke: they are greetings, or were cut off first.
                        The stage cards still count what was measured.
                    </TitleWithHint>
                </CardHeader>
            </Card>
        );
    }

    const typicalSum = typical ? sumParts(typical.parts) : 0;
    const scale = Math.max(typicalSum, budget.slow) * 1.15;

    return (
        <Card className={cardClass}>
            <CardContent className="grid gap-6 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] md:p-6">
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
                        Median total
                        <InfoHint label="What the median total measures">
                            Commit reaching the server → first audio out, over{" "}
                            {total.count} complete turns. Target ≤ {formatMs(budget.good)}.
                            Server time only: the network and the toy&apos;s buffer
                            come on top.
                        </InfoHint>
                    </div>
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className="font-fredoka text-5xl font-semibold tabular-nums text-gray-900">
                            {formatMs(total.p50)}
                        </span>
                        <Pill tone={tone}>{TONE_LABEL[tone]}</Pill>
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-3 text-sm">
                        <div>
                            <div className="font-semibold tabular-nums text-gray-900">
                                {formatMs(total.p95)}
                            </div>
                            <div className="text-xs text-gray-500">p95</div>
                        </div>
                        <div>
                            <div
                                className={cn(
                                    "font-semibold tabular-nums",
                                    over > 0 ? "text-rose-600" : "text-gray-900",
                                )}
                            >
                                {over} · {Math.round((over / totals.length) * 100)}%
                            </div>
                            <div className="text-xs text-gray-500">
                                over {formatMs(budget.slow)}
                            </div>
                        </div>
                    </div>
                </div>

                <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
                        Breakdown
                        {typical && (
                            <InfoHint label="How the breakdown is worked out">
                                Median of each stage over the {typical.count} turns that
                                have all of them. They add up to {formatMs(typicalSum)},
                                not the median total: medians do not add.
                            </InfoHint>
                        )}
                    </div>
                    {typical ? (
                        <>
                            <div className="relative pb-5 pt-5">
                                <BreakdownBar parts={typical.parts} scale={scale} className="h-6" />
                                {[budget.good, budget.slow].map((ms) => (
                                    <div
                                        key={ms}
                                        className="absolute bottom-0 top-0 border-l border-gray-700"
                                        style={{ left: `${(ms / scale) * 100}%` }}
                                    >
                                        {/* Target above the bar, too slow below it: the two
                                            lines can sit close enough for labels to collide. */}
                                        <span
                                            className={cn(
                                                "absolute right-1 whitespace-nowrap text-[11px] leading-4 text-gray-700",
                                                ms === budget.good ? "top-0" : "bottom-0",
                                            )}
                                        >
                                            {ms === budget.good ? "target" : "too slow"} {formatMs(ms)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                            <PartLegend parts={typical.parts} />
                        </>
                    ) : (
                        <p className="text-sm text-muted-foreground">No turn with every stage</p>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}

function StageCard({
    stage,
    stats,
}: {
    stage: (typeof LATENCY_STAGES)[number];
    stats: StageStats;
}) {
    const tone = toneFor(stage.key, stats.p50);
    const budget = LATENCY_BUDGETS[stage.key];
    const scale = Math.max(budget.slow * 1.5, (stats.p95 ?? 0) * 1.1);
    const pct = (value: number | null) => `${Math.min(((value ?? 0) / scale) * 100, 100)}%`;

    return (
        <div className="flex flex-col gap-2 rounded-2xl bg-white/80 px-4 py-3 shadow-sm">
            <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: STAGE_FILL[stage.key] }} />
                <span className="text-sm font-medium text-gray-900">{stage.label}</span>
                <InfoHint label={`What ${stage.label} measures`}>
                    {stage.hint}. Target ≤ {formatMs(budget.good)}.
                </InfoHint>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-2xl font-semibold tabular-nums text-gray-900">
                    {formatMs(stats.p50)}
                </span>
                {tone && <Pill tone={tone}>{TONE_LABEL[tone]}</Pill>}
            </div>
            {/* Median solid, up to p95 faint, the target as a tick. */}
            <div className="relative h-2 rounded-full bg-gray-100" aria-hidden="true">
                <span
                    className="absolute inset-y-0 left-0 rounded-full opacity-30"
                    style={{ width: pct(stats.p95), background: STAGE_FILL[stage.key] }}
                />
                <span
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{ width: pct(stats.p50), background: STAGE_FILL[stage.key] }}
                />
                <span
                    className="absolute -inset-y-1 w-0.5 rounded-full bg-gray-700"
                    style={{ left: pct(budget.good) }}
                />
            </div>
            <div className="text-xs text-muted-foreground">
                p95 {formatMs(stats.p95)} · n={stats.count}
            </div>
        </div>
    );
}

/**
 * An explanation behind an "i", so the page shows numbers rather than prose.
 * Hover opens it with a mouse; a tap opens it on a phone, where there is no
 * hover.
 */
function InfoHint({ label, children }: { label: string; children: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    // A click while the mouse is over the icon would otherwise close what
    // hovering just opened.
    const hovering = useRef(false);

    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                if (!next && hovering.current) return;
                setOpen(next);
            }}
        >
            <PopoverTrigger
                aria-label={label}
                className="-m-1 rounded-full p-1 text-gray-400 transition-colors hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                onPointerEnter={(event) => {
                    if (event.pointerType !== "mouse") return;
                    hovering.current = true;
                    setOpen(true);
                }}
                onPointerLeave={(event) => {
                    if (event.pointerType !== "mouse") return;
                    hovering.current = false;
                    setOpen(false);
                }}
            >
                <Info className="h-3.5 w-3.5" />
            </PopoverTrigger>
            <PopoverContent
                side="top"
                collisionPadding={16}
                className="w-auto max-w-[260px] rounded-xl border-gray-100 bg-white px-3 py-2 text-xs font-normal leading-relaxed text-gray-700 shadow-md"
                onOpenAutoFocus={(event) => event.preventDefault()}
            >
                {children}
            </PopoverContent>
        </Popover>
    );
}

function TitleWithHint({
    title,
    label,
    children,
}: {
    title: string;
    label: string;
    children: React.ReactNode;
}) {
    return (
        <CardTitle className="flex items-center gap-1.5 text-base">
            {title}
            <InfoHint label={label}>{children}</InfoHint>
        </CardTitle>
    );
}

function Charts({ rows }: { rows: ITurnMetric[] }) {
    const totals = rows.flatMap((row) => (row.total_ms === null ? [] : [row.total_ms]));
    const days = totalsByDay(rows);
    if (totals.length === 0) return null;

    return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className={cardClass}>
                <CardHeader className="pb-2">
                    <TitleWithHint title="Distribution" label="About the distribution">
                        Total of {totals.length} complete turns, in half-second steps.
                        Hover a bar for its count.
                    </TitleWithHint>
                </CardHeader>
                <CardContent>
                    <TotalHistogram values={totals} />
                    <ToneLegend />
                </CardContent>
            </Card>
            <Card className={cardClass}>
                <CardHeader className="pb-2">
                    <TitleWithHint title="By day" label="About the daily chart">
                        Total per day with turns, Hong Kong time. Hover a day for
                        its numbers.
                    </TitleWithHint>
                </CardHeader>
                <CardContent>
                    <DailyTrend days={days.slice(-14)} />
                    <TrendLegend />
                </CardContent>
            </Card>
        </div>
    );
}

function ModelCard({
    comparison,
    rows,
}: {
    comparison: ReturnType<typeof compareByModel>;
    rows: ITurnMetric[];
}) {
    const typicals = useMemo(() => {
        const byModel = new Map<string, ITurnMetric[]>();
        for (const row of rows) {
            const key = row.llm_model ?? "(server default)";
            byModel.set(key, [...(byModel.get(key) ?? []), row]);
        }
        return new Map([...byModel].map(([key, group]) => [key, typicalBreakdown(group)]));
    }, [rows]);
    const scale = Math.max(
        LATENCY_BUDGETS.total_ms.slow,
        ...[...typicals.values()].map((entry) => (entry ? sumParts(entry.parts) : 0)),
    ) * 1.05;

    return (
        <Card className={cardClass}>
            <CardHeader>
                <TitleWithHint title="By model" label="About the model comparison">
                    Median (p95) across every recorded turn, slowest first.
                    Ignores the filters above so two models stay comparable.
                </TitleWithHint>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
                {comparison.map((entry) => {
                    const typical = typicals.get(entry.model);
                    const tone = toneFor("total_ms", entry.stages.total_ms.p50);
                    return (
                        <div key={entry.model} className="flex flex-col gap-2 rounded-xl px-3 py-3 ring-1 ring-gray-100">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="min-w-0 break-all text-sm font-medium text-gray-900">
                                    {entry.model}
                                </span>
                                <span className="text-xs text-gray-500">{entry.turns} turns</span>
                                {tone ? (
                                    <span className="ml-auto">
                                        <Pill tone={tone}>{TONE_LABEL[tone]}</Pill>
                                    </span>
                                ) : (
                                    <span className="ml-auto">
                                        <Pill>No complete turns</Pill>
                                    </span>
                                )}
                            </div>
                            {typical && <BreakdownBar parts={typical.parts} scale={scale} />}
                            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-5">
                                {LATENCY_STAGES.map((stage) => {
                                    const stats = entry.stages[stage.key];
                                    return (
                                        <div key={stage.key} className="flex flex-col">
                                            <span className="text-gray-500">{stage.label}</span>
                                            <span className="whitespace-nowrap tabular-nums">
                                                <span
                                                    className={cn(
                                                        "font-medium",
                                                        TONE_TEXT[toneFor(stage.key, stats.p50) ?? "ok"],
                                                    )}
                                                >
                                                    {formatMs(stats.p50)}
                                                </span>
                                                <span className="text-muted-foreground"> ({formatMs(stats.p95)})</span>
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
                <PartLegend />
            </CardContent>
        </Card>
    );
}

function RecentTurns({ rows }: { rows: ITurnMetric[] }) {
    const [greetings, setGreetings] = useState(false);
    const [slowOnly, setSlowOnly] = useState(false);
    const [shown, setShown] = useState(PAGE);

    const greetingCount = useMemo(() => rows.filter(isGreeting).length, [rows]);
    const visible = useMemo(
        () =>
            rows.filter(
                (row) => (greetings || !isGreeting(row)) && (!slowOnly || isSlow(row)),
            ),
        [rows, greetings, slowOnly],
    );
    const slowCount = useMemo(
        () => rows.filter((row) => (greetings || !isGreeting(row)) && isSlow(row)).length,
        [rows, greetings],
    );
    // One scale for every bar in the list, so a long one looks long.
    const scale = Math.max(
        LATENCY_BUDGETS.total_ms.slow,
        statsForStage(rows, "total_ms").p95 ?? 0,
    );
    const page = visible.slice(0, shown);

    return (
        <Card className={cardClass}>
            <CardHeader className="flex flex-col gap-2 space-y-0 pb-3">
                <TitleWithHint title="Recent turns" label="About recent turns">
                    A dash means the turn ended before that stage finished,
                    usually the child talking over the toy. Turns over{" "}
                    {formatMs(LATENCY_BUDGETS.total_ms.slow)} are red. Greetings
                    are the toy speaking first, so only TTS is measured.
                </TitleWithHint>
                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        size="sm"
                        variant={slowOnly ? "default" : "outline"}
                        className="rounded-full"
                        onClick={() => setSlowOnly(!slowOnly)}
                    >
                        Slow only ({slowCount})
                    </Button>
                    <Button
                        size="sm"
                        variant={greetings ? "default" : "outline"}
                        className="rounded-full"
                        onClick={() => setGreetings(!greetings)}
                    >
                        Greetings ({greetingCount})
                    </Button>
                    <span className="text-xs text-muted-foreground">
                        {visible.length} of {rows.length}
                    </span>
                </div>
            </CardHeader>
            <CardContent>
                {page.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {slowOnly ? "No slow turns" : "Greetings only"}
                    </p>
                ) : (
                    <>
                        <div className="hidden xl:block">
                            <TurnTable rows={page} scale={scale} />
                        </div>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:hidden">
                            {page.map((row) => (
                                <TurnItem key={row.turn_metric_id} row={row} scale={scale} />
                            ))}
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-3">
                            <PartLegend />
                            {visible.length > shown && (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="ml-auto rounded-full"
                                    onClick={() => setShown(shown + PAGE)}
                                >
                                    Show {Math.min(PAGE, visible.length - shown)} more
                                </Button>
                            )}
                        </div>
                    </>
                )}
            </CardContent>
        </Card>
    );
}

function TurnTable({ rows, scale }: { rows: ITurnMetric[]; scale: number }) {
    return (
        <Table>
            <TableHeader>
                <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Model · character · device</TableHead>
                    <TableHead className="w-[120px]">Breakdown</TableHead>
                    <TableHead className="text-right">STT</TableHead>
                    <TableHead className="text-right">LLM</TableHead>
                    <TableHead className="text-right">TTS</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {rows.map((row) => {
                    const parts = breakdownOf(row);
                    return (
                        <TableRow
                            key={row.turn_metric_id}
                            className={cn(toneFor("total_ms", row.total_ms) === "bad" && "bg-rose-50/70 hover:bg-rose-50")}
                        >
                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                                <div>{new Date(row.created_at).toLocaleString()}</div>
                                <div className="-ml-2 empty:hidden"><TurnBadges row={row} /></div>
                            </TableCell>
                            <TableCell className="max-w-[240px] text-xs">
                                <div className="truncate" title={row.llm_model ?? undefined}>
                                    {row.llm_model ?? "—"}
                                </div>
                                <div className="truncate text-muted-foreground">
                                    {row.personality_key ?? "—"} · {row.transport ?? "—"}
                                </div>
                            </TableCell>
                            <TableCell>
                                {parts && <BreakdownBar parts={parts} scale={scale} />}
                            </TableCell>
                            <TableCell className="text-right tabular-nums whitespace-nowrap">
                                <StageValue row={row} stage="stt_ms" />
                                <AnchorBadge row={row} />
                            </TableCell>
                            <TableCell className="text-right tabular-nums whitespace-nowrap">
                                <StageValue row={row} stage="llm_ttfb_ms" />
                            </TableCell>
                            <TableCell className="text-right tabular-nums whitespace-nowrap">
                                <StageValue row={row} stage="tts_ttfb_ms" />
                            </TableCell>
                            <TableCell className="text-right tabular-nums whitespace-nowrap font-medium">
                                <StageValue row={row} stage="total_ms" />
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-xs text-muted-foreground whitespace-nowrap">
                                {row.prompt_tokens ?? "—"} / {row.completion_tokens ?? "—"}
                            </TableCell>
                        </TableRow>
                    );
                })}
            </TableBody>
        </Table>
    );
}

/** The same turn as a card, for widths where the table would not fit. */
function TurnItem({ row, scale }: { row: ITurnMetric; scale: number }) {
    const parts = breakdownOf(row);
    const bad = toneFor("total_ms", row.total_ms) === "bad";
    const stages: [string, LatencyStage][] = [
        ["STT", "stt_ms"],
        ["LLM", "llm_ttfb_ms"],
        ["TTS", "tts_ttfb_ms"],
    ];

    return (
        <div
            className={cn(
                "flex min-w-0 flex-col gap-1.5 rounded-xl px-3 py-2.5 ring-1",
                bad ? "bg-rose-50/70 ring-rose-100" : "ring-gray-100",
            )}
        >
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 text-xs text-muted-foreground">
                    {new Date(row.created_at).toLocaleString()}
                    <TurnBadges row={row} />
                </div>
                <div className="shrink-0 text-base font-semibold tabular-nums">
                    <StageValue row={row} stage="total_ms" />
                </div>
            </div>
            {parts && <BreakdownBar parts={parts} scale={scale} />}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums">
                {stages.map(([label, stage]) => (
                    <span key={stage} className="whitespace-nowrap">
                        <span className="text-gray-500">{label} </span>
                        <StageValue row={row} stage={stage} />
                        {stage === "stt_ms" && <AnchorBadge row={row} />}
                    </span>
                ))}
                <span className="whitespace-nowrap text-muted-foreground">
                    Tokens {row.prompt_tokens ?? "—"} / {row.completion_tokens ?? "—"}
                </span>
            </div>
            <div className="truncate text-xs text-gray-500">
                {row.llm_model ?? "—"} · {row.personality_key ?? "—"} · {row.transport ?? "—"}
            </div>
        </div>
    );
}

/**
 * A stage's value, red when it is too slow. Only red: most turns sit in the
 * amber band, and colouring all of them would hide the ones that matter.
 */
function StageValue({ row, stage }: { row: ITurnMetric; stage: LatencyStage }) {
    const bad = toneFor(stage, row[stage]) === "bad";
    return (
        <span className={cn(bad && "font-semibold text-rose-600")}>
            {formatMs(row[stage])}
        </span>
    );
}

function TurnBadges({ row }: { row: ITurnMetric }) {
    return (
        <>
            {row.interrupted && (
                <Badge variant="outline" className="ml-2 px-1 py-0 text-[10px]">
                    cut off
                </Badge>
            )}
            {isGreeting(row) && (
                <Badge
                    variant="outline"
                    className="ml-2 px-1 py-0 text-[10px]"
                    title="No transcript: the toy spoke first, so only TTS was measured"
                >
                    greeting
                </Badge>
            )}
        </>
    );
}

function AnchorBadge({ row }: { row: ITurnMetric }) {
    // An STT span is only "since the child let go" when the client's own
    // end_of_speech anchored it. Anything else is measured from a different
    // event, and a surprising number here is usually the anchor rather than
    // the recognizer.
    if (
        row.stt_ms === null ||
        row.detail?.stt_anchor === undefined ||
        row.detail.stt_anchor === "commit"
    ) {
        return null;
    }
    return (
        <Badge
            variant="outline"
            className="ml-2 px-1 py-0 text-[10px]"
            title={`Measured from ${row.detail.stt_anchor ?? "no release"}, not the button coming up`}
        >
            {row.detail.stt_anchor ?? "no anchor"}
        </Badge>
    );
}

/**
 * Too slow on the total or on one service. Turn close is left out: it sits
 * inside the LLM figure already, and on its own it would flag nearly every
 * turn while the merge timer runs long.
 */
function isSlow(row: ITurnMetric): boolean {
    const stages: LatencyStage[] = ["stt_ms", "llm_ttfb_ms", "tts_ttfb_ms", "total_ms"];
    return stages.some((stage) => toneFor(stage, row[stage]) === "bad");
}

function unique(values: (string | null)[]): string[] {
    return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

export default LatencyTab;

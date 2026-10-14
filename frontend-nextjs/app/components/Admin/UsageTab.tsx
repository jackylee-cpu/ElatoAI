"use client";

import React, { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/use-toast";
import { saveUsageRatesAction } from "@/app/admin/actions";
import {
    Cost,
    DayUsage,
    ZERO_COST,
    addCosts,
    deviceName,
    formatMoney,
    llmPriceMap,
    usageByDay,
    usageByDevice,
} from "@/lib/usageCost";
import { cn } from "@/lib/utils";

interface UsageTabProps {
    thisMonth: IUsageAggregate[];
    lastMonth: IUsageAggregate[];
    byDay: IUsageAggregate[];
    days: string[];
    rates: IUsageRates;
    // null when OpenRouter could not be reached.
    models: IOpenRouterModel[] | null;
    monthLabels: { current: string; previous: string };
}

const PROVIDERS = [
    { key: "stt" as const, label: "STT · Azure", color: "#8cbdec" },
    { key: "llm" as const, label: "LLM · OpenRouter", color: "#2a78cf" },
    { key: "tts" as const, label: "TTS · MiniMax", color: "#f0a14a" },
];

/**
 * What each toy costs to run (P2-09): STT audio, LLM tokens and TTS
 * characters from turn_metrics, priced with OpenRouter's catalogue and the
 * rates below. Super admins only -- the page does not render it for anyone
 * else, and the database functions behind it refuse them.
 */
const UsageTab: React.FC<UsageTabProps> = ({
    thisMonth,
    lastMonth,
    byDay,
    days,
    rates,
    models,
    monthLabels,
}) => {
    const [period, setPeriod] = useState<"current" | "previous">("current");
    const prices = useMemo(() => llmPriceMap(models), [models]);

    const current = useMemo(() => usageByDevice(thisMonth, rates, prices), [thisMonth, rates, prices]);
    const previous = useMemo(() => usageByDevice(lastMonth, rates, prices), [lastMonth, rates, prices]);
    const daily = useMemo(() => usageByDay(byDay, rates, prices, days), [byDay, rates, prices, days]);

    const total = current.reduce((sum, entry) => addCosts(sum, entry.cost), ZERO_COST);
    const turns = current.reduce((sum, entry) => sum + entry.turns, 0);
    const speechMs = current.reduce((sum, entry) => sum + entry.stt_audio_ms, 0);
    const boards = current.filter((entry) => entry.device_id !== null);
    const boardCost = boards.reduce((sum, entry) => sum + entry.cost.total, 0);
    const rows = period === "current" ? current : previous;
    const unpriced = [...current, ...previous].some((entry) => entry.cost.unpriced);

    return (
        <div className="flex flex-col gap-4">
            {(models === null || unpriced) && (
                <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
                    {models === null
                        ? "Could not reach OpenRouter's catalogue, so LLM tokens are not priced: every total below is short by the LLM part."
                        : "Some tokens ran on a model OpenRouter no longer lists a price for; those totals are marked * and are short by that part."}
                </p>
            )}

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat value={formatMoney(total.total, rates)} label={`${monthLabels.current} so far`} />
                <Stat
                    value={boards.length ? formatMoney(boardCost / boards.length, rates) : "—"}
                    label={`Per toy, ${boards.length} toy${boards.length === 1 ? "" : "s"} used this month`}
                />
                <Stat
                    value={turns ? formatMoney(total.total / turns, rates, 3) : "—"}
                    label={`Per turn, ${turns} turns`}
                />
                <Stat value={(speechMs / 60_000).toFixed(1)} label="Minutes of audio sent to STT" />
            </div>

            <Card className="rounded-2xl border-0 bg-white/80 shadow-sm">
                <CardHeader className="pb-2">
                    <CardTitle className="text-base">Daily cost</CardTitle>
                    <CardDescription>HK$ per day, last {days.length} days, Hong Kong time.</CardDescription>
                </CardHeader>
                <CardContent>
                    <DailyChart daily={daily} rates={rates} />
                </CardContent>
            </Card>

            <Card className="rounded-2xl border-0 bg-white/80 shadow-sm">
                <CardHeader className="flex flex-row flex-wrap items-center gap-2 space-y-0 pb-2">
                    <div className="mr-auto">
                        <CardTitle className="text-base">By toy</CardTitle>
                        <CardDescription>Most expensive first. Memory summaries are billed to the toy they ran for.</CardDescription>
                    </div>
                    {(["current", "previous"] as const).map((key) => (
                        <Button
                            key={key}
                            size="sm"
                            variant={period === key ? "default" : "outline"}
                            className="rounded-full"
                            onClick={() => setPeriod(key)}
                        >
                            {key === "current" ? monthLabels.current : monthLabels.previous}
                        </Button>
                    ))}
                </CardHeader>
                <CardContent>
                    {rows.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No usage recorded in this month.</p>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Toy</TableHead>
                                    <TableHead className="text-right">Turns</TableHead>
                                    <TableHead className="text-right">STT min</TableHead>
                                    <TableHead className="text-right">TTS chars</TableHead>
                                    <TableHead className="text-right">Tokens</TableHead>
                                    <TableHead className="text-right">STT</TableHead>
                                    <TableHead className="text-right">LLM</TableHead>
                                    <TableHead className="text-right">TTS</TableHead>
                                    <TableHead className="text-right">Total</TableHead>
                                    <TableHead>Last used</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map((entry) => (
                                    <TableRow key={entry.device_id ?? "web"}>
                                        <TableCell className="whitespace-nowrap font-medium">
                                            {entry.device_id === null ? (
                                                <span>
                                                    Web playground{" "}
                                                    <span className="text-xs font-normal text-muted-foreground">no board</span>
                                                </span>
                                            ) : (
                                                <span title={entry.mac_address ?? undefined}>
                                                    {deviceName(entry.mac_address)}
                                                </span>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">{entry.turns}</TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {(entry.stt_audio_ms / 60_000).toFixed(1)}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">{entry.tts_chars}</TableCell>
                                        <TableCell className="text-right tabular-nums">{entry.tokens}</TableCell>
                                        <MoneyCell usd={entry.cost.stt} rates={rates} />
                                        <MoneyCell usd={entry.cost.llm} rates={rates} mark={entry.cost.unpriced} />
                                        <MoneyCell usd={entry.cost.tts} rates={rates} />
                                        <MoneyCell usd={entry.cost.total} rates={rates} mark={entry.cost.unpriced} strong />
                                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                                            {entry.last_at ? new Date(entry.last_at).toLocaleString() : "—"}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>

            <RatesCard rates={rates} />
        </div>
    );
};

function Stat({ value, label }: { value: string; label: string }) {
    return (
        <div className="rounded-2xl bg-white/80 px-4 py-3 shadow-sm">
            <div className="text-2xl font-semibold tabular-nums">{value}</div>
            <div className="text-xs text-muted-foreground">{label}</div>
        </div>
    );
}

function MoneyCell({
    usd,
    rates,
    mark,
    strong,
}: {
    usd: number;
    rates: IUsageRates;
    mark?: boolean;
    strong?: boolean;
}) {
    return (
        <TableCell className={cn("whitespace-nowrap text-right tabular-nums", strong && "font-medium")}>
            {/* Three places: one toy's day is often a few cents, which two
                places would show as nothing at all. */}
            {formatMoney(usd, rates, 3)}
            {mark && "*"}
        </TableCell>
    );
}

function DailyChart({ daily, rates }: { daily: DayUsage[]; rates: IUsageRates }) {
    const W = 640, H = 220, L = 44, R = 12, T = 16, B = 26;
    const innerW = W - L - R, innerH = H - T - B;
    const band = innerW / Math.max(daily.length, 1);
    const hkd = (cost: Cost, key: keyof Cost) => (cost[key] as number) * rates.usd_to_hkd;
    const peak = Math.max(...daily.map((entry) => entry.cost.total * rates.usd_to_hkd), 0);
    const max = niceCeiling(peak);
    const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
    const x = (i: number) => L + band * i + band * 0.18;
    const y = (value: number) => T + innerH - (value / max) * innerH;
    const labelEvery = Math.ceil(daily.length / 8);

    return (
        <>
            <svg viewBox={`0 0 ${W} ${H}`} className="max-h-[260px] w-full" role="img" aria-label="Daily cost by provider">
                {ticks.map((tick) => (
                    <g key={tick}>
                        <line x1={L} x2={W - R} y1={y(tick)} y2={y(tick)} stroke="#e8eff6" />
                        <text x={L - 6} y={y(tick) + 4} textAnchor="end" fontSize={11} fill="#6b7280">
                            {tick < 10 ? tick.toFixed(1) : Math.round(tick)}
                        </text>
                    </g>
                ))}
                {daily.map((entry, i) => {
                    let base = 0;
                    return (
                        <g key={entry.day}>
                            <title>{`${entry.day}: ${formatMoney(entry.cost.total, rates)}, ${entry.turns} turns`}</title>
                            {PROVIDERS.map((provider) => {
                                const value = hkd(entry.cost, provider.key);
                                const rect = (
                                    <rect
                                        key={provider.key}
                                        x={x(i)}
                                        y={y(base + value)}
                                        width={band * 0.64}
                                        height={Math.max((value / max) * innerH - (value > 0 ? 1 : 0), 0)}
                                        fill={provider.color}
                                    />
                                );
                                base += value;
                                return rect;
                            })}
                        </g>
                    );
                })}
                {daily.map((entry, i) =>
                    (daily.length - 1 - i) % labelEvery === 0 ? (
                        <text key={entry.day} x={x(i) + band * 0.32} y={H - 8} textAnchor="middle" fontSize={11} fill="#6b7280">
                            {entry.day.slice(5).replace("-", "/")}
                        </text>
                    ) : null
                )}
            </svg>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {PROVIDERS.map((provider) => (
                    <span key={provider.key} className="inline-flex items-center gap-1.5">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: provider.color }} />
                        {provider.label}
                    </span>
                ))}
            </div>
        </>
    );
}

/** A round number at or above `value`, so the axis reads 0, 5, 10, 15, 20. */
function niceCeiling(value: number): number {
    if (value <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    for (const step of [1, 2, 4, 5, 10]) {
        if (step * magnitude >= value) return step * magnitude;
    }
    return 10 * magnitude;
}

function RatesCard({ rates }: { rates: IUsageRates }) {
    const [draft, setDraft] = useState({
        stt_usd_per_hour: String(rates.stt_usd_per_hour),
        tts_usd_per_million_chars: String(rates.tts_usd_per_million_chars),
        usd_to_hkd: String(rates.usd_to_hkd),
    });
    const [saving, setSaving] = useState(false);

    const onSave = async (event: React.FormEvent) => {
        event.preventDefault();
        setSaving(true);
        const result = await saveUsageRatesAction({
            stt_usd_per_hour: Number(draft.stt_usd_per_hour),
            tts_usd_per_million_chars: Number(draft.tts_usd_per_million_chars),
            usd_to_hkd: Number(draft.usd_to_hkd),
        });
        setSaving(false);
        toast(result.ok ? { title: "Rates saved" } : { title: "Could not save the rates", description: result.error });
    };

    const fields: { key: keyof typeof draft; label: string; hint: string }[] = [
        { key: "stt_usd_per_hour", label: "STT, US$ per audio hour", hint: "Azure standard real-time" },
        { key: "tts_usd_per_million_chars", label: "TTS, US$ per million characters", hint: "MiniMax speech-2.6-turbo" },
        { key: "usd_to_hkd", label: "HK$ per US$", hint: "Every figure above is converted with this" },
    ];

    return (
        <Card className="rounded-2xl border-0 bg-white/80 shadow-sm">
            <CardHeader className="pb-2">
                <CardTitle className="text-base">Rates</CardTitle>
                <CardDescription>
                    LLM prices come from OpenRouter&apos;s catalogue for each model. Check these against the
                    first Azure and MiniMax bills; a change reprices every month.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <form onSubmit={onSave} className="flex flex-wrap items-end gap-3">
                    {fields.map((field) => (
                        <div key={field.key} className="flex min-w-[180px] flex-1 flex-col gap-1">
                            <Label htmlFor={`rate-${field.key}`}>{field.label}</Label>
                            <Input
                                id={`rate-${field.key}`}
                                inputMode="decimal"
                                value={draft[field.key]}
                                onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
                            />
                            <span className="text-xs text-muted-foreground">{field.hint}</span>
                        </div>
                    ))}
                    <Button type="submit" disabled={saving} className="mb-5 rounded-full">
                        {saving ? "Saving…" : "Save rates"}
                    </Button>
                </form>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">Counted since this page shipped</Badge>
                    <span>
                        Turns recorded before then have LLM tokens but no STT audio or TTS characters, so older
                        months read low.
                    </span>
                </div>
            </CardContent>
        </Card>
    );
}

export default UsageTab;

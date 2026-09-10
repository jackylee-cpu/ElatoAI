"use client";

import React, { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
    LATENCY_STAGES,
    compareByModel,
    formatMs,
    statsForStage,
} from "@/lib/latency";

const ALL = "__all__";

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
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg">No turns recorded yet</CardTitle>
                    <CardDescription>
                        Timings are written as conversations happen. Talk to the
                        toy or use the web player, then reload this page.
                    </CardDescription>
                </CardHeader>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-row flex-wrap gap-2">
                <Select value={model} onValueChange={setModel}>
                    <SelectTrigger className="w-[240px]">
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

            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                {LATENCY_STAGES.map((stage) => {
                    const stats = statsForStage(filtered, stage.key);
                    return (
                        <Card key={stage.key}>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium">
                                    {stage.label}
                                </CardTitle>
                                <CardDescription className="text-xs">
                                    {stage.hint}
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <div className="text-2xl font-semibold">
                                    {formatMs(stats.p50)}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                    p95 {formatMs(stats.p95)} · {stats.count} measured
                                </div>
                            </CardContent>
                        </Card>
                    );
                })}
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">By model</CardTitle>
                    <CardDescription>
                        Median (p95) across every recorded turn, slowest first.
                        Ignores the filters above so two models stay comparable.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Model</TableHead>
                                <TableHead className="text-right">Turns</TableHead>
                                {LATENCY_STAGES.map((stage) => (
                                    <TableHead key={stage.key} className="text-right">
                                        {stage.label}
                                    </TableHead>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {comparison.map((entry) => (
                                <TableRow key={entry.model}>
                                    <TableCell className="font-medium">
                                        {entry.model}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {entry.turns}
                                    </TableCell>
                                    {LATENCY_STAGES.map((stage) => {
                                        const stats = entry.stages[stage.key];
                                        return (
                                            <TableCell
                                                key={stage.key}
                                                className="text-right tabular-nums whitespace-nowrap"
                                            >
                                                {formatMs(stats.p50)}
                                                <span className="text-muted-foreground text-xs">
                                                    {" "}
                                                    ({formatMs(stats.p95)})
                                                </span>
                                            </TableCell>
                                        );
                                    })}
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Recent turns</CardTitle>
                    <CardDescription>
                        A dash means the turn ended before that stage finished —
                        usually the child talking over the toy.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>When</TableHead>
                                <TableHead>Model</TableHead>
                                <TableHead>Character</TableHead>
                                <TableHead>Device</TableHead>
                                <TableHead className="text-right">STT</TableHead>
                                <TableHead className="text-right">LLM</TableHead>
                                <TableHead className="text-right">TTS</TableHead>
                                <TableHead className="text-right">Total</TableHead>
                                <TableHead className="text-right">Tokens</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {filtered.slice(0, 100).map((row) => (
                                <TableRow key={row.turn_metric_id}>
                                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                                        {new Date(row.created_at).toLocaleString()}
                                        {row.interrupted && (
                                            <Badge
                                                variant="outline"
                                                className="ml-2 text-[10px] px-1 py-0"
                                            >
                                                cut off
                                            </Badge>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-xs whitespace-nowrap">
                                        {row.llm_model ?? "—"}
                                    </TableCell>
                                    <TableCell className="text-xs whitespace-nowrap">
                                        {row.personality_key ?? "—"}
                                    </TableCell>
                                    <TableCell className="text-xs">
                                        {row.transport ?? "—"}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums whitespace-nowrap">
                                        {formatMs(row.stt_ms)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums whitespace-nowrap">
                                        {formatMs(row.llm_ttfb_ms)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums whitespace-nowrap">
                                        {formatMs(row.tts_ttfb_ms)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums whitespace-nowrap font-medium">
                                        {formatMs(row.total_ms)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums text-xs text-muted-foreground whitespace-nowrap">
                                        {row.prompt_tokens ?? "—"} / {row.completion_tokens ?? "—"}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
};

function unique(values: (string | null)[]): string[] {
    return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

export default LatencyTab;

/**
 * Aggregating turn latencies for the admin page.
 *
 * The rule running through all of it: a null is a turn that ended before that
 * stage finished -- barge-in, a dropped socket, an LLM error -- not a zero.
 * Averaging nulls as zeroes would make a session full of interruptions look
 * like the fastest one on the page, which is exactly backwards.
 */

/**
 * Every stage below is measured between two frames inside the voice server.
 * The clock starts when the client's commit arrives over the websocket, not
 * when the button came up under the child's thumb, and stops when the server
 * hands audio to the transport, not when the speaker makes a sound. The trip
 * each way, and the toy's own playback buffer, sit outside these numbers -- so
 * read them as server latency, and expect the child to wait longer.
 */
export const LATENCY_STAGES = [
    { key: "stt_ms", label: "STT", hint: "commit → transcript" },
    { key: "turn_close_ms", label: "Turn close", hint: "transcript → LLM released" },
    { key: "llm_ttfb_ms", label: "LLM", hint: "transcript → first token (turn close included)" },
    { key: "tts_ttfb_ms", label: "TTS", hint: "first token → first audio" },
    { key: "total_ms", label: "Total", hint: "commit → first audio out" },
] as const;

export type LatencyStage = (typeof LATENCY_STAGES)[number]["key"];

export interface StageStats {
    count: number;
    p50: number | null;
    p95: number | null;
}

/**
 * Nearest-rank percentile over the values that exist.
 *
 * Nearest-rank rather than interpolated: these are milliseconds from a real
 * turn, and reporting one of them is easier to reason about than reporting a
 * number that sits between two of them and was never measured.
 */
export function percentile(values: number[], fraction: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil(fraction * sorted.length);
    return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export function statsForStage(rows: ITurnMetric[], stage: LatencyStage): StageStats {
    const values = rows
        .map((row) => row[stage])
        .filter((value): value is number => typeof value === "number");
    return {
        count: values.length,
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
    };
}

export interface ModelComparison {
    model: string;
    turns: number;
    stages: Record<LatencyStage, StageStats>;
}

/** One row per model, so "is this one faster" has an answer rather than a vibe. */
export function compareByModel(rows: ITurnMetric[]): ModelComparison[] {
    const groups = new Map<string, ITurnMetric[]>();
    for (const row of rows) {
        const model = row.llm_model ?? "(server default)";
        const group = groups.get(model);
        if (group) group.push(row);
        else groups.set(model, [row]);
    }

    return [...groups.entries()]
        .map(([model, group]) => ({
            model,
            turns: group.length,
            stages: Object.fromEntries(
                LATENCY_STAGES.map((stage) => [stage.key, statsForStage(group, stage.key)]),
            ) as Record<LatencyStage, StageStats>,
        }))
        // Slowest first: the reason to open this page is to find the bad one.
        .sort((a, b) => (b.stages.total_ms.p50 ?? -1) - (a.stages.total_ms.p50 ?? -1));
}

export function formatMs(value: number | null | undefined): string {
    if (typeof value !== "number") return "—";
    if (value < 1000) return `${value} ms`;
    return `${(value / 1000).toFixed(2)} s`;
}

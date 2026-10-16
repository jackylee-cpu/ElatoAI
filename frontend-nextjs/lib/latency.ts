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
    { key: "turn_close_ms", label: "Turn close", hint: "transcript → LLM released (~80ms merge)" },
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

/**
 * Where "fine" ends and "slow" begins, per stage, in server milliseconds.
 *
 * A first cut for reading the page at a glance, not a measured requirement:
 * at or under `good` is on target, over `slow` is too slow, between is slow.
 * The child waits for the network and the toy's buffer on top of every one of
 * these, so the total budget is set below what a conversation can bear.
 */
export const LATENCY_BUDGETS: Record<LatencyStage, { good: number; slow: number }> = {
    stt_ms: { good: 500, slow: 1000 },
    turn_close_ms: { good: 150, slow: 400 },
    llm_ttfb_ms: { good: 1200, slow: 2000 },
    tts_ttfb_ms: { good: 500, slow: 1000 },
    total_ms: { good: 2000, slow: 3000 },
};

export type LatencyTone = "ok" | "warn" | "bad";

export function toneFor(stage: LatencyStage, value: number | null | undefined): LatencyTone | null {
    if (typeof value !== "number") return null;
    const budget = LATENCY_BUDGETS[stage];
    if (value <= budget.good) return "ok";
    if (value <= budget.slow) return "warn";
    return "bad";
}

/**
 * A row where the child never spoke: the toy's greeting, or a turn that
 * closed before anything was said. It has a TTS figure and nothing else, so it
 * says nothing about how long a child waits for an answer.
 */
export function isGreeting(row: ITurnMetric): boolean {
    return !row.transcript_chars && row.stt_ms === null && row.total_ms === null;
}

/**
 * One turn's total, split into the four spans it is made of. total_ms is
 * stt + llm_ttfb + tts_ttfb, and turn close sits inside llm_ttfb, so the LLM
 * part here is the model's own share with the merge timer taken out.
 */
export interface Breakdown {
    stt: number;
    close: number;
    llm: number;
    tts: number;
}

export function breakdownOf(row: ITurnMetric): Breakdown | null {
    if (row.stt_ms === null || row.llm_ttfb_ms === null || row.tts_ttfb_ms === null) return null;
    const close = Math.min(row.turn_close_ms ?? 0, row.llm_ttfb_ms);
    return { stt: row.stt_ms, close, llm: row.llm_ttfb_ms - close, tts: row.tts_ttfb_ms };
}

/**
 * The median of each part over the turns that reached first audio. The parts
 * add up to a typical turn, not to the median total: medians do not add.
 */
export function typicalBreakdown(rows: ITurnMetric[]): { parts: Breakdown; count: number } | null {
    const parts = rows.map(breakdownOf).filter((entry): entry is Breakdown => entry !== null);
    if (parts.length === 0) return null;
    const median = (key: keyof Breakdown) => percentile(parts.map((entry) => entry[key]), 0.5) ?? 0;
    return {
        parts: { stt: median("stt"), close: median("close"), llm: median("llm"), tts: median("tts") },
        count: parts.length,
    };
}

export interface DayStats {
    day: string;
    count: number;
    p50: number;
    p95: number;
}

/** Total latency per Hong Kong day, oldest first, only days that had a turn. */
export function totalsByDay(rows: ITurnMetric[]): DayStats[] {
    const days = new Map<string, number[]>();
    for (const row of rows) {
        if (row.total_ms === null) continue;
        const day = new Date(row.created_at).toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" });
        const values = days.get(day);
        if (values) values.push(row.total_ms);
        else days.set(day, [row.total_ms]);
    }
    return [...days.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, values]) => ({
            day,
            count: values.length,
            p50: percentile(values, 0.5) ?? 0,
            p95: percentile(values, 0.95) ?? 0,
        }));
}

/** Counts in buckets of `step` from zero; the last bucket takes everything from `max` up. */
export function histogram(values: number[], step: number, max: number): { from: number; count: number }[] {
    const buckets = Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => ({ from: i * step, count: 0 }));
    for (const value of values) {
        buckets[Math.min(Math.floor(value / step), buckets.length - 1)].count += 1;
    }
    return buckets;
}

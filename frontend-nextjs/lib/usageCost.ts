/**
 * Pricing for the Usage page (P2-09).
 *
 * Each provider bills on its own unit, and that is what turn_metrics records:
 *   STT  Azure, per hour of audio streamed      -> stt_audio_ms
 *   LLM  OpenRouter, per million tokens         -> prompt / completion tokens
 *   TTS  MiniMax, per million characters        -> tts_chars
 * LLM prices come from OpenRouter's catalogue for the model on the row; STT,
 * TTS and the exchange rate from app_settings 'usage_rates'. Everything is
 * worked out in US dollars, the currency of every bill, and converted once.
 */

export interface LlmPrice {
    // US$ per million tokens.
    prompt: number | null;
    completion: number | null;
}

export interface Cost {
    stt: number;
    llm: number;
    tts: number;
    total: number;
    // Tokens were used on a model the catalogue has no price for, so `llm`
    // is short by an unknown amount.
    unpriced: boolean;
}

export const ZERO_COST: Cost = { stt: 0, llm: 0, tts: 0, total: 0, unpriced: false };

export function llmPriceMap(models: IOpenRouterModel[] | null): Map<string, LlmPrice> {
    return new Map(
        (models ?? []).map((model) => [
            model.id,
            { prompt: model.prompt_price, completion: model.completion_price },
        ]),
    );
}

/** US$ for one aggregate row. */
export function priceUsage(
    row: IUsageAggregate,
    rates: IUsageRates,
    prices: Map<string, LlmPrice>,
): Cost {
    const stt = (row.stt_audio_ms / 3_600_000) * rates.stt_usd_per_hour;
    const tts = (row.tts_chars / 1_000_000) * rates.tts_usd_per_million_chars;

    const tokens = row.prompt_tokens + row.completion_tokens;
    const price = row.llm_model ? prices.get(row.llm_model) : undefined;
    const priced = price !== undefined && price.prompt !== null && price.completion !== null;
    const llm = priced
        ? (row.prompt_tokens / 1_000_000) * (price!.prompt as number) +
          (row.completion_tokens / 1_000_000) * (price!.completion as number)
        : 0;

    return { stt, llm, tts, total: stt + llm + tts, unpriced: tokens > 0 && !priced };
}

export function addCosts(a: Cost, b: Cost): Cost {
    return {
        stt: a.stt + b.stt,
        llm: a.llm + b.llm,
        tts: a.tts + b.tts,
        total: a.total + b.total,
        unpriced: a.unpriced || b.unpriced,
    };
}

export interface DeviceUsage {
    // null is the web playground, which has no board.
    device_id: string | null;
    mac_address: string | null;
    turns: number;
    stt_audio_ms: number;
    tts_chars: number;
    tokens: number;
    last_at: string | null;
    cost: Cost;
}

/** Fold the per-model rows into one per board, most expensive first. */
export function usageByDevice(
    rows: IUsageAggregate[],
    rates: IUsageRates,
    prices: Map<string, LlmPrice>,
): DeviceUsage[] {
    const byDevice = new Map<string, DeviceUsage>();
    for (const row of rows) {
        const key = row.device_id ?? "";
        const entry = byDevice.get(key) ?? {
            device_id: row.device_id ?? null,
            mac_address: row.mac_address ?? null,
            turns: 0,
            stt_audio_ms: 0,
            tts_chars: 0,
            tokens: 0,
            last_at: null,
            cost: ZERO_COST,
        };
        entry.turns += row.turns;
        entry.stt_audio_ms += row.stt_audio_ms;
        entry.tts_chars += row.tts_chars;
        entry.tokens += row.prompt_tokens + row.completion_tokens;
        if (row.last_at && (!entry.last_at || row.last_at > entry.last_at)) {
            entry.last_at = row.last_at;
        }
        entry.cost = addCosts(entry.cost, priceUsage(row, rates, prices));
        byDevice.set(key, entry);
    }
    return Array.from(byDevice.values()).sort((a, b) => b.cost.total - a.cost.total);
}

export interface DayUsage {
    day: string;
    turns: number;
    cost: Cost;
}

/** One entry per calendar day in [from, to), empty days included. */
export function usageByDay(
    rows: IUsageAggregate[],
    rates: IUsageRates,
    prices: Map<string, LlmPrice>,
    days: string[],
): DayUsage[] {
    const byDay = new Map<string, DayUsage>(
        days.map((day) => [day, { day, turns: 0, cost: ZERO_COST }]),
    );
    for (const row of rows) {
        if (!row.day) continue;
        const entry = byDay.get(row.day);
        if (!entry) continue;
        entry.turns += row.turns;
        entry.cost = addCosts(entry.cost, priceUsage(row, rates, prices));
    }
    return days.map((day) => byDay.get(day)!);
}

// Hong Kong has no daylight saving, so a fixed offset is exact.
const HK_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Midnight in Hong Kong on the first of the month `offset` months from now. */
export function hkMonthStart(now: Date, offset = 0): Date {
    const hk = new Date(now.getTime() + HK_OFFSET_MS);
    return new Date(Date.UTC(hk.getUTCFullYear(), hk.getUTCMonth() + offset, 1) - HK_OFFSET_MS);
}

/** Midnight in Hong Kong `daysBack` days before today. */
export function hkDayStart(now: Date, daysBack = 0): Date {
    const hk = new Date(now.getTime() + HK_OFFSET_MS);
    return new Date(
        Date.UTC(hk.getUTCFullYear(), hk.getUTCMonth(), hk.getUTCDate() - daysBack) - HK_OFFSET_MS,
    );
}

/** The Hong Kong calendar dates from `from` up to and including today, as YYYY-MM-DD. */
export function hkDays(from: Date, now: Date): string[] {
    const days: string[] = [];
    for (let at = from.getTime(); at <= now.getTime(); at += 24 * 60 * 60 * 1000) {
        days.push(new Date(at + HK_OFFSET_MS).toISOString().slice(0, 10));
    }
    return days;
}

export function formatMoney(usd: number, rates: IUsageRates, digits = 2): string {
    return `HK$${(usd * rates.usd_to_hkd).toFixed(digits)}`;
}

/** The name the toy shows on its hotspot: AIBuddy- and the MAC's last two bytes. */
export function deviceName(mac: string | null): string {
    if (!mac) return "Unknown board";
    const hex = mac.replace(/[^0-9a-f]/gi, "").toUpperCase();
    return `AIBuddy-${hex.slice(-4)}`;
}

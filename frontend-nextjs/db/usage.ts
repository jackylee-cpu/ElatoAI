import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Usage summed in the database (admin_usage_by_device / admin_usage_by_day),
 * so the page never pulls a month of turn_metrics rows. Both functions refuse
 * anyone but a super admin.
 */

function numbers(rows: Record<string, unknown>[] | null): IUsageAggregate[] {
    // bigint sums come back from PostgREST as numbers or strings depending on
    // size; the page wants numbers either way.
    return (rows ?? []).map((row) => ({
        ...row,
        turns: Number(row.turns ?? 0),
        devices: row.devices === undefined ? undefined : Number(row.devices),
        stt_audio_ms: Number(row.stt_audio_ms ?? 0),
        tts_chars: Number(row.tts_chars ?? 0),
        prompt_tokens: Number(row.prompt_tokens ?? 0),
        completion_tokens: Number(row.completion_tokens ?? 0),
    })) as IUsageAggregate[];
}

export const getUsageByDevice = async (
    supabase: SupabaseClient,
    from: Date,
    to: Date,
): Promise<IUsageAggregate[]> => {
    const { data, error } = await supabase.rpc("admin_usage_by_device", {
        p_from: from.toISOString(),
        p_to: to.toISOString(),
    });
    if (error) {
        console.log("error getUsageByDevice", error);
        return [];
    }
    return numbers(data);
};

export const getUsageByDay = async (
    supabase: SupabaseClient,
    from: Date,
    to: Date,
): Promise<IUsageAggregate[]> => {
    const { data, error } = await supabase.rpc("admin_usage_by_day", {
        p_from: from.toISOString(),
        p_to: to.toISOString(),
        p_timezone: "Asia/Hong_Kong",
    });
    if (error) {
        console.log("error getUsageByDay", error);
        return [];
    }
    return numbers(data);
};

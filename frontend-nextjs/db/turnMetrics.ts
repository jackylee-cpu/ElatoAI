import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Recent turns, newest first.
 *
 * Capped rather than paginated: the admin page aggregates these in the browser
 * (see lib/latency.ts), and a few hundred turns is enough to compare two models
 * without adding an RPC to the database for a percentile.
 */
export const getRecentTurnMetrics = async (
    supabase: SupabaseClient,
    limit = 500,
): Promise<ITurnMetric[]> => {
    const { data, error } = await supabase
        .from("turn_metrics")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);

    if (error) {
        console.log("error getRecentTurnMetrics", error);
        return [];
    }

    return (data ?? []) as ITurnMetric[];
};

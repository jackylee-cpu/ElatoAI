import { SupabaseClient } from "@supabase/supabase-js";

/**
 * What the toy remembers about this child.
 *
 * These rows are the only thing a memory rebuild replays, so deleting one here
 * really does erase it -- the raw `conversations` transcript is never used as a
 * memory source, precisely so that a deletion cannot be undone by it.
 *
 * RLS scopes every query to the signed-in owner, so no user id is passed.
 */
export const dbGetMemories = async (
    supabase: SupabaseClient,
    limit: number = 200
): Promise<IMemory[]> => {
    const { data, error } = await supabase
        .from("memories")
        .select("memory_id, content, agent_reply, kind, source_personality_key, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);

    if (error) {
        throw error;
    }
    return (data ?? []) as IMemory[];
};

export const dbDeleteMemory = async (
    supabase: SupabaseClient,
    memoryId: string
) => {
    const { error } = await supabase
        .from("memories")
        .delete()
        .eq("memory_id", memoryId);

    if (error) {
        throw error;
    }
};

export const dbDeleteAllMemories = async (
    supabase: SupabaseClient,
    userId: string
) => {
    const { error } = await supabase
        .from("memories")
        .delete()
        .eq("user_id", userId);

    if (error) {
        throw error;
    }
};

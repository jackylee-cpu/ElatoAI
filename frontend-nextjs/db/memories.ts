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

/**
 * The per-conversation summaries the toy actually reads on its next session.
 *
 * Kept in a separate table from the utterances because they answer different
 * questions: a summary is what the toy knows, an utterance is what it heard.
 * Showing the second and calling it the first is what made the settings page
 * read as a pile of sentence fragments.
 */
export const dbGetMemorySegments = async (
    supabase: SupabaseClient,
    limit: number = 50
): Promise<IMemorySegment[]> => {
    const { data, error } = await supabase
        .from("memory_segments")
        .select("segment_id, summary, from_turn, to_turn, chat_group_id, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);

    if (error) {
        throw error;
    }
    return (data ?? []) as IMemorySegment[];
};

/**
 * Clear the summaries too.
 *
 * The voice server drops them by itself when it sees the memory revision move,
 * but only on a session that was already holding the old value -- a server that
 * has not run since the deletion has nothing to compare against. Clearing them
 * here makes "clear all" mean it immediately, whatever the server is doing.
 */
export const dbDeleteAllMemorySegments = async (
    supabase: SupabaseClient,
    userId: string
) => {
    const { error } = await supabase
        .from("memory_segments")
        .delete()
        .eq("user_id", userId);

    if (error) {
        throw error;
    }
};

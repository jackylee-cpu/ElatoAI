import { SupabaseClient } from "@supabase/supabase-js";

/**
 * The old memory store's raw lines (`memories`), one per thing the child said.
 *
 * Nothing reads these since that store was removed; they are only cleared, so
 * that "Clear all" leaves nothing of the child behind.
 *
 * RLS scopes every query to the signed-in owner.
 */
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
 * The facts the toy currently holds about this child.
 *
 * Active ones only: a replaced fact stays in the table for tracing but is no
 * longer in any prompt, so showing it would read as the toy still believing it.
 */
export const dbGetMemoryFacts = async (
    supabase: SupabaseClient,
    limit: number = 200
): Promise<IMemoryFact[]> => {
    const { data, error } = await supabase
        .from("memory_facts")
        .select("fact_id, content, chat_group_id, created_at")
        .is("superseded_at", null)
        .order("created_at", { ascending: false })
        .limit(limit);

    if (error) {
        throw error;
    }
    return (data ?? []) as IMemoryFact[];
};

/**
 * Forget one fact. A database trigger also drops the notes from the
 * conversation it was learned in, which could otherwise still mention it.
 */
export const dbDeleteMemoryFact = async (
    supabase: SupabaseClient,
    factId: string
) => {
    const { error } = await supabase
        .from("memory_facts")
        .delete()
        .eq("fact_id", factId);

    if (error) {
        throw error;
    }
};

export const dbDeleteAllMemoryFacts = async (
    supabase: SupabaseClient,
    userId: string
) => {
    const { error } = await supabase
        .from("memory_facts")
        .delete()
        .eq("user_id", userId);

    if (error) {
        throw error;
    }
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

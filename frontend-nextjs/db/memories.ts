import { SupabaseClient } from "@supabase/supabase-js";

/*
 * Memory belongs to a device on an account: each toy remembers its own child
 * (migration 20261009140000). Reads go through the signed-in client, and RLS
 * scopes them to the owner; the device filter picks which toy.
 */

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
    deviceId: string,
    limit: number = 50
): Promise<IMemorySegment[]> => {
    const { data, error } = await supabase
        .from("memory_segments")
        .select("segment_id, summary, from_turn, to_turn, chat_group_id, created_at")
        .eq("device_id", deviceId)
        .order("created_at", { ascending: false })
        .limit(limit);

    if (error) {
        throw error;
    }
    return (data ?? []) as IMemorySegment[];
};

/**
 * The facts this toy currently holds about its child.
 *
 * Active ones only: a replaced fact stays in the table for tracing but is no
 * longer in any prompt, so showing it would read as the toy still believing it.
 */
export const dbGetMemoryFacts = async (
    supabase: SupabaseClient,
    deviceId: string,
    limit: number = 200
): Promise<IMemoryFact[]> => {
    const { data, error } = await supabase
        .from("memory_facts")
        .select("fact_id, content, chat_group_id, created_at")
        .eq("device_id", deviceId)
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

/**
 * Erase everything one toy knows or heard: facts, notes and transcript, in one
 * transaction that also stops a session talking right now from writing any of
 * it back (clear_device_memory). Service role only, so the caller passes the
 * account from the signed-in session, never from the client.
 */
export const clearDeviceMemory = async (
    service: SupabaseClient,
    userId: string,
    deviceId: string
) => {
    const { error } = await service.rpc("clear_device_memory", {
        p_user_id: userId,
        p_device_id: deviceId,
    });
    return !error;
};

import { SupabaseClient } from "@supabase/supabase-js";

export const updateDevice = async (
    supabase: SupabaseClient,
    device: Partial<IDevice>,
    device_id: string,
) => {
    const { error } = await supabase.from("devices").update(device).eq(
        "device_id",
        device_id,
    );
    if (error) {
        throw error;
    }
};

/**
 * Record a bind ticket for this account (supabase/migrations/
 * 20261012170000_device_bind_tickets.sql). Returns when it expires, or null
 * when the account has already asked for its quota this minute.
 */
export const issueBindTicket = async (
    supabase: SupabaseClient,
    userId: string,
    ticketHash: string,
    ttlSeconds: number,
    perMinute: number,
): Promise<string | null> => {
    const { data, error } = await supabase.rpc("issue_device_bind_ticket", {
        p_user_id: userId,
        p_ticket_hash: ticketHash,
        p_ttl_seconds: ttlSeconds,
        p_per_minute: perMinute,
    });
    if (error) {
        throw error;
    }
    return data;
};

export type TicketClaim = "claimed" | "already_yours" | "device_owned" | "ticket_invalid";

/** Bind a board to its ticket's account; see claim_device_with_ticket for the answers. */
export const claimDeviceWithTicket = async (
    supabase: SupabaseClient,
    deviceId: string,
    ticketHash: string,
): Promise<TicketClaim> => {
    const { data, error } = await supabase.rpc("claim_device_with_ticket", {
        p_device_id: deviceId,
        p_ticket_hash: ticketHash,
    });
    if (error) {
        throw error;
    }
    return data;
};

/**
 * Development only (DEVICE_CLAIM_LIST=True): devices that have called home
 * recently but nobody owns yet, for claiming from Settings without a ticket.
 *
 * Off in production. Anyone signed in could take any board on the list, so
 * there a board is claimed only with a bind ticket (P0-11). The time window
 * keeps boards that were unplugged weeks ago out of the list.
 */
export const getUnclaimedDevices = async (
    supabase: SupabaseClient,
    sinceMinutes = 10,
) => {
    const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
    const { data, error } = await supabase
        .from("devices")
        .select("device_id, mac_address, user_code, last_seen_at")
        .is("user_id", null)
        .gte("last_seen_at", since)
        .order("last_seen_at", { ascending: false });

    if (error) {
        throw error;
    }
    return data ?? [];
};

export const claimDevice = async (
    supabase: SupabaseClient,
    deviceId: string,
    userId: string,
) => {
    // Only claim a device nobody else grabbed in the meantime.
    const { data, error } = await supabase
        .from("devices")
        .update({ user_id: userId, claimed_at: new Date().toISOString() })
        .eq("device_id", deviceId)
        .is("user_id", null)
        .select("device_id")
        .maybeSingle();

    return !error && !!data;
};

/**
 * Release a device from this account, erasing its memory first when asked.
 *
 * One transaction (unbind_device): if the erase fails, the device stays bound.
 * Without it the memory is kept, and claiming this device again picks up where
 * it left off. Returns the device's MAC, so its live session can be dropped,
 * or null when the account does not own it -- in which case nothing changed.
 */
export const unbindDevice = async (
    supabase: SupabaseClient,
    deviceId: string,
    userId: string,
    clearMemory: boolean,
): Promise<string | null> => {
    const { data, error } = await supabase.rpc("unbind_device", {
        p_device_id: deviceId,
        p_user_id: userId,
        p_clear_memory: clearMemory,
    });

    if (error || typeof data !== "string") {
        return null;
    }
    return data;
};

/** Every device bound to this account, oldest first. An account can own any number. */
export const getUserDevices = async (
    supabase: SupabaseClient,
    userId: string,
) => {
    const { data, error } = await supabase
        .from("devices")
        .select("device_id, mac_address, user_code, volume")
        .eq("user_id", userId)
        .order("claimed_at", { ascending: true, nullsFirst: true });

    if (error) {
        throw error;
    }
    return (data ?? []) as Pick<IDevice, "device_id" | "mac_address" | "user_code" | "volume">[];
};

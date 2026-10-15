import { SupabaseClient } from "@supabase/supabase-js";
import { BATTERY_COLUMNS, type DeviceBattery } from "@/lib/deviceBattery";

/**
 * The toy a board is sewn into (devices.ip_key, set by an admin), so the
 * parent can tell their boards apart: its name and the photo uploaded on the
 * admin IPs tab. Null for a board in no particular toy.
 */
export type DeviceToy = { toy: Pick<IIp, "name" | "image_url"> | null };
const TOY_COLUMNS = "toy:ips(name, image_url)";

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
        .select(`device_id, mac_address, user_code, volume, ${BATTERY_COLUMNS}, ${TOY_COLUMNS}`)
        .eq("user_id", userId)
        .order("claimed_at", { ascending: true, nullsFirst: true });

    if (error) {
        throw error;
    }
    return (data ?? []) as unknown as (Pick<IDevice, "device_id" | "mac_address" | "user_code" | "volume"> & DeviceBattery & DeviceToy)[];
};

/**
 * One device on this account with what its settings page shows, or null when
 * the account does not own it. The firmware fields are what the board last
 * reported to /api/ota/check; last_seen_at is when it last fetched a token,
 * at boot or once a day, so it is not a live online indicator.
 */
export const getUserDevice = async (
    supabase: SupabaseClient,
    userId: string,
    deviceId: string,
) => {
    const { data, error } = await supabase
        .from("devices")
        .select(
            `device_id, mac_address, user_code, volume, claimed_at, last_seen_at, firmware_version, firmware_reported_at, ${BATTERY_COLUMNS}, ${TOY_COLUMNS}`,
        )
        .eq("user_id", userId)
        .eq("device_id", deviceId)
        .maybeSingle();

    if (error) {
        throw error;
    }
    return data as unknown as
        | (Pick<IDevice, "device_id" | "mac_address" | "user_code" | "volume"> & {
            claimed_at: string | null;
            last_seen_at: string | null;
            firmware_version: string | null;
            firmware_reported_at: string | null;
        } & DeviceBattery & DeviceToy)
        | null;
};

/**
 * The toys an account's boards are sewn into, or null when the account can
 * pick any character: it has no board yet, or one of them is not in a toy.
 * A board in a toy only runs that IP's characters (see device_registry.py).
 */
export const getToyIpKeys = async (
    supabase: SupabaseClient,
    userId: string,
): Promise<string[] | null> => {
    const { data, error } = await supabase
        .from("devices")
        .select("ip_key")
        .eq("user_id", userId);
    if (error) {
        console.error("Could not read the account's toys", error);
        return null;
    }
    const keys = (data ?? []).map((device) => device.ip_key as string | null);
    if (keys.length === 0 || keys.some((key) => !key)) {
        return null;
    }
    return Array.from(new Set(keys as string[]));
};

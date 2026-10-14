import { SupabaseClient } from "@supabase/supabase-js";
import { BATTERY_COLUMNS, type DeviceBattery } from "@/lib/deviceBattery";

export const dbCheckUserCode = async (
    supabase: SupabaseClient,
    userCode: string,
) => {
    const { data, error } = await supabase
        .from("devices")
        .select("*")
        .eq("user_code", userCode)
        .maybeSingle();

    if (error) {
        throw error;
    }
    return !!data;
};

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

export const addUserToDevice = async (
    supabase: SupabaseClient,
    userCode: string,
    userId: string,
) => {
    const { data, error } = await supabase
        .from("devices")
        .update({ user_id: userId })
        .eq("user_code", userCode)
        .select("*")
        .maybeSingle();

    return !error && !!data;
};

/**
 * Devices that have called home recently but nobody owns yet.
 *
 * A board registers itself the first time it reaches generate_auth_token, so
 * this is what the owner picks from instead of typing a code. The time window
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
        .select(`device_id, mac_address, user_code, volume, ${BATTERY_COLUMNS}`)
        .eq("user_id", userId)
        .order("claimed_at", { ascending: true, nullsFirst: true });

    if (error) {
        throw error;
    }
    return (data ?? []) as (Pick<IDevice, "device_id" | "mac_address" | "user_code" | "volume"> & DeviceBattery)[];
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
            `device_id, mac_address, user_code, volume, claimed_at, last_seen_at, firmware_version, firmware_reported_at, ${BATTERY_COLUMNS}`,
        )
        .eq("user_id", userId)
        .eq("device_id", deviceId)
        .maybeSingle();

    if (error) {
        throw error;
    }
    return data as
        | (Pick<IDevice, "device_id" | "mac_address" | "user_code" | "volume"> & {
            claimed_at: string | null;
            last_seen_at: string | null;
            firmware_version: string | null;
            firmware_reported_at: string | null;
        } & DeviceBattery)
        | null;
};

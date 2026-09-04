import { SupabaseClient } from "@supabase/supabase-js";
import { updateUser } from "./users";

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

    if (error || !data) {
        return false;
    }

    await updateUser(supabase, { device_id: data.device_id }, userId);

    return true;
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

    if (error || !data) {
        return false;
    }

    await updateUser(supabase, { device_id: data.device_id }, userId);
    return true;
};

export const unbindDevice = async (
    supabase: SupabaseClient,
    deviceId: string,
    userId: string,
) => {
    const { error } = await supabase
        .from("devices")
        .update({ user_id: null, claimed_at: null })
        .eq("device_id", deviceId)
        .eq("user_id", userId);

    if (error) {
        return false;
    }

    await updateUser(supabase, { device_id: null }, userId);
    return true;
};

export const doesUserHaveADevice = async (
    supabase: SupabaseClient,
    userId: string,
) => {
    const { data, error } = await supabase
        .from("devices")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

    if (error) {
        throw error;
    }

    return !!data;
};

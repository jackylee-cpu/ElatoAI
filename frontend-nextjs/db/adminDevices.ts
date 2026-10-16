import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Every board, for the admin Devices page (P2-14).
 *
 * admin_list_devices() refuses anyone but a super admin and returns only what
 * the page shows: no pairing code, no secret hash, nothing about the child.
 */
export const listDevicesForAdmin = async (
    supabase: SupabaseClient,
): Promise<IAdminDevice[]> => {
    const { data, error } = await supabase.rpc("admin_list_devices");
    if (error) {
        console.log("error listDevicesForAdmin", error);
        return [];
    }
    return (data ?? []) as IAdminDevice[];
};

/**
 * Crash reports from the last `days` days, newest first (device_crashes).
 * admin_list_device_crashes() refuses anyone but a super admin.
 */
export const listDeviceCrashesForAdmin = async (
    supabase: SupabaseClient,
    days = 30,
): Promise<IAdminDeviceCrash[]> => {
    const { data, error } = await supabase.rpc("admin_list_device_crashes", { p_days: days });
    if (error) {
        console.log("error listDeviceCrashesForAdmin", error);
        return [];
    }
    return (data ?? []) as IAdminDeviceCrash[];
};

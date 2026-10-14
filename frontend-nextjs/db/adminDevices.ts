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

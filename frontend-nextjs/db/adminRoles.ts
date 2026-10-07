import { SupabaseClient } from "@supabase/supabase-js";

// Granting, revoking and listing go through SECURITY DEFINER functions
// (20261007180000_admin_roles.sql) that check has_role('super_admin') first.
// They resolve an email to an account without the caller reading auth.users.

/** Every role held by every account. Super admins only; [] for anyone else. */
export const listAdminRoles = async (
    supabase: SupabaseClient,
): Promise<IAdminRoleEntry[]> => {
    const { data, error } = await supabase.rpc("admin_list_roles");
    if (error) {
        console.error("error listAdminRoles", error);
        return [];
    }
    return (data ?? []) as IAdminRoleEntry[];
};

export const grantAdminRole = async (
    supabase: SupabaseClient,
    email: string,
    role: AdminRole,
) => {
    const { error } = await supabase.rpc("admin_grant_role", {
        target_email: email,
        new_role: role,
    });
    if (error) {
        throw error;
    }
};

export const revokeAdminRole = async (
    supabase: SupabaseClient,
    userId: string,
    role: AdminRole,
) => {
    const { error } = await supabase.rpc("admin_revoke_role", {
        target_user: userId,
        old_role: role,
    });
    if (error) {
        throw error;
    }
};

import { SupabaseClient } from "@supabase/supabase-js";

/**
 * The newest admin audit records (P1-10).
 *
 * Read with the super admin's own key; RLS returns nothing to anyone else.
 * Capped rather than paginated for now: a few hundred records cover weeks of
 * admin work at this size.
 */
export const listAuditLog = async (
    supabase: SupabaseClient,
    limit = 300,
): Promise<IAdminAuditEntry[]> => {
    const { data, error } = await supabase
        .from("admin_audit_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);

    if (error) {
        console.log("error listAuditLog", error);
        return [];
    }
    return (data ?? []) as IAdminAuditEntry[];
};

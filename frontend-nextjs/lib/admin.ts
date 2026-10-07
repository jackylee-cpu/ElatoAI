import { notFound, redirect } from "next/navigation";
import { SupabaseClient, User } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";

/**
 * Who is allowed into /admin, and as what.
 *
 * Roles live in public.admin_roles and the database enforces them: every admin
 * read and write runs with the admin's own key, and RLS asks has_role(). The
 * checks here decide what to render and fail early with a useful redirect;
 * they are not the only gate.
 *
 * super_admin can do everything content_admin can, exactly as has_role() says.
 */
export interface AdminSession {
    supabase: SupabaseClient;
    user: User;
    roles: AdminRole[];
}

/** The roles this signed-in account holds, read through its own policy. */
export async function getAdminRoles(
    supabase: SupabaseClient,
    userId: string,
): Promise<AdminRole[]> {
    const { data, error } = await supabase
        .from("admin_roles")
        .select("role")
        .eq("user_id", userId);

    if (error) {
        console.error("error getAdminRoles", error);
        return [];
    }
    return (data ?? []).map((row) => row.role as AdminRole);
}

export function roleAllows(roles: AdminRole[], required: AdminRole): boolean {
    return roles.includes("super_admin") || roles.includes(required);
}

/**
 * Guard for admin pages and server actions.
 *
 * Not signed in -> /login. No admin role -> 404, so the page does not confirm
 * it exists. Admin without the role this needs -> /admin, which shows only
 * what their roles allow.
 *
 * A server action is reachable without rendering the page it came from, so
 * every action calls this itself rather than trusting the layout.
 */
export async function requireAdmin(
    required: AdminRole = "content_admin",
): Promise<AdminSession> {
    const session = await getAdminSession();
    if (!session) {
        redirect("/login");
    }
    if (session.roles.length === 0) {
        notFound();
    }
    if (!roleAllows(session.roles, required)) {
        redirect("/admin");
    }
    return session;
}

/**
 * The same checks for route handlers, which answer with a status code instead
 * of a redirect. Returns null when the caller may not proceed.
 */
export async function adminSessionOrNull(
    required: AdminRole = "content_admin",
): Promise<AdminSession | null> {
    const session = await getAdminSession();
    if (!session || !roleAllows(session.roles, required)) {
        return null;
    }
    return session;
}

/** Signed-in account and its roles, or null when nobody is signed in. */
export async function getAdminSession(): Promise<AdminSession | null> {
    const supabase = createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        return null;
    }
    const roles = await getAdminRoles(supabase, user.id);
    return { supabase, user, roles };
}

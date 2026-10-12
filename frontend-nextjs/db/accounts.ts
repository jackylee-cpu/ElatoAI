import { SupabaseClient } from "@supabase/supabase-js";

// Login accounts (auth.users) through GoTrue's admin API, which only the
// service-role key may call. Callers must have checked super_admin first
// (requireAdmin in app/admin/actions.ts) -- nothing in the database stands
// behind these the way RLS stands behind the other admin queries.

// More accounts than the planned 100-500 units; one page keeps this simple.
const ACCOUNTS_PAGE_SIZE = 1000;

/** Every login account, newest first. */
export const listAccounts = async (
    service: SupabaseClient,
): Promise<IAccountEntry[]> => {
    const { data, error } = await service.auth.admin.listUsers({
        page: 1,
        perPage: ACCOUNTS_PAGE_SIZE,
    });
    if (error) {
        console.error("error listAccounts", error);
        return [];
    }
    return data.users
        .map((user) => ({
            user_id: user.id,
            email: user.email ?? "",
            created_at: user.created_at,
            last_sign_in_at: user.last_sign_in_at ?? null,
            confirmed: Boolean(user.email_confirmed_at),
        }))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
};

/**
 * A ready-to-use email/password account. The address is marked confirmed, so
 * no email is sent and the person can log in at once; the public.users row is
 * created by /home on that first login, as for any other account.
 */
export const createAccount = async (
    service: SupabaseClient,
    email: string,
    password: string,
): Promise<string> => {
    const { data, error } = await service.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
    });
    if (error) {
        throw error;
    }
    return data.user.id;
};

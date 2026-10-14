import { SupabaseClient, User } from "@supabase/supabase-js";

// Login accounts (auth.users) through GoTrue's admin API, which only the
// service-role key may call. Callers must have checked super_admin first
// (requireAdmin in app/admin/actions.ts) -- nothing in the database stands
// behind these the way RLS stands behind the other admin queries.
// Deleting an account is the exception: that goes through admin_delete_account
// on the admin's own key, so the audit record and the row removal commit
// together.

// GoTrue caps a page at 1000. The planned fleet is 100-500 accounts; the loop
// is there so a longer list is still complete.
const ACCOUNTS_PAGE_SIZE = 1000;
const ACCOUNTS_MAX_PAGES = 20;

/** Present on the GoTrue user payload; the client User type omits it. */
function bannedUntil(user: User): string | null {
    const until = (user as User & { banned_until?: string | null }).banned_until;
    return until ?? null;
}

/** Every login account, newest first. */
export const listAccounts = async (
    service: SupabaseClient,
): Promise<IAccountEntry[]> => {
    const users: User[] = [];
    for (let page = 1; page <= ACCOUNTS_MAX_PAGES; page++) {
        const { data, error } = await service.auth.admin.listUsers({
            page,
            perPage: ACCOUNTS_PAGE_SIZE,
        });
        if (error) {
            console.error("error listAccounts", error);
            return users.length > 0 ? mapAccounts(users) : [];
        }
        users.push(...data.users);
        if (data.users.length < ACCOUNTS_PAGE_SIZE) break;
    }
    return mapAccounts(users);
};

function mapAccounts(users: User[]): IAccountEntry[] {
    return users
        .map((user) => ({
            user_id: user.id,
            email: user.email ?? "",
            created_at: user.created_at,
            last_sign_in_at: user.last_sign_in_at ?? null,
            confirmed: Boolean(user.email_confirmed_at),
            banned_until: bannedUntil(user),
        }))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export const getAuthUser = async (
    service: SupabaseClient,
    userId: string,
): Promise<User | null> => {
    const { data, error } = await service.auth.admin.getUserById(userId);
    if (error) {
        const status = (error as { status?: number }).status;
        if (status === 404) return null;
        throw error;
    }
    return data.user ?? null;
};

export { bannedUntil };

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

/**
 * Email, password, confirmation or ban on an existing login. Whatever is
 * omitted stays as it is. The password is not returned and must not be logged.
 */
export const updateAccountLogin = async (
    service: SupabaseClient,
    userId: string,
    attributes: {
        email?: string;
        password?: string;
        email_confirm?: boolean;
        ban_duration?: string;
    },
): Promise<void> => {
    const { error } = await service.auth.admin.updateUserById(userId, attributes);
    if (error) {
        throw error;
    }
};

/** public.users.email is a copy of the login address; keep it when the login changes. */
export const syncProfileEmail = async (
    service: SupabaseClient,
    userId: string,
    email: string,
): Promise<void> => {
    const { error } = await service.from("users").update({ email }).eq("user_id", userId);
    if (error) {
        throw error;
    }
};

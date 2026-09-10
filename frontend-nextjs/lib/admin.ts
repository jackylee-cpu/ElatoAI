import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { getUserById } from "@/db/users";

/**
 * Who is allowed into /home/admin.
 *
 * Any signed-in account, unless ADMIN_EMAILS is set -- then only the addresses
 * in it. That default is deliberate and it is wide: an admin can change the
 * model every session runs on and read or rewrite the character prompts
 * belonging to other people's children. Setting ADMIN_EMAILS before this is
 * exposed to real parents is the one line that closes that.
 *
 * There is no is_admin column and no role in the schema, so this is the whole
 * check. It has to run in the layout AND at the top of every server action:
 * middleware.ts currently guards nothing (the route protection in
 * utils/supabase/middleware.ts is commented out), and a server action is
 * reachable without ever rendering the page it came from.
 */
export async function assertAdmin(): Promise<IUser> {
    const supabase = createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
        redirect("/login");
    }

    const dbUser = await getUserById(supabase, user.id);
    if (!dbUser) {
        redirect("/login");
    }

    if (!isAdminEmail(dbUser.email)) {
        redirect("/home");
    }

    return dbUser;
}

/** Is this address on the allowlist? An unset allowlist admits everyone. */
export function isAdminEmail(email: string | null | undefined): boolean {
    const allowlist = adminEmails();
    if (allowlist.length === 0) {
        return true;
    }
    return allowlist.includes((email ?? "").trim().toLowerCase());
}

function adminEmails(): string[] {
    return (process.env.ADMIN_EMAILS ?? "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
}

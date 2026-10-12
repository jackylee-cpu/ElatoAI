import AdminDashboard from "@/app/components/Admin/AdminDashboard";
import { getVoiceStackSettings } from "@/db/appSettings";
import { getAllPersonalitiesForAdmin } from "@/db/personalities";
import { getRecentTurnMetrics } from "@/db/turnMetrics";
import { listAdminRoles } from "@/db/adminRoles";
import { listAccounts } from "@/db/accounts";
import { createServiceClient } from "@/utils/supabase/service";
import { requireAdmin, roleAllows } from "@/lib/admin";
import { getAllIps, getAllModes, getAllStyles } from "@/db/sessionOptions";

// Latency numbers are the point of the page, so it must not be served from a
// cache that predates the last conversation.
export const dynamic = "force-dynamic";

export default async function AdminPage() {
    const { supabase, user, roles } = await requireAdmin();

    // The admin's own key throughout: RLS decides what each role may read, so
    // a content admin asking for turn_metrics would get nothing even if this
    // page forgot to skip it.
    const isSuper = roleAllows(roles, "super_admin");

    const [settings, turnMetrics, admins, accounts, personalities, ips, modes, styles] =
        await Promise.all([
            isSuper ? getVoiceStackSettings(supabase) : Promise.resolve({}),
            isSuper ? getRecentTurnMetrics(supabase) : Promise.resolve([]),
            isSuper ? listAdminRoles(supabase) : Promise.resolve([]),
            // The one service-role read on this page: auth.users is not
            // exposed to any key but that one. Only ever for a super admin.
            isSuper ? listAccounts(createServiceClient()) : Promise.resolve([]),
            getAllPersonalitiesForAdmin(supabase),
            getAllIps(supabase),
            getAllModes(supabase),
            getAllStyles(supabase),
        ]);

    return (
        <AdminDashboard
            roles={roles}
            currentUserId={user.id}
            settings={settings}
            turnMetrics={turnMetrics}
            admins={admins}
            accounts={accounts}
            personalities={personalities}
            ips={ips}
            modes={modes}
            styles={styles}
        />
    );
}

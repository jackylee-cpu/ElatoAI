import AdminDashboard from "@/app/components/Admin/AdminDashboard";
import { DEFAULT_USAGE_RATES, getUsageRates, getVoiceStackSettings } from "@/db/appSettings";
import { getAllPersonalitiesForAdmin } from "@/db/personalities";
import { getRecentTurnMetrics } from "@/db/turnMetrics";
import { listAdminRoles } from "@/db/adminRoles";
import { listAccounts } from "@/db/accounts";
import { createServiceClient } from "@/utils/supabase/service";
import { requireAdmin, roleAllows } from "@/lib/admin";
import { getAllIps, getAllModes, getAllStyles } from "@/db/sessionOptions";
import { listAuditLog } from "@/db/auditLog";
import { getUsageByDay, getUsageByDevice } from "@/db/usage";
import { fetchOpenRouterModels } from "@/lib/openrouterCatalogue";
import { hkDayStart, hkDays, hkMonthStart } from "@/lib/usageCost";

// The daily cost chart covers this many days, today included.
const USAGE_DAYS = 30;

// Latency numbers are the point of the page, so it must not be served from a
// cache that predates the last conversation.
export const dynamic = "force-dynamic";

export default async function AdminPage() {
    const { supabase, user, roles } = await requireAdmin();

    // The admin's own key throughout: RLS decides what each role may read, so
    // a content admin asking for turn_metrics would get nothing even if this
    // page forgot to skip it.
    const isSuper = roleAllows(roles, "super_admin");

    const now = new Date();
    const thisMonth = hkMonthStart(now);
    const nextMonth = hkMonthStart(now, 1);
    const lastMonth = hkMonthStart(now, -1);
    const firstDay = hkDayStart(now, USAGE_DAYS - 1);
    const monthName = (date: Date) =>
        date.toLocaleString("en-GB", { month: "long", timeZone: "Asia/Hong_Kong" });

    const [
        settings,
        turnMetrics,
        admins,
        accounts,
        personalities,
        ips,
        modes,
        styles,
        audit,
        usageThisMonth,
        usageLastMonth,
        usageByDay,
        usageRates,
        openRouterModels,
    ] = await Promise.all([
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
            isSuper ? listAuditLog(supabase) : Promise.resolve([]),
            isSuper ? getUsageByDevice(supabase, thisMonth, nextMonth) : Promise.resolve([]),
            isSuper ? getUsageByDevice(supabase, lastMonth, thisMonth) : Promise.resolve([]),
            isSuper ? getUsageByDay(supabase, firstDay, nextMonth) : Promise.resolve([]),
            isSuper ? getUsageRates(supabase) : Promise.resolve(DEFAULT_USAGE_RATES),
            isSuper ? fetchOpenRouterModels() : Promise.resolve(null),
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
            audit={audit}
            usage={{
                thisMonth: usageThisMonth,
                lastMonth: usageLastMonth,
                byDay: usageByDay,
                days: hkDays(firstDay, now),
                rates: usageRates,
                models: openRouterModels,
                monthLabels: { current: monthName(thisMonth), previous: monthName(lastMonth) },
            }}
        />
    );
}

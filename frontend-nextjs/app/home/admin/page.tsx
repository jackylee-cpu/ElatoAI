import AdminDashboard from "@/app/components/Admin/AdminDashboard";
import { getVoiceStackSettings } from "@/db/appSettings";
import { getAllPersonalitiesForAdmin } from "@/db/personalities";
import { getRecentTurnMetrics } from "@/db/turnMetrics";
import { assertAdmin } from "@/lib/admin";
import { createServiceClient } from "@/utils/supabase/service";

// Latency numbers are the point of the page, so it must not be served from a
// cache that predates the last conversation.
export const dynamic = "force-dynamic";

export default async function AdminPage() {
    await assertAdmin();

    // Service role throughout: this page reads across every account, and
    // `personalities` has no UPDATE policy at all, so nothing here works with
    // an authenticated key.
    const supabase = createServiceClient();

    const [settings, turnMetrics, personalities] = await Promise.all([
        getVoiceStackSettings(supabase),
        getRecentTurnMetrics(supabase),
        getAllPersonalitiesForAdmin(supabase),
    ]);

    return (
        <div className="pb-4 flex flex-col gap-2">
            <AdminDashboard
                settings={settings}
                turnMetrics={turnMetrics}
                personalities={personalities}
            />
        </div>
    );
}

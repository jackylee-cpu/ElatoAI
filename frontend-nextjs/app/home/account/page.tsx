import AccountDashboard from "@/app/components/Account/AccountDashboard";
import { getUserDevices } from "@/db/devices";
import { getUserById } from "@/db/users";
import { getOpenGraphMetadata } from "@/lib/utils";
import { createClient } from "@/utils/supabase/server";
import { Metadata } from "next";

export const metadata: Metadata = {
    title: "Me",
    ...getOpenGraphMetadata("Me"),
};

export default async function AccountPage() {
    const supabase = createClient();

    const {
        data: { user },
    } = await supabase.auth.getUser();

    const [dbUser, devices] = user
        ? await Promise.all([
            getUserById(supabase, user.id),
            getUserDevices(supabase, user.id),
        ])
        : [null, []];

    return (
        <>
            {dbUser && (
                <AccountDashboard currentUser={dbUser} devices={devices} />
            )}
        </>
    );
}

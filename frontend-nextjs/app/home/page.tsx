import { getUserById } from "@/db/users";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import Playground from "../components/Playground/PlaygroundComponent";
import { getAllPersonalities, getMyPersonalities } from "@/db/personalities";
import { getAdminRoles } from "@/lib/admin";
import { getAllIps } from "@/db/sessionOptions";


export const revalidate = 0; // disable cache for this route
export const dynamic = "force-dynamic";

export default async function Home() {
    const supabase = createClient();

    const {
        data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
        redirect("/login");
    }

    const [dbUser, allPersonalities, myPersonalities, ips, adminRoles] =
        await Promise.all([
            getUserById(supabase, user!.id),
            getAllPersonalities(supabase),
            getMyPersonalities(supabase, user?.id ?? ""),
            getAllIps(supabase),
            getAdminRoles(supabase, user!.id),
        ]);

    return (
        <>
            {dbUser && (
                <Playground
                    allPersonalities={allPersonalities}
                    myPersonalities={myPersonalities}
                    ips={ips}
                    currentUser={dbUser}
                    isAdmin={adminRoles.length > 0}
                />
            )}
        </>
    );
}

import PersonalInfo from "@/app/components/Account/PersonalInfo";
import { getUserById } from "@/db/users";
import { getOpenGraphMetadata } from "@/lib/utils";
import { createClient } from "@/utils/supabase/server";
import { Metadata } from "next";

export const metadata: Metadata = {
    title: "Personal Info",
    ...getOpenGraphMetadata("Personal Info"),
};

export default async function PersonalInfoPage() {
    const supabase = createClient();

    const {
        data: { user },
    } = await supabase.auth.getUser();

    const dbUser = user ? await getUserById(supabase, user.id) : null;

    return <>{dbUser && <PersonalInfo currentUser={dbUser} />}</>;
}

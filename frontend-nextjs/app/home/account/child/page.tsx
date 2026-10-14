import ChildInfo from "@/app/components/Account/ChildInfo";
import { getAllLanguages } from "@/db/languages";
import { getAllRegions } from "@/db/regions";
import { getUserById } from "@/db/users";
import { getOpenGraphMetadata } from "@/lib/utils";
import { createClient } from "@/utils/supabase/server";
import { Metadata } from "next";

export const metadata: Metadata = {
    title: "My Info",
    ...getOpenGraphMetadata("My Info"),
};

export default async function ChildInfoPage() {
    const supabase = createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();

    const [dbUser, allLanguages, allRegions] = user
        ? await Promise.all([
            getUserById(supabase, user.id),
            getAllLanguages(supabase),
            getAllRegions(supabase),
        ])
        : [null, [], []];

    if (!dbUser) {
        return null;
    }

    return (
        <ChildInfo
            currentUser={dbUser}
            allLanguages={allLanguages}
            allRegions={allRegions}
        />
    );
}

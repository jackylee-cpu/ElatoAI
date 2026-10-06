import { SupabaseClient } from "@supabase/supabase-js";

// Fails soft to an empty list: the Settings page hides the region field rather
// than refusing to load on a database that has not had the regions migration.
export const getAllRegions = async (supabase: SupabaseClient) => {
    const { data, error } = await supabase
        .from("regions")
        .select("*")
        .order("sort_order");
    if (error) {
        console.error("Could not load regions", error);
        return [] as IRegion[];
    }
    return data as IRegion[];
};

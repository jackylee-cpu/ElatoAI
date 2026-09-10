import { SupabaseClient } from "@supabase/supabase-js";

export const createPersonality = async (
    supabase: SupabaseClient,
    userId: string,
    personality: IPersonality,
): Promise<IPersonality | null> => {
    const { data, error } = await supabase
        .from("personalities")
        .insert({
            ...personality,
            creator_id: userId,
        }).select();

    if (error) {
        console.error("Error creating personality:", error);
        throw error;
    }

    return data ? data[0] : null;
};

export const getPersonalityById = async (
    supabase: SupabaseClient,
    personalityId: string,
) => {
    const { data, error } = await supabase
        .from("personalities")
        .select(`*`)
        .eq("personality_id", personalityId);

    if (error) {
        console.log("error getPersonalityById", error);
        return null;
    }

    return data[0] as IPersonality;
};

export const getAllPersonalities = async (supabase: SupabaseClient) => {
    const { data, error } = await supabase
        .from("personalities")
        .select(`*`)
        .is("creator_id", null)
        // Retired characters keep their row (users.personality_id references
        // it) but must not show up in the picker.
        .eq("is_hidden", false)
        .order("created_at", { ascending: false });

    if (error) {
        console.log("error getAllPersonalities", error);
        return [];
    }

    return data as IPersonality[];
};

export const getMyPersonalities = async (
    supabase: SupabaseClient,
    userId: string,
) => {
    const { data, error } = await supabase
        .from("personalities")
        .select(`*`)
        .eq("is_hidden", false)
        .eq("creator_id", userId);

    if (error) {
        console.log("error getMyPersonalities", error);
        return [];
    }

    return data as IPersonality[];
};


// ── admin ────────────────────────────────────────────────────────────────────
// Everything below reaches across accounts and needs a service-role client:
// `personalities` has a SELECT policy for everyone and no UPDATE or DELETE
// policy at all, so an authenticated key writes nothing and reports success.

/** Every character, built-in and user-made, hidden ones included. */
export const getAllPersonalitiesForAdmin = async (
    supabase: SupabaseClient,
): Promise<IAdminPersonality[]> => {
    const { data, error } = await supabase
        .from("personalities")
        .select(`*, creator:creator_id(email)`)
        .order("created_at", { ascending: false });

    if (error) {
        console.log("error getAllPersonalitiesForAdmin", error);
        return [];
    }

    return (data ?? []).map((row) => {
        const { creator, ...personality } = row as IAdminPersonality & {
            creator?: { email?: string } | null;
        };
        return {
            ...(personality as IAdminPersonality),
            creator_email: creator?.email ?? null,
        };
    });
};

export const updatePersonalityAsAdmin = async (
    supabase: SupabaseClient,
    personalityId: string,
    updates: Partial<IPersonality>,
) => {
    const { error } = await supabase
        .from("personalities")
        .update(updates)
        .eq("personality_id", personalityId);

    if (error) {
        console.error("error updatePersonalityAsAdmin", error);
        throw error;
    }
};

/** Create a built-in character: creator_id null is what puts it on /home. */
export const createBuiltinPersonality = async (
    supabase: SupabaseClient,
    personality: Partial<IPersonality>,
) => {
    const { data, error } = await supabase
        .from("personalities")
        .insert({ ...personality, creator_id: null })
        .select();

    if (error) {
        console.error("error createBuiltinPersonality", error);
        throw error;
    }

    return data ? (data[0] as IPersonality) : null;
};

import { SupabaseClient } from "@supabase/supabase-js";

/** The one settings key that exists so far. */
export const VOICE_STACK_KEY = "voice_stack";

/**
 * The site-wide voice settings the FastAPI server reads at session start.
 *
 * An empty object is the normal state of a fresh install, and it means "use
 * whatever the voice server was started with" -- not "no model". Callers must
 * not fill the blanks in with guesses; the server owns those defaults.
 */
export const getVoiceStackSettings = async (
    supabase: SupabaseClient,
): Promise<IVoiceStackSettings> => {
    const { data, error } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", VOICE_STACK_KEY)
        .maybeSingle();

    if (error) {
        console.log("error getVoiceStackSettings", error);
        return {};
    }

    return (data?.value as IVoiceStackSettings) ?? {};
};

/**
 * Replace the voice settings row.
 *
 * Called with a super admin's own key: RLS lets has_role('super_admin') read
 * and write app_settings and nobody else. The voice server reads it as
 * service_role.
 */
export const saveVoiceStackSettings = async (
    supabase: SupabaseClient,
    value: IVoiceStackSettings,
    updatedBy: string | null,
) => {
    const { error } = await supabase.from("app_settings").upsert(
        {
            key: VOICE_STACK_KEY,
            value,
            updated_at: new Date().toISOString(),
            updated_by: updatedBy,
        },
        { onConflict: "key" },
    );

    if (error) {
        console.error("error saveVoiceStackSettings", error);
        throw error;
    }
};

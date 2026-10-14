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

export const USAGE_RATES_KEY = "usage_rates";

/**
 * What the Usage page prices with until someone sets the real figures. The
 * migration seeds the same values; these only cover a database that has not
 * run it.
 */
export const DEFAULT_USAGE_RATES: IUsageRates = {
    stt_usd_per_hour: 1.0,
    tts_usd_per_million_chars: 60,
    usd_to_hkd: 7.8,
};

export const getUsageRates = async (supabase: SupabaseClient): Promise<IUsageRates> => {
    const { data, error } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", USAGE_RATES_KEY)
        .maybeSingle();

    if (error) {
        console.log("error getUsageRates", error);
    }
    return { ...DEFAULT_USAGE_RATES, ...((data?.value as Partial<IUsageRates>) ?? {}) };
};

export const saveUsageRates = async (
    supabase: SupabaseClient,
    value: IUsageRates,
    updatedBy: string | null,
) => {
    const { error } = await supabase.from("app_settings").upsert(
        {
            key: USAGE_RATES_KEY,
            value,
            updated_at: new Date().toISOString(),
            updated_by: updatedBy,
        },
        { onConflict: "key" },
    );

    if (error) {
        console.error("error saveUsageRates", error);
        throw error;
    }
};

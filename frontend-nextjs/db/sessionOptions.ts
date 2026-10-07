import { SupabaseClient } from "@supabase/supabase-js";

// IPs, modes and styles for the playground and the admin page. Each fails soft
// to an empty list, like getAllRegions: a database without the
// ips/modes/styles migration hides the pickers rather than breaking the page.

export const getAllIps = async (supabase: SupabaseClient) => {
    const { data, error } = await supabase
        .from("ips")
        .select("*, ip_modes(mode_key, prompt), ip_styles(style_key)")
        .order("sort_order");
    if (error) {
        console.error("Could not load IPs", error);
        return [] as IIp[];
    }
    return data as IIp[];
};

export const getAllModes = async (supabase: SupabaseClient) => {
    const { data, error } = await supabase
        .from("modes")
        .select("*")
        .order("sort_order");
    if (error) {
        console.error("Could not load modes", error);
        return [] as IMode[];
    }
    return data as IMode[];
};

export const getAllStyles = async (supabase: SupabaseClient) => {
    const { data, error } = await supabase
        .from("styles")
        .select("*")
        .order("sort_order");
    if (error) {
        console.error("Could not load styles", error);
        return [] as IStyle[];
    }
    return data as IStyle[];
};

// Only the restrict flags restrict; rows alone never do. Same rule as
// session_content.IpRules on the voice server.
export const modesAllowedBy = (ip: IIp | undefined, modes: IMode[]) => {
    if (!ip?.restrict_modes) return modes;
    const allowed = new Set((ip.ip_modes ?? []).map((row) => row.mode_key));
    return modes.filter((mode) => allowed.has(mode.mode_key));
};

export const stylesAllowedBy = (ip: IIp | undefined, styles: IStyle[]) => {
    if (!ip?.restrict_styles) return styles;
    const allowed = new Set((ip.ip_styles ?? []).map((row) => row.style_key));
    return styles.filter((style) => allowed.has(style.style_key));
};

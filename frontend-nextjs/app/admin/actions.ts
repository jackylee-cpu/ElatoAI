"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { saveVoiceStackSettings } from "@/db/appSettings";
import { grantAdminRole, revokeAdminRole } from "@/db/adminRoles";
import {
    createBuiltinPersonality,
    updatePersonalityAsAdmin,
} from "@/db/personalities";

const PROVIDER_SORTS: OpenRouterProviderSort[] = [
    "latency",
    "throughput",
    "price",
    "nitro",
];

const REASONING_EFFORTS: OpenRouterReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
];

export type ActionResult = { ok: true } | { ok: false; error: string };

// Every action below runs with the admin's own key, never the service role:
// RLS and has_role() decide in the database, and requireAdmin() here only
// fails early with a readable message. Settings and admin roles are
// super_admin; characters and IPs are content_admin, which super_admin also
// holds.

/**
 * Point every new session at a different model.
 *
 * Existing sessions are untouched: the model is fixed when the pipeline is
 * built, exactly like the character prompt beside it. The toy picks the new one
 * up when it next reconnects.
 */
export async function saveVoiceStackAction(
    settings: IVoiceStackSettings,
): Promise<ActionResult> {
    const { supabase, user } = await requireAdmin("super_admin");

    const value: IVoiceStackSettings = {};

    const model = (settings.llm_model ?? "").trim();
    // Blank means "go back to the server's own default", which is an absent
    // key -- not an empty string. An empty string would be sent to OpenRouter
    // as the model name and fail at the API call, a long way from here.
    if (model) {
        value.llm_model = model;
    }

    const sort = settings.provider_sort;
    if (sort) {
        // The voice server raises on an unrecognised sort rather than quietly
        // falling back, so a typo saved here would break every new session.
        // Reject it while there is still someone looking at a form.
        if (!PROVIDER_SORTS.includes(sort)) {
            return { ok: false, error: `Unknown provider sort "${sort}"` };
        }
        value.provider_sort = sort;
    }

    const order = cleanProviderOrder(settings.provider_order);
    if (order === null) {
        return { ok: false, error: "Unknown provider in the preferred list" };
    }
    if (order.length > 0) {
        value.provider_order = order;
    }

    const effort = settings.reasoning_effort;
    if (effort) {
        if (!REASONING_EFFORTS.includes(effort)) {
            return { ok: false, error: `Unknown reasoning effort "${effort}"` };
        }
        value.reasoning_effort = effort;
    }

    try {
        await saveVoiceStackSettings(supabase, value, user.id);
    } catch (error) {
        console.error("saveVoiceStackAction failed", error);
        return { ok: false, error: "Could not save the settings" };
    }

    await refreshVoiceServerSettings();
    revalidatePath("/admin");
    return { ok: true };
}

const EDITABLE_FIELDS = [
    "title",
    "subtitle",
    "short_description",
    "character_prompt",
    "first_message_prompt",
    "voice_prompt",
    "oai_voice",
    "voices",
    "provider",
    "image_url",
    "is_hidden",
    "is_child_voice",
    "is_story",
    "ip_key",
    "mode_key",
    "style_key",
] as const;

export async function updatePersonalityAction(
    personalityId: string,
    updates: Partial<IPersonality>,
): Promise<ActionResult> {
    const { supabase } = await requireAdmin("content_admin");

    if (!personalityId) {
        return { ok: false, error: "Missing character id" };
    }

    const clean = pickEditable(updates);
    if (Object.keys(clean).length === 0) {
        return { ok: false, error: "Nothing to save" };
    }

    try {
        await updatePersonalityAsAdmin(supabase, personalityId, clean);
    } catch (error) {
        console.error("updatePersonalityAction failed", error);
        return { ok: false, error: "Could not save the character" };
    }

    revalidatePath("/admin");
    revalidatePath("/home");
    return { ok: true };
}

/**
 * Retire a character without deleting it.
 *
 * Deleting is not offered on purpose: users.personality_id references this row
 * with ON DELETE SET DEFAULT, so removing one would silently move every child
 * using it back to the Elato default. Hiding leaves those sessions alone.
 */
export async function setPersonalityHiddenAction(
    personalityId: string,
    isHidden: boolean,
): Promise<ActionResult> {
    return updatePersonalityAction(personalityId, { is_hidden: isHidden });
}

export async function createPersonalityAction(
    personality: Partial<IPersonality>,
): Promise<ActionResult> {
    const { supabase } = await requireAdmin("content_admin");

    const key = (personality.key ?? "").trim().toLowerCase();
    const title = (personality.title ?? "").trim();

    // `key` is UNIQUE and is what conversations.personality_key and
    // memories.source_personality_key point at, so it has to be a stable slug
    // rather than whatever was typed.
    if (!/^[a-z0-9_]+$/.test(key)) {
        return {
            ok: false,
            error: "Key must be lowercase letters, numbers and underscores",
        };
    }
    if (!title) {
        return { ok: false, error: "Title is required" };
    }

    try {
        await createBuiltinPersonality(supabase, {
            ...pickEditable(personality),
            key,
            title,
        });
    } catch (error) {
        console.error("createPersonalityAction failed", error);
        const message = String((error as { message?: string })?.message ?? "");
        if (message.includes("duplicate key")) {
            return { ok: false, error: `A character with key "${key}" already exists` };
        }
        return { ok: false, error: "Could not create the character" };
    }

    revalidatePath("/admin");
    revalidatePath("/home");
    return { ok: true };
}

const PROVIDER_SLUG = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const MAX_PREFERRED_PROVIDERS = 12;

/**
 * OpenRouter `provider.order` slugs, or null if anything in the list is junk.
 *
 * Empty is valid — it means "no preference, use the sort". A typo slug would
 * 404 every new session ("No endpoints found for the request with manual
 * order"), so it is rejected here rather than at the first spoken turn.
 */
function cleanProviderOrder(order: string[] | undefined): string[] | null {
    if (!order || order.length === 0) {
        return [];
    }
    const slugs: string[] = [];
    const seen = new Set<string>();
    for (const raw of order) {
        const slug = raw.trim().toLowerCase();
        if (!slug || seen.has(slug)) continue;
        if (!PROVIDER_SLUG.test(slug) || slugs.length >= MAX_PREFERRED_PROVIDERS) {
            return null;
        }
        seen.add(slug);
        slugs.push(slug);
    }
    return slugs;
}

function pickEditable(updates: Partial<IPersonality>): Partial<IPersonality> {
    const clean: Record<string, unknown> = {};
    for (const field of EDITABLE_FIELDS) {
        if (updates[field] !== undefined) {
            clean[field] = updates[field];
        }
    }
    if (clean.voices !== undefined) {
        clean.voices = cleanVoices(clean.voices);
    }
    return clean as Partial<IPersonality>;
}

/** language_code -> MiniMax voice id. Empty strings are dropped so clearing a
 *  field in admin actually unsets it rather than storing "". */
function cleanVoices(voices: unknown): Record<string, string> {
    if (!voices || typeof voices !== "object" || Array.isArray(voices)) {
        return {};
    }
    const allowed = new Set(["en-US", "zh-HK", "zh-CN"]);
    const clean: Record<string, string> = {};
    for (const [rawCode, rawVoice] of Object.entries(
        voices as Record<string, unknown>,
    )) {
        const code = rawCode.trim();
        if (!allowed.has(code) || typeof rawVoice !== "string") continue;
        const voice = rawVoice.trim();
        if (voice) clean[code] = voice;
    }
    return clean;
}

/**
 * Tell the voice server to forget its cached settings row.
 *
 * Best-effort, exactly like refreshDeviceSession in app/actions.ts: the cache
 * expires on its own within APP_SETTINGS_CACHE_TTL, so a failure here delays a
 * change by seconds rather than losing it.
 */
async function refreshVoiceServerSettings(): Promise<boolean> {
    const internalUrl = process.env.VOICE_SERVER_INTERNAL_URL;
    const internalToken = process.env.INTERNAL_API_TOKEN;
    if (!internalUrl || !internalToken) {
        return false;
    }

    try {
        const response = await fetch(`${internalUrl}/internal/settings_refresh`, {
            method: "POST",
            cache: "no-store",
            signal: AbortSignal.timeout(3000),
            headers: {
                "Content-Type": "application/json",
                "X-Internal-Token": internalToken,
            },
        });
        return response.ok;
    } catch (error) {
        console.warn("Could not refresh voice server settings:", error);
        return false;
    }
}

export interface IpModeDraft {
    mode_key: string;
    // Under restrict_modes: whether the IP may use this mode at all.
    allowed: boolean;
    // The IP's own flavour for the mode, added after the mode's prompt.
    prompt: string;
}

export interface IpDraft {
    ip_key: string;
    name: string;
    description: string;
    guardrails: string;
    restrict_modes: boolean;
    restrict_styles: boolean;
    is_hidden: boolean;
    sort_order: number;
    modes: IpModeDraft[];
    // Under restrict_styles: the styles the IP may use.
    style_keys: string[];
}

/**
 * Create or update an IP with what it adds to and allows in a session.
 *
 * ip_modes holds a row for a mode that is allowed (under restrict_modes) or
 * flavoured (any time); ip_styles only matters under restrict_styles. Both are
 * rewritten whole from the form, which is the whole of what the admin sees.
 * Not one transaction -- PostgREST has none -- so a failure partway is
 * reported and saving again puts it right.
 */
export async function saveIpAction(
    draft: IpDraft,
    creating: boolean,
): Promise<ActionResult> {
    const { supabase } = await requireAdmin("content_admin");

    const ipKey = draft.ip_key.trim().toLowerCase();
    const name = draft.name.trim();
    // Like a character key: memories and characters are filed under it.
    if (!/^[a-z0-9_-]+$/.test(ipKey)) {
        return {
            ok: false,
            error: "Key must be lowercase letters, numbers, - and _",
        };
    }
    if (!name) {
        return { ok: false, error: "Name is required" };
    }

    const ipRow = {
        ip_key: ipKey,
        name,
        description: draft.description.trim(),
        guardrails: draft.guardrails.trim(),
        restrict_modes: draft.restrict_modes,
        restrict_styles: draft.restrict_styles,
        is_hidden: draft.is_hidden,
        sort_order: Number.isFinite(draft.sort_order) ? Math.trunc(draft.sort_order) : 0,
    };
    const modeRows = draft.modes
        .map((mode) => ({ ...mode, prompt: mode.prompt.trim() }))
        .filter((mode) => (draft.restrict_modes ? mode.allowed : mode.prompt !== ""))
        .map((mode) => ({ ip_key: ipKey, mode_key: mode.mode_key, prompt: mode.prompt }));
    const styleRows = draft.restrict_styles
        ? Array.from(new Set(draft.style_keys)).map((style_key) => ({
              ip_key: ipKey,
              style_key,
          }))
        : [];

    if (draft.restrict_modes && modeRows.length === 0) {
        return { ok: false, error: "Allow at least one activity, or turn off the limit" };
    }

    try {
        const { data: saved, error: ipError } = creating
            ? await supabase.from("ips").insert(ipRow).select("ip_key")
            : await supabase
                  .from("ips")
                  .update(ipRow)
                  .eq("ip_key", ipKey)
                  .select("ip_key");
        if (ipError) throw ipError;
        // A refused UPDATE comes back as zero rows, not an error.
        if (!saved || saved.length === 0) throw new Error("IP not saved");

        const { error: clearModes } = await supabase
            .from("ip_modes")
            .delete()
            .eq("ip_key", ipKey);
        if (clearModes) throw clearModes;
        if (modeRows.length > 0) {
            const { error } = await supabase.from("ip_modes").insert(modeRows);
            if (error) throw error;
        }

        const { error: clearStyles } = await supabase
            .from("ip_styles")
            .delete()
            .eq("ip_key", ipKey);
        if (clearStyles) throw clearStyles;
        if (styleRows.length > 0) {
            const { error } = await supabase.from("ip_styles").insert(styleRows);
            if (error) throw error;
        }
    } catch (error) {
        console.error("saveIpAction failed", error);
        const message = String((error as { message?: string })?.message ?? "");
        if (creating && message.includes("duplicate key")) {
            return { ok: false, error: `An IP with key "${ipKey}" already exists` };
        }
        return { ok: false, error: "Could not save the IP" };
    }

    revalidatePath("/admin");
    revalidatePath("/home");
    return { ok: true };
}

const ADMIN_ROLES: AdminRole[] = ["super_admin", "content_admin"];

/** Give an existing account an admin role. */
export async function grantAdminRoleAction(
    email: string,
    role: AdminRole,
): Promise<ActionResult> {
    const { supabase } = await requireAdmin("super_admin");

    const address = email.trim().toLowerCase();
    if (!address.includes("@")) {
        return { ok: false, error: "Enter the account's email" };
    }
    if (!ADMIN_ROLES.includes(role)) {
        return { ok: false, error: `Unknown role "${role}"` };
    }

    try {
        await grantAdminRole(supabase, address, role);
    } catch (error) {
        console.error("grantAdminRoleAction failed", error);
        if ((error as { code?: string })?.code === "P0002") {
            return {
                ok: false,
                error: "No account with that email -- they need to sign up first",
            };
        }
        return { ok: false, error: "Could not grant the role" };
    }

    revalidatePath("/admin");
    return { ok: true };
}

export async function revokeAdminRoleAction(
    userId: string,
    role: AdminRole,
): Promise<ActionResult> {
    const { supabase, user } = await requireAdmin("super_admin");

    if (userId === user.id && role === "super_admin") {
        return { ok: false, error: "You cannot remove your own super admin role" };
    }

    try {
        await revokeAdminRole(supabase, userId, role);
    } catch (error) {
        console.error("revokeAdminRoleAction failed", error);
        return { ok: false, error: "Could not revoke the role" };
    }

    revalidatePath("/admin");
    return { ok: true };
}

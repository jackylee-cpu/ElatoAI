"use server";

import { revalidatePath } from "next/cache";
import { assertAdmin } from "@/lib/admin";
import { createServiceClient } from "@/utils/supabase/service";
import { saveVoiceStackSettings } from "@/db/appSettings";
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
    const admin = await assertAdmin();

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
        const supabase = createServiceClient();
        await saveVoiceStackSettings(supabase, value, admin.user_id);
    } catch (error) {
        console.error("saveVoiceStackAction failed", error);
        return { ok: false, error: "Could not save the settings" };
    }

    await refreshVoiceServerSettings();
    revalidatePath("/home/admin");
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
] as const;

export async function updatePersonalityAction(
    personalityId: string,
    updates: Partial<IPersonality>,
): Promise<ActionResult> {
    await assertAdmin();

    if (!personalityId) {
        return { ok: false, error: "Missing character id" };
    }

    const clean = pickEditable(updates);
    if (Object.keys(clean).length === 0) {
        return { ok: false, error: "Nothing to save" };
    }

    try {
        const supabase = createServiceClient();
        await updatePersonalityAsAdmin(supabase, personalityId, clean);
    } catch (error) {
        console.error("updatePersonalityAction failed", error);
        return { ok: false, error: "Could not save the character" };
    }

    revalidatePath("/home/admin");
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
    await assertAdmin();

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
        const supabase = createServiceClient();
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

    revalidatePath("/home/admin");
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

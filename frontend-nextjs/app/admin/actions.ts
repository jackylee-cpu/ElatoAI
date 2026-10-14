"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { saveUsageRates, saveVoiceStackSettings } from "@/db/appSettings";
import { grantAdminRole, revokeAdminRole } from "@/db/adminRoles";
import {
    bannedUntil,
    createAccount,
    getAuthUser,
    syncProfileEmail,
    updateAccountLogin,
} from "@/db/accounts";
import { createServiceClient } from "@/utils/supabase/service";
import { MIN_PASSWORD_LENGTH } from "@/lib/passwords";
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
// holds. Creating or editing a login is the exception: GoTrue only lets the
// service role write auth.users, so there requireAdmin() is the whole gate.
// Deleting one is not -- admin_delete_account() checks super_admin itself.

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

/** Take an IP off the playground, or put it back. The row stays. */
export async function setIpHiddenAction(
    ipKey: string,
    isHidden: boolean,
): Promise<ActionResult> {
    const { supabase } = await requireAdmin("content_admin");

    const key = ipKey.trim().toLowerCase();
    if (!key) {
        return { ok: false, error: "Missing IP" };
    }

    const { data, error } = await supabase
        .from("ips")
        .update({ is_hidden: isHidden })
        .eq("ip_key", key)
        .select("ip_key");
    if (error || !data || data.length === 0) {
        console.error("setIpHiddenAction failed", error);
        return { ok: false, error: "Could not change the IP" };
    }

    revalidatePath("/admin");
    revalidatePath("/home");
    return { ok: true };
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
    // Who a board in this toy is when the account's character is elsewhere.
    default_personality_id: string | null;
    modes: IpModeDraft[];
    // Under restrict_styles: the styles the IP may use.
    style_keys: string[];
}

/**
 * Create or update an IP with what it adds to and allows in a session.
 *
 * ip_modes holds a row for a mode that is allowed (under restrict_modes) or
 * flavoured (any time); ip_styles only matters under restrict_styles. The form
 * is the whole of what the admin sees, so the rows end up exactly as it says
 * -- but only the rows that differ are written. Every write lands in the
 * audit log (P1-10), and rewriting them all would record a change on every
 * save. Not one transaction -- PostgREST has none -- so a failure partway is
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
        default_personality_id: draft.default_personality_id || null,
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

    // A toy's default has to be one of its own characters, or a board in the
    // rabbit would fall back to some other animal.
    if (ipRow.default_personality_id) {
        const { data: own } = await supabase
            .from("personalities")
            .select("personality_id")
            .eq("personality_id", ipRow.default_personality_id)
            .eq("ip_key", ipKey)
            .maybeSingle();
        if (!own) {
            return { ok: false, error: "The default character must be one of this IP's characters" };
        }
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

        const { data: currentModes, error: readModes } = await supabase
            .from("ip_modes")
            .select("mode_key, prompt")
            .eq("ip_key", ipKey);
        if (readModes) throw readModes;
        const wantedModes = new Map(modeRows.map((row) => [row.mode_key, row.prompt]));
        const droppedModes = (currentModes ?? [])
            .map((row) => row.mode_key as string)
            .filter((modeKey) => !wantedModes.has(modeKey));
        const changedModes = modeRows.filter(
            (row) =>
                !(currentModes ?? []).some(
                    (current) =>
                        current.mode_key === row.mode_key && current.prompt === row.prompt
                )
        );
        if (droppedModes.length > 0) {
            const { error } = await supabase
                .from("ip_modes")
                .delete()
                .eq("ip_key", ipKey)
                .in("mode_key", droppedModes);
            if (error) throw error;
        }
        if (changedModes.length > 0) {
            const { error } = await supabase
                .from("ip_modes")
                .upsert(changedModes, { onConflict: "ip_key,mode_key" });
            if (error) throw error;
        }

        const { data: currentStyles, error: readStyles } = await supabase
            .from("ip_styles")
            .select("style_key")
            .eq("ip_key", ipKey);
        if (readStyles) throw readStyles;
        const haveStyles = new Set((currentStyles ?? []).map((row) => row.style_key as string));
        const wantedStyles = new Set(styleRows.map((row) => row.style_key));
        const droppedStyles = Array.from(haveStyles).filter((key) => !wantedStyles.has(key));
        const addedStyles = styleRows.filter((row) => !haveStyles.has(row.style_key));
        if (droppedStyles.length > 0) {
            const { error } = await supabase
                .from("ip_styles")
                .delete()
                .eq("ip_key", ipKey)
                .in("style_key", droppedStyles);
            if (error) throw error;
        }
        if (addedStyles.length > 0) {
            const { error } = await supabase.from("ip_styles").insert(addedStyles);
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

export type CreateAccountResult =
    | { ok: true; userId: string; roleError?: string }
    | { ok: false; error: string };

/**
 * Create a login for someone -- a family we are setting up, a tester -- that
 * works at once, without the confirmation email self sign-up needs.
 *
 * Optionally grants an admin role in the same step. That part runs with the
 * admin's own key like grantAdminRoleAction; if it fails the account still
 * exists, and the result says so rather than reporting the whole thing failed.
 */
export async function createAccountAction(
    email: string,
    password: string,
    role: AdminRole | null,
): Promise<CreateAccountResult> {
    const { supabase } = await requireAdmin("super_admin");

    const address = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
        return { ok: false, error: "Enter a valid email address" };
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
        return {
            ok: false,
            error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        };
    }
    if (role !== null && !ADMIN_ROLES.includes(role)) {
        return { ok: false, error: `Unknown role "${role}"` };
    }

    let userId: string;
    try {
        userId = await createAccount(createServiceClient(), address, password);
    } catch (error) {
        console.error("createAccountAction failed", error);
        return { ok: false, error: accountAuthError(error, "Could not create the account") };
    }

    // GoTrue writes auth.users with the service role, so no trigger of ours
    // sees this; the record goes in by hand, under the admin's own key. The
    // password is never part of it.
    const { error: auditError } = await supabase.rpc("admin_audit_record", {
        p_action: "account.create",
        p_target_table: "auth.users",
        p_target_id: userId,
        p_target_label: address,
        p_after: { email: address, role },
    });
    if (auditError) {
        console.error("createAccountAction: audit record failed", auditError);
    }

    let roleError: string | undefined;
    if (role !== null) {
        try {
            await grantAdminRole(supabase, address, role);
        } catch (error) {
            console.error("createAccountAction: grant failed", error);
            roleError = "Account created, but the role could not be granted";
        }
    }

    revalidatePath("/admin");
    return { ok: true, userId, roleError };
}

const ACCOUNT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Far enough out that "Disabled" means they cannot sign in. 'none' lifts it.
const BAN_DURATION = "876000h";

export type AccountStatusChoice = "active" | "unconfirmed" | "disabled";

export type UpdateAccountResult =
    | { ok: true; roleError?: string }
    | { ok: false; error: string };

function accountAuthError(error: unknown, fallback: string): string {
    const { code, message } = error as { code?: string; message?: string };
    if (
        code === "email_exists" ||
        code === "user_already_exists" ||
        /already (been )?registered/i.test(message ?? "")
    ) {
        return "An account with that email already exists";
    }
    if (code === "weak_password") {
        return message ?? "That password is too weak";
    }
    if (code === "email_address_invalid" || code === "validation_failed") {
        return "Enter a valid email address";
    }
    return fallback;
}

function isDisabled(until: string | null | undefined, now = Date.now()): boolean {
    if (!until) return false;
    const time = new Date(until).getTime();
    return Number.isFinite(time) && time > now;
}

function statusOf(confirmed: boolean, until: string | null | undefined): AccountStatusChoice {
    if (isDisabled(until)) return "disabled";
    if (!confirmed) return "unconfirmed";
    return "active";
}

/**
 * Change a login's email, password, whether it can sign in, and its admin role.
 *
 * The password is never written to the audit log. A role change is recorded
 * by the admin_roles trigger; email, password and status are recorded here,
 * because GoTrue writes auth.users with the service role and that trigger
 * never sees it.
 */
export async function updateAccountAction(
    userId: string,
    email: string,
    password: string,
    role: AdminRole | null,
    status: AccountStatusChoice,
): Promise<UpdateAccountResult> {
    const { supabase, user } = await requireAdmin("super_admin");

    if (!ACCOUNT_ID.test(userId)) {
        return { ok: false, error: "No such account" };
    }
    const address = email.trim().toLowerCase();
    if (!ACCOUNT_EMAIL.test(address)) {
        return { ok: false, error: "Enter a valid email address" };
    }
    if (password !== "" && password.length < MIN_PASSWORD_LENGTH) {
        return {
            ok: false,
            error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        };
    }
    if (role !== null && !ADMIN_ROLES.includes(role)) {
        return { ok: false, error: `Unknown role "${role}"` };
    }
    if (status !== "active" && status !== "unconfirmed" && status !== "disabled") {
        return { ok: false, error: "Unknown status" };
    }
    if (userId === user.id && status === "disabled") {
        return { ok: false, error: "You cannot disable your own account" };
    }
    if (userId === user.id && role !== "super_admin") {
        return { ok: false, error: "You cannot change your own super admin role" };
    }

    const service = createServiceClient();
    let existing;
    try {
        existing = await getAuthUser(service, userId);
    } catch (error) {
        console.error("updateAccountAction: read failed", error);
        return { ok: false, error: "Could not load the account" };
    }
    if (!existing) {
        return { ok: false, error: "No such account" };
    }

    const currentEmail = (existing.email ?? "").toLowerCase();
    const currentStatus = statusOf(Boolean(existing.email_confirmed_at), bannedUntil(existing));
    if (status === "unconfirmed" && existing.email_confirmed_at) {
        return { ok: false, error: "A confirmed account cannot be set back to unconfirmed" };
    }

    const { data: roleRows, error: roleReadError } = await supabase
        .from("admin_roles")
        .select("role")
        .eq("user_id", userId);
    if (roleReadError) {
        console.error("updateAccountAction: roles failed", roleReadError);
        return { ok: false, error: "Could not load the account" };
    }
    const have = new Set((roleRows ?? []).map((row) => row.role as AdminRole));
    // The select is the whole of the account's roles, so an account that
    // somehow holds both is saved as just the one on screen.
    const want = new Set(role === null ? [] : [role]);
    const roleChanged = have.size !== want.size || Array.from(want).some((item) => !have.has(item));

    const emailChanged = address !== currentEmail;
    const statusChanged = status !== currentStatus;
    const passwordChanged = password !== "";
    if (!emailChanged && !statusChanged && !passwordChanged && !roleChanged) {
        return { ok: false, error: "Nothing to save" };
    }

    if (emailChanged || statusChanged || passwordChanged) {
        const attributes: {
            email?: string;
            password?: string;
            email_confirm?: boolean;
            ban_duration?: string;
        } = {};
        if (emailChanged) attributes.email = address;
        if (passwordChanged) attributes.password = password;
        // A new address, or "Active" on an account that never confirmed, has
        // to be confirmed here or the next sign-in waits for a mail we do
        // not send.
        if ((emailChanged && status !== "unconfirmed") || (status === "active" && !existing.email_confirmed_at)) {
            attributes.email_confirm = true;
        }
        if (status === "disabled" && currentStatus !== "disabled") {
            attributes.ban_duration = BAN_DURATION;
        }
        if (status !== "disabled" && currentStatus === "disabled") {
            attributes.ban_duration = "none";
        }
        try {
            await updateAccountLogin(service, userId, attributes);
        } catch (error) {
            console.error("updateAccountAction failed", error);
            return { ok: false, error: accountAuthError(error, "Could not save the account") };
        }

        if (emailChanged) {
            try {
                await syncProfileEmail(service, userId, address);
            } catch (error) {
                console.error("updateAccountAction: profile email failed", error);
            }
        }

        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        if (emailChanged) {
            before.email = currentEmail;
            after.email = address;
        }
        if (statusChanged) {
            before.status = currentStatus;
            after.status = status;
        }
        if (passwordChanged) after.password_reset = true;
        const { error: auditError } = await supabase.rpc("admin_audit_record", {
            p_action: "account.update",
            p_target_table: "auth.users",
            p_target_id: userId,
            p_target_label: address,
            p_before: before,
            p_after: after,
        });
        if (auditError) {
            console.error("updateAccountAction: audit record failed", auditError);
        }
    }

    let roleError: string | undefined;
    if (roleChanged) {
        const profileSaved = emailChanged || statusChanged || passwordChanged;
        try {
            await syncAccountRole(supabase, userId, address, role, have);
        } catch (error) {
            console.error("updateAccountAction: role failed", error);
            if (!profileSaved) {
                const code = (error as { code?: string }).code;
                if (code === "42501") {
                    return { ok: false, error: "You cannot change your own super admin role" };
                }
                return { ok: false, error: "Could not change the role" };
            }
            roleError = "Saved, but the role could not be changed";
        }
    }

    revalidatePath("/admin");
    return { ok: true, roleError };
}

/** Make the account hold exactly the role the form asked for. */
async function syncAccountRole(
    supabase: Awaited<ReturnType<typeof requireAdmin>>["supabase"],
    userId: string,
    email: string,
    role: AdminRole | null,
    have: Set<AdminRole>,
): Promise<void> {
    if (role === "super_admin") {
        if (!have.has("super_admin")) await grantAdminRole(supabase, email, "super_admin");
        if (have.has("content_admin")) await revokeAdminRole(supabase, userId, "content_admin");
        return;
    }
    if (have.has("super_admin")) await revokeAdminRole(supabase, userId, "super_admin");
    if (role === "content_admin") {
        if (!have.has("content_admin")) await grantAdminRole(supabase, email, "content_admin");
        return;
    }
    if (have.has("content_admin")) await revokeAdminRole(supabase, userId, "content_admin");
}

/**
 * Remove a login and everything that belongs to it.
 *
 * The database does the delete and writes the audit record in one
 * transaction. Toys that were bound are then dropped from the voice server
 * so an online one goes back to pairing within seconds.
 */
export async function deleteAccountAction(
    userId: string,
    reason: string,
): Promise<ActionResult> {
    const { supabase, user } = await requireAdmin("super_admin");

    if (!ACCOUNT_ID.test(userId)) {
        return { ok: false, error: "No such account" };
    }
    if (userId === user.id) {
        return { ok: false, error: "You cannot delete your own account" };
    }
    const why = cleanReason(reason);
    if (!why) {
        return { ok: false, error: `Give a reason, up to ${MAX_REASON_LENGTH} characters` };
    }

    const { data, error } = await supabase.rpc("admin_delete_account", {
        p_user_id: userId,
        p_reason: why,
    });
    if (error) {
        console.error("deleteAccountAction failed", error);
        return { ok: false, error: accountDeleteError(error) };
    }

    const macs = ((data ?? []) as { mac_address: string | null }[])
        .map((row) => row.mac_address)
        .filter((mac): mac is string => Boolean(mac));
    await Promise.all(macs.map((mac) => dropBoardSession(mac)));

    revalidatePath("/admin");
    return { ok: true };
}

function accountDeleteError(error: unknown): string {
    const { code, message } = error as { code?: string; message?: string };
    if (code === "42501") {
        if (message?.includes("own account")) return "You cannot delete your own account";
        if (message?.includes("last super")) return "You cannot delete the last super admin";
        return "Only a super admin can do that";
    }
    if (code === "22023") return `Give a reason, up to ${MAX_REASON_LENGTH} characters`;
    if (code === "P0002") return "No such account";
    return "Could not delete the account";
}

/**
 * The STT, TTS and exchange rates the Usage page prices with. LLM prices are
 * not here: they come from OpenRouter's catalogue for each model.
 *
 * Stored under app_settings 'usage_rates', so a corrected rate reprices every
 * month at once, and the change is in the audit log like any other setting.
 */
export async function saveUsageRatesAction(rates: IUsageRates): Promise<ActionResult> {
    const { supabase, user } = await requireAdmin("super_admin");

    const value: IUsageRates = {
        stt_usd_per_hour: Number(rates.stt_usd_per_hour),
        tts_usd_per_million_chars: Number(rates.tts_usd_per_million_chars),
        usd_to_hkd: Number(rates.usd_to_hkd),
    };
    if (Object.values(value).some((rate) => !Number.isFinite(rate) || rate < 0)) {
        return { ok: false, error: "Rates must be numbers, zero or more" };
    }
    if (value.usd_to_hkd === 0) {
        return { ok: false, error: "The exchange rate cannot be zero" };
    }

    try {
        await saveUsageRates(supabase, value, user.id);
    } catch (error) {
        console.error("saveUsageRatesAction failed", error);
        return { ok: false, error: "Could not save the rates" };
    }

    revalidatePath("/admin");
    return { ok: true };
}

const MAX_REASON_LENGTH = 500;

function cleanReason(reason: string): string | null {
    const clean = reason.trim();
    return clean && clean.length <= MAX_REASON_LENGTH ? clean : null;
}

/** Close one board's voice session; it reconnects about a second later. */
async function dropBoardSession(mac: string): Promise<boolean> {
    const internalUrl = process.env.VOICE_SERVER_INTERNAL_URL;
    const internalToken = process.env.INTERNAL_API_TOKEN;
    if (!internalUrl || !internalToken) {
        return false;
    }
    try {
        const response = await fetch(`${internalUrl}/internal/device_refresh`, {
            method: "POST",
            cache: "no-store",
            signal: AbortSignal.timeout(3000),
            headers: {
                "Content-Type": "application/json",
                "X-Internal-Token": internalToken,
            },
            body: JSON.stringify({ mac }),
        });
        return response.ok;
    } catch (error) {
        console.warn("Could not drop the board's session:", error);
        return false;
    }
}

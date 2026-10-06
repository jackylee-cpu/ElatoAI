"use server";

import { encodedRedirect } from "@/utils/utils";
import { createClient } from "@/utils/supabase/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
    addUserToDevice,
    claimDevice,
    dbCheckUserCode,
    getUnclaimedDevices,
    unbindDevice,
} from "@/db/devices";
import { getSimpleUserById } from "@/db/users";

export async function deleteUserApiKey(userId: string) {
    const supabase = createClient();
    const { error } = await supabase.from("api_keys").delete().eq(
        "user_id",
        userId,
    );
    return error;
}

export const signInAction = async (formData: FormData) => {
    const email = formData.get("email") as string;
    const password = formData.get("password") as string;
    const supabase = createClient();

    const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
    });

    if (error) {
        return encodedRedirect("error", "/login", error.message);
    }

    return redirect("/home");
};

export const forgotPasswordAction = async (formData: FormData) => {
    const email = formData.get("email")?.toString();
    const supabase = createClient();
    const origin = headers().get("origin");
    const callbackUrl = formData.get("callbackUrl")?.toString();

    if (!email) {
        return encodedRedirect(
            "error",
            "/forgot-password",
            "Email is required",
        );
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo:
            `${origin}/auth/callback?redirect_to=/protected/reset-password`,
    });

    if (error) {
        console.error(error.message);
        return encodedRedirect(
            "error",
            "/forgot-password",
            "Could not reset password",
        );
    }

    if (callbackUrl) {
        return redirect(callbackUrl);
    }

    return encodedRedirect(
        "success",
        "/forgot-password",
        "Check your email for a link to reset your password.",
    );
};

export const resetPasswordAction = async (formData: FormData) => {
    const supabase = createClient();

    const password = formData.get("password") as string;
    const confirmPassword = formData.get("confirmPassword") as string;

    if (!password || !confirmPassword) {
        encodedRedirect(
            "error",
            "/protected/reset-password",
            "Password and confirm password are required",
        );
    }

    if (password !== confirmPassword) {
        encodedRedirect(
            "error",
            "/protected/reset-password",
            "Passwords do not match",
        );
    }

    const { error } = await supabase.auth.updateUser({
        password: password,
    });

    if (error) {
        encodedRedirect(
            "error",
            "/protected/reset-password",
            "Password update failed",
        );
    }

    encodedRedirect("success", "/protected/reset-password", "Password updated");
};

export const signOutAction = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    return redirect("/login");
};

export const checkDoctorAction = async (authCode: string) => {
    return authCode === "kiwi-subtle-emu";
};

export const connectUserToDevice = async (
    userId: string,
    userDeviceCode: string,
) => {
    const supabase = createClient();

    // Codes get copied off a screen, so normalise once and use the same value
    // for both the check and the write -- these used to disagree, which let a
    // code with stray whitespace validate and then silently match no rows.
    const code = userDeviceCode.trim().toUpperCase();

    const isCodeValid = await dbCheckUserCode(supabase, code);
    if (!isCodeValid) {
        return false;
    }

    return await addUserToDevice(supabase, code, userId);
};

/** Devices that are online but unowned, for the claim list in Settings. */
export const listUnclaimedDevices = async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return [];
    }
    return await getUnclaimedDevices(supabase);
};

/**
 * Bind a device to the signed-in account. The user id comes from the session,
 * never from the caller.
 */
export const claimDeviceAction = async (deviceId: string) => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return false;
    }
    return await claimDevice(supabase, deviceId, user.id);
};

export const unbindDeviceAction = async (deviceId: string) => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return false;
    }
    return await unbindDevice(supabase, deviceId, user.id);
};

/**
 * Ask the voice server to drop this account's device session.
 *
 * The character is baked into the LLM system prompt when the pipeline is built,
 * so it can only change on a fresh connection. The firmware reconnects about a
 * second after any drop and the server re-reads the personality then, which is
 * what makes a character switch land on the device almost immediately.
 *
 * Best effort: if the voice server is unreachable the character still applies
 * the next time the device connects, so never let this failure surface as a
 * failed save.
 */
export const refreshDeviceSession = async () => {
    const internalUrl = process.env.VOICE_SERVER_INTERNAL_URL;
    const internalToken = process.env.INTERNAL_API_TOKEN;
    if (!internalUrl || !internalToken) {
        return false;
    }

    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return false;
    }

    const { data } = await supabase
        .from("devices")
        .select("mac_address")
        .eq("user_id", user.id)
        .maybeSingle();

    if (!data?.mac_address) {
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
            body: JSON.stringify({ mac: data.mac_address }),
        });
        return response.ok;
    } catch {
        return false;
    }
};

/**
 * Make a memory deletion take effect on a device that is talking right now.
 *
 * The voice server reads a child's facts and recent notes into the prompt once,
 * when a session starts. Dropping the device session makes it start again
 * within about a second, without what was just deleted, instead of whenever the
 * toy next wakes up. Reuses the same mechanism a character switch already goes
 * through.
 */
export const invalidateMemories = async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return false;
    }

    await refreshDeviceSession();
    return true;
};

export const fetchGithubStars = async (repo: string) => {
    try {
        const response = await fetch(`https://api.github.com/repos/${repo}`, {
            headers: {
                Accept: "application/vnd.github.v3+json",
            },
            next: {
                revalidate: 3600,
            },
        });

        if (!response.ok) {
            throw new Error(`GitHub API error: ${response.statusText}`);
        }

        const data = await response.json();
        return {
            stars: data.stargazers_count,
            error: null,
        };
    } catch (error) {
        console.error("Error fetching GitHub stats:", error);
        return {
            stars: null,
            error: "Failed to load GitHub stats",
        };
    }
};

export const isPremiumUser = async (userId: string) => {
    const supabase = createClient();
    const dbUser = await getSimpleUserById(supabase, userId);
    return dbUser?.is_premium;
};

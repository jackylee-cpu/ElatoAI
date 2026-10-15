"use server";

import { encodedRedirect } from "@/utils/utils";
import { createClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { signWebVoiceToken } from "@/lib/deviceAuth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
    claimDevice,
    getUnclaimedDevices,
    unbindDevice,
} from "@/db/devices";
import { clearDeviceMemory } from "@/db/memories";
import { getSimpleUserById } from "@/db/users";
import type { DeviceWifiState, WifiOp } from "@/lib/deviceWifi";

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
            `${origin}/auth/callback?redirect_to=/home/account/password`,
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

/**
 * Sets a new password for the signed-in user. Used from Me > Personal Info and
 * at the end of the forgot-password email, whose link signs the user in first.
 * Returns the error to show instead of redirecting, so the form keeps its place.
 */
export const changePasswordAction = async (
    password: string,
    confirmPassword: string,
): Promise<{ error?: string }> => {
    if (!password || !confirmPassword) {
        return { error: "Please fill in both fields." };
    }
    if (password !== confirmPassword) {
        return { error: "The passwords do not match." };
    }

    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
        // Supabase's messages here are meant for users ("Password should be at
        // least 6 characters", "New password should be different...").
        return { error: error.message };
    }
    return {};
};

export const signOutAction = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    return redirect("/login");
};

/*
 * Binding and unbinding write `devices.user_id`, which the
 * signed-in client is not granted (migration 20261007130000): an owner can only
 * read their own devices and change their volume. So these actions take the
 * user from the session and do the write with the service role.
 */

/**
 * Development only: claiming from a list of every unowned board online, with
 * no proof of holding it. In production a board is claimed with a bind ticket
 * (/api/device_bind_ticket, P0-11), so these do nothing unless
 * DEVICE_CLAIM_LIST=True.
 */
const claimListEnabled = () => process.env.DEVICE_CLAIM_LIST === "True";

/** Devices that are online but unowned, or null when the claim list is off. */
export const listUnclaimedDevices = async () => {
    if (!claimListEnabled()) {
        return null;
    }
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return [];
    }
    return await getUnclaimedDevices(createServiceClient());
};

/**
 * Bind a device from the claim list to the signed-in account. The user id
 * comes from the session, never from the caller.
 */
export const claimDeviceAction = async (deviceId: string) => {
    if (!claimListEnabled()) {
        return false;
    }
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return false;
    }
    return await claimDevice(createServiceClient(), deviceId, user.id);
};

/**
 * Release one of the signed-in account's devices, erasing what it remembers
 * when `clearMemory` is set. Then drop its live session: the voice server
 * refuses an unclaimed board on reconnect, so it stops talking now and goes
 * back to waiting to be paired, instead of carrying on until its token runs out.
 */
export const unbindDeviceAction = async (deviceId: string, clearMemory = false) => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return false;
    }
    const mac = await unbindDevice(createServiceClient(), deviceId, user.id, clearMemory);
    if (!mac) {
        return false;
    }
    await dropDeviceSessions([mac]);
    return true;
};

/**
 * Erase everything one of the signed-in account's devices remembers, and drop
 * its live session so it starts again with nothing in mind.
 */
export const clearDeviceMemoryAction = async (deviceId: string) => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return false;
    }
    const service = createServiceClient();
    if (!await clearDeviceMemory(service, user.id, deviceId)) {
        return false;
    }
    const { data } = await service
        .from("devices")
        .select("mac_address")
        .eq("device_id", deviceId)
        .eq("user_id", user.id)
        .maybeSingle();
    if (data?.mac_address) {
        await dropDeviceSessions([data.mac_address]);
    }
    return true;
};

/**
 * A five-minute ticket for the voice server's /ws/nextjs, for whoever is
 * signed in. The browser asks for a fresh one each time it opens the socket.
 * Null when there is no session.
 */
export const createVoiceSessionToken = async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return null;
    }
    return signWebVoiceToken(user.id);
};

/**
 * Ask the voice server to drop the sessions of every device on this account.
 *
 * The character is baked into the LLM system prompt when the pipeline is built,
 * so it can only change on a fresh connection. The firmware reconnects about a
 * second after any drop and the server re-reads the personality then, which is
 * what makes a character switch land on the devices almost immediately. An
 * account can own several boards and they all share its character, so all of
 * them are dropped.
 *
 * Best effort: if the voice server is unreachable the character still applies
 * the next time each device connects, so never let this failure surface as a
 * failed save.
 */
export const refreshDeviceSession = async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return false;
    }

    const { data } = await supabase
        .from("devices")
        .select("mac_address")
        .eq("user_id", user.id);

    const macs = (data ?? [])
        .map((device) => device.mac_address)
        .filter((mac): mac is string => !!mac);
    return await dropDeviceSessions(macs);
};

/**
 * Read or change a board's saved Wi-Fi networks (R-37), relayed by the voice
 * server over the board's live socket.
 *
 * Ownership is checked here, with the signed-in client: RLS only lets a parent
 * read their own devices, so a device id that is not theirs finds no row. The
 * password goes straight through to the board and is not stored or logged on
 * the way.
 */
export const deviceWifiAction = async (
    deviceId: string,
    op: WifiOp,
    ssid?: string,
    password?: string,
): Promise<DeviceWifiState> => {
    const failed = (error: string): DeviceWifiState => ({
        online: false,
        status: null,
        status_at: null,
        ok: false,
        error,
    });

    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return failed("forbidden");
    }
    const { data: device } = await supabase
        .from("devices")
        .select("mac_address")
        .eq("device_id", deviceId)
        .eq("user_id", user.id)
        .maybeSingle();
    if (!device?.mac_address) {
        return failed("forbidden");
    }

    const internalUrl = process.env.VOICE_SERVER_INTERNAL_URL;
    const internalToken = process.env.INTERNAL_API_TOKEN;
    if (!internalUrl || !internalToken) {
        return failed("unavailable");
    }

    try {
        const response = await fetch(`${internalUrl}/internal/device_wifi`, {
            method: "POST",
            cache: "no-store",
            // The server waits up to 20s for the board; a scan takes a few.
            signal: AbortSignal.timeout(25_000),
            headers: {
                "Content-Type": "application/json",
                "X-Internal-Token": internalToken,
            },
            body: JSON.stringify({ mac: device.mac_address, op, ssid, password }),
        });
        if (response.status === 400) {
            return failed("invalid");
        }
        if (!response.ok) {
            return failed("unavailable");
        }
        return (await response.json()) as DeviceWifiState;
    } catch {
        // Deliberately not logged: the error can carry the request body.
        return failed("unavailable");
    }
};

/**
 * Save a board's volume and bring it to that level now if it is connected.
 *
 * devices.volume is what the board gets in its auth frame, but only on
 * connect, and a board stays connected until it sleeps -- so the voice server
 * also passes the level to a live session (server/fastapi/device_volume.py).
 * The save is what matters; reaching a live board is best effort. The update
 * runs as the signed-in user, whose RLS grant covers volume on their own
 * boards, and the mac comes back from that same write.
 */
export const setDeviceVolumeAction = async (deviceId: string, volume: number) => {
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
        return false;
    }
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return false;
    }
    const { data: device, error } = await supabase
        .from("devices")
        .update({ volume })
        .eq("device_id", deviceId)
        .eq("user_id", user.id)
        .select("mac_address")
        .maybeSingle();
    if (error || !device) {
        return false;
    }

    const internalUrl = process.env.VOICE_SERVER_INTERNAL_URL;
    const internalToken = process.env.INTERNAL_API_TOKEN;
    if (internalUrl && internalToken && device.mac_address) {
        try {
            await fetch(`${internalUrl}/internal/device_volume`, {
                method: "POST",
                cache: "no-store",
                signal: AbortSignal.timeout(3000),
                headers: {
                    "Content-Type": "application/json",
                    "X-Internal-Token": internalToken,
                },
                body: JSON.stringify({ mac: device.mac_address, volume }),
            });
        } catch {
            // Saved; the board picks it up when it next connects.
        }
    }
    return true;
};

/**
 * Close these boards' voice sessions; each reconnects about a second later and
 * re-reads everything about itself. Best effort, like every caller: true only
 * when the voice server confirmed every one.
 */
const dropDeviceSessions = async (macs: string[]) => {
    const internalUrl = process.env.VOICE_SERVER_INTERNAL_URL;
    const internalToken = process.env.INTERNAL_API_TOKEN;
    if (!internalUrl || !internalToken || macs.length === 0) {
        return false;
    }

    const results = await Promise.all(macs.map(async (mac) => {
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
        } catch {
            return false;
        }
    }));
    return results.every(Boolean);
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

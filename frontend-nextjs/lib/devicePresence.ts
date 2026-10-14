import type { DeviceWifiState } from "@/lib/deviceWifi";

/** One board as the voice server sees it (P2-14). */
export type DevicePresence = Pick<DeviceWifiState, "online" | "status" | "status_at"> & {
    /** Seconds since the epoch the current session began; null when offline. */
    connected_at: number | null;
};

/** By upper-case MAC; null when the voice server could not be asked. */
export type PresenceMap = Record<string, DevicePresence> | null;

/**
 * Which boards have a live voice session, from the voice server's memory.
 * Server-side only: it carries the internal token. Callers check the admin
 * role first.
 *
 * Null rather than an empty map on failure, so the page can say "unknown"
 * instead of showing every toy as offline.
 */
export async function fetchDevicePresence(): Promise<PresenceMap> {
    const internalUrl = process.env.VOICE_SERVER_INTERNAL_URL;
    const internalToken = process.env.INTERNAL_API_TOKEN;
    if (!internalUrl || !internalToken) {
        return null;
    }
    try {
        const response = await fetch(`${internalUrl}/internal/devices_presence`, {
            method: "POST",
            cache: "no-store",
            signal: AbortSignal.timeout(3000),
            headers: { "X-Internal-Token": internalToken },
        });
        if (!response.ok) {
            return null;
        }
        const body = (await response.json()) as { devices?: Record<string, DevicePresence> };
        return body.devices ?? {};
    } catch (error) {
        console.warn("Could not read device presence:", error);
        return null;
    }
}

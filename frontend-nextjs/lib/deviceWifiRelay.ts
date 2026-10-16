import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeviceWifiState, WifiOp } from "@/lib/deviceWifi";

export const wifiFailure = (error: string): DeviceWifiState => ({
    online: false,
    status: null,
    status_at: null,
    ok: false,
    error,
});

/**
 * Pass a Wi-Fi request to the voice server, which relays it to the board
 * (R-37). Server-side only: it carries the internal token. Callers check that
 * the signed-in parent owns the board first.
 *
 * The password goes straight through and is not stored or logged on the way.
 */
export async function relayDeviceWifi(
    mac: string,
    request: { op: WifiOp; ssid?: string; password?: string; fresh?: boolean },
    timeoutMs: number,
): Promise<DeviceWifiState> {
    const internalUrl = process.env.VOICE_SERVER_INTERNAL_URL;
    const internalToken = process.env.INTERNAL_API_TOKEN;
    if (!internalUrl || !internalToken) {
        return wifiFailure("unavailable");
    }

    try {
        const response = await fetch(`${internalUrl}/internal/device_wifi`, {
            method: "POST",
            cache: "no-store",
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
                "Content-Type": "application/json",
                "X-Internal-Token": internalToken,
            },
            body: JSON.stringify({ mac, ...request }),
        });
        if (response.status === 400) {
            return wifiFailure("invalid");
        }
        if (!response.ok) {
            return wifiFailure("unavailable");
        }
        return (await response.json()) as DeviceWifiState;
    } catch {
        // Deliberately not logged: the error can carry the request body.
        return wifiFailure("unavailable");
    }
}

type RecordedWifi = Pick<DeviceWifiState, "status" | "status_at">;

/**
 * The board's last report as the voice server recorded it in device_wifi
 * (migration 20261016120000), read as the signed-in parent: RLS returns only
 * their own boards' rows. Null when the board has never reported.
 *
 * The voice server's memory has the same list while the board is awake, but
 * forgets it on every restart; this row is what a sleeping board's page shows.
 */
export async function readRecordedWifi(
    supabase: SupabaseClient,
    deviceId: string,
): Promise<RecordedWifi | null> {
    const { data } = await supabase
        .from("device_wifi")
        .select("current_ssid, current_rssi, saved, max_saved, reported_at")
        .eq("device_id", deviceId)
        .maybeSingle();
    if (!data) {
        return null;
    }
    const saved = Array.isArray(data.saved)
        ? (data.saved as { ssid?: unknown; joined?: unknown }[])
            .filter((item) => typeof item?.ssid === "string")
            .map((item) => ({ ssid: item.ssid as string, joined: item.joined === true }))
        : [];
    return {
        status: {
            current: data.current_ssid
                ? { ssid: data.current_ssid, rssi: data.current_rssi ?? null }
                : null,
            saved,
            max: data.max_saved ?? null,
        },
        status_at: Date.parse(data.reported_at) / 1000,
    };
}

/** The voice server's answer, with the recorded list filled in when it has none. */
export function withRecorded(
    state: DeviceWifiState,
    recorded: RecordedWifi | null,
): DeviceWifiState {
    return state.status || !recorded ? state : { ...state, ...recorded };
}

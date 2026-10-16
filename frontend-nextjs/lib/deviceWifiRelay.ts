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

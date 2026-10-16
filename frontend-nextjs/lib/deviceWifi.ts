// Shapes of the board's Wi-Fi state as the voice server relays it (R-37).
// Only names and signal: passwords never come back from the board.

export type WifiOp = "status" | "peek" | "add" | "delete" | "scan" | "switch";

/** How the board's last move to another saved Wi-Fi ended. */
export interface WifiSwitchResult {
    ssid: string;
    ok: boolean;
    /** not_found | auth | timeout | no_internet | failed */
    error?: string;
    /** The network it went back to after a failed move. */
    back?: string;
    /** Seconds since the epoch the board reported it, on the voice server's clock. */
    at: number;
}

export interface DeviceWifiState {
    /** The board has a live voice socket and can take changes now. */
    online: boolean;
    /** What the board last reported; null if it has not since the server started. */
    status: {
        current: { ssid: string; rssi: number | null } | null;
        saved: { ssid: string; joined: boolean }[];
        max: number | null;
    } | null;
    /** Seconds since the epoch of that report. */
    status_at: number | null;
    /** The last switch's outcome; it arrives once the board is back online. */
    last_switch?: WifiSwitchResult | null;
    /**
     * Whether the board's firmware reports its Wi-Fi at all: false once it has
     * been online a while without a report (older than R-37), true once it
     * reported on this connection, null when that cannot be told yet.
     */
    reports_wifi?: boolean | null;
    /** A "switch" was taken: the board is moving and drops offline for a while. */
    switching?: boolean;
    ok: boolean;
    /** offline | unsupported | timeout | busy | full | current | unknown | invalid | scan | failed | forbidden | unavailable */
    error?: string;
    networks?: { ssid: string; rssi: number | null; secure: boolean }[];
}

/**
 * The next state after an answer. One without a list (a failed request, or a
 * board that has never reported) keeps the list on screen and takes only what
 * it does know: whether the board is online and whether its firmware reports.
 */
export function mergeWifiState(
    prev: DeviceWifiState | null,
    next: DeviceWifiState,
): DeviceWifiState {
    return next.status || !prev
        ? next
        : { ...prev, online: next.online, reports_wifi: next.reports_wifi };
}

/**
 * 1.0.1, the cloud release before R-37, neither reports its Wi-Fi nor takes
 * changes. Unknown or unparsable versions are not called old.
 */
export function firmwareLacksWifi(version: string | null | undefined): boolean {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
    if (!match) return false;
    const [major, minor, patch] = match.slice(1).map(Number);
    return major < 1 || (major === 1 && (minor < 0 || (minor === 0 && patch <= 1)));
}

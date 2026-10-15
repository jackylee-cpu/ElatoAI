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
    /** A "switch" was taken: the board is moving and drops offline for a while. */
    switching?: boolean;
    ok: boolean;
    /** offline | timeout | busy | full | current | unknown | invalid | scan | failed | forbidden | unavailable */
    error?: string;
    networks?: { ssid: string; rssi: number | null; secure: boolean }[];
}

// Shapes of the board's Wi-Fi state as the voice server relays it (R-37).
// Only names and signal: passwords never come back from the board.

export type WifiOp = "status" | "peek" | "add" | "delete" | "scan";

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
    ok: boolean;
    /** offline | timeout | busy | full | current | unknown | invalid | scan | failed | forbidden | unavailable */
    error?: string;
    networks?: { ssid: string; rssi: number | null; secure: boolean }[];
}

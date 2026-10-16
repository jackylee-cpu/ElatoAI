import type { DeviceBattery } from "./deviceBattery";

/**
 * The board's latest /ws/esp32 session, as the voice server wrote it to the
 * devices row (server/fastapi/device_connection.py). All null: the board has not
 * connected since this was deployed.
 */
export type DeviceConnection = {
    connected_at: string | null;
    disconnected_at: string | null;
    /**
     * sleep_idle | sleep_button | sleep_session_end | restart: the board said so.
     * lost: it went without a word. unknown: firmware that never says (1.1.0
     * and older). server_restart: the voice server restarted under it.
     */
    disconnect_reason: string | null;
};

export const CONNECTION_COLUMNS = "connected_at, disconnected_at, disconnect_reason";

export type ConnectionState = "online" | "asleep" | "restarting" | "out_of_battery" | "offline";

/** A restart that has not come back within this long is just offline. */
export const RESTART_GRACE_MS = 5 * 60_000;

/**
 * What the app says about where the toy is, and since when; null when the
 * board has never connected since connections were recorded.
 *
 * "Probably out of battery" is a guess: the board went without a word after
 * telling us its battery was low. A flat cell cannot say goodbye.
 */
export function connectionState(
    device: DeviceConnection & Pick<DeviceBattery, "battery_low">,
    now: number = Date.now(),
): { state: ConnectionState; since: string } | null {
    if (!device.connected_at) return null;
    if (!device.disconnected_at) return { state: "online", since: device.connected_at };
    const since = device.disconnected_at;
    const reason = device.disconnect_reason ?? "unknown";
    if (reason.startsWith("sleep_")) return { state: "asleep", since };
    if (reason === "restart") {
        const recent = now - new Date(since).getTime() < RESTART_GRACE_MS;
        return { state: recent ? "restarting" : "offline", since };
    }
    if (reason === "lost" && device.battery_low === true) return { state: "out_of_battery", since };
    return { state: "offline", since };
}

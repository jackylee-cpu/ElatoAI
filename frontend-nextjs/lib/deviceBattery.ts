/**
 * What the board last said about its battery (R-41), as the voice server wrote
 * it to the devices row. All null: the board has never reported, because it
 * cannot sense its battery or runs firmware older than the report.
 *
 * Only battery_low is always there. The others are null when the board cannot
 * sense them, which is not the same as false: the Spotpear board as sold can
 * only say "nearly empty", so it is never shown as charging or full.
 */
export type DeviceBattery = {
    battery_low: boolean | null;
    battery_percent: number | null;
    battery_charging: boolean | null;
    battery_full: boolean | null;
    battery_at: string | null;
};

export const BATTERY_COLUMNS = "battery_low, battery_percent, battery_charging, battery_full, battery_at";

export function hasBattery(device: DeviceBattery) {
    return device.battery_low !== null && device.battery_at !== null;
}

export type BatteryState = "charging" | "low" | "full" | "ok";

/**
 * The one state the app shows, most urgent first. Charging wins over low (the
 * parent has already plugged it in) and over full (a charger that has not
 * finished). A board that only says "low" is "ok" otherwise: it cannot tell
 * full from half.
 */
export function batteryState(device: DeviceBattery): BatteryState {
    if (device.battery_charging) return "charging";
    if (device.battery_low) return "low";
    if (device.battery_full) return "full";
    return "ok";
}

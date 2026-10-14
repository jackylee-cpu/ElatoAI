/**
 * What the board last said about its battery (R-41), as the voice server wrote
 * it to the devices row. All null: the board has never reported, because it
 * cannot sense its battery or runs firmware older than the report.
 *
 * The Spotpear board can only say "nearly empty" (battery_low); a percentage
 * and charging come from boards that measure the cell.
 */
export type DeviceBattery = {
    battery_low: boolean | null;
    battery_percent: number | null;
    battery_charging: boolean | null;
    battery_at: string | null;
};

export const BATTERY_COLUMNS = "battery_low, battery_percent, battery_charging, battery_at";

export function hasBattery(device: DeviceBattery) {
    return device.battery_low !== null && device.battery_at !== null;
}

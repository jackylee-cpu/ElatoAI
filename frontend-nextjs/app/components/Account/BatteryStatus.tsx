"use client";

import { BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, BatteryWarning } from "lucide-react";
import { cn } from "@/lib/utils";
import { type DeviceBattery, hasBattery } from "@/lib/deviceBattery";

function describe(device: DeviceBattery) {
    const percent = device.battery_percent;
    if (device.battery_charging) {
        return { Icon: BatteryCharging, label: percent !== null ? `Charging · ${percent}%` : "Charging", low: false };
    }
    if (device.battery_low) {
        return {
            Icon: percent !== null ? BatteryLow : BatteryWarning,
            label: percent !== null ? `${percent}% · Please charge` : "Low · Please charge",
            low: true,
        };
    }
    if (percent !== null) {
        return { Icon: percent >= 60 ? BatteryFull : BatteryMedium, label: `${percent}%`, low: false };
    }
    // Spotpear: not low is all it can say.
    return { Icon: BatteryFull, label: "OK", low: false };
}

/** The row on the device's settings page. Renders nothing for a board that never reported. */
export function BatteryRow({
    device,
    updated,
    className,
}: {
    device: DeviceBattery;
    /** "5 minutes ago", formatted by the caller once mounted; null hides it. */
    updated: string | null;
    className?: string;
}) {
    if (!hasBattery(device)) return null;
    const { Icon, label, low } = describe(device);
    return (
        <div className={className}>
            <span className="flex items-center gap-3">
                <Icon className={cn("h-5 w-5", low ? "text-red-500" : "text-gray-500")} />
                Battery
            </span>
            <span className="flex min-w-0 flex-col items-end">
                <span className={cn("text-sm", low ? "font-medium text-red-600" : "text-gray-500")}>
                    {label}
                </span>
                {/* The board reports only while awake, so this is the last
                    known state, not a live reading. */}
                {updated && <span className="text-xs text-gray-400">Updated {updated}</span>}
            </span>
        </div>
    );
}

/** A small pill for the device list, shown only when the battery needs attention. */
export function LowBatteryBadge({ device }: { device: DeviceBattery }) {
    if (!hasBattery(device) || !device.battery_low || device.battery_charging) return null;
    return (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600">
            <BatteryWarning className="h-3.5 w-3.5" aria-hidden="true" />
            Low battery
        </span>
    );
}

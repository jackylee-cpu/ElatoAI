"use client";

import { BatteryWarning, Moon, RotateCw, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DeviceBattery } from "@/lib/deviceBattery";
import { type DeviceConnection, type ConnectionState, connectionState } from "@/lib/deviceConnection";

const look: Record<ConnectionState, { label: string; hint?: string; className: string }> = {
    online: { label: "Online", className: "bg-green-50 text-green-700" },
    asleep: { label: "Asleep", hint: "Press its button to wake it", className: "bg-indigo-50 text-indigo-700" },
    restarting: { label: "Restarting", className: "bg-amber-50 text-amber-700" },
    out_of_battery: {
        label: "Probably out of battery",
        hint: "Charge it, then press its button",
        className: "bg-red-50 text-red-600",
    },
    offline: { label: "Offline", className: "bg-gray-100 text-gray-600" },
};

function Icon({ state }: { state: ConnectionState }) {
    const className = "h-3.5 w-3.5";
    switch (state) {
        case "online":
            return <span className="h-2 w-2 rounded-full bg-green-500" aria-hidden="true" />;
        case "asleep":
            return <Moon className={className} aria-hidden="true" />;
        case "restarting":
            return <RotateCw className={className} aria-hidden="true" />;
        case "out_of_battery":
            return <BatteryWarning className={className} aria-hidden="true" />;
        case "offline":
            return <WifiOff className={className} aria-hidden="true" />;
    }
}

/**
 * Online / asleep / probably out of battery / offline, under the toy's name.
 * Renders nothing for a board that has not connected since connections were
 * recorded, or before mount (the state depends on the browser's clock).
 */
export function ConnectionStatus({
    device,
    ago,
    mounted,
}: {
    device: DeviceConnection & Pick<DeviceBattery, "battery_low">;
    /** "5 minutes ago", formatted by the caller. */
    ago: (iso: string) => string | null;
    mounted: boolean;
}) {
    if (!mounted) return null;
    const connection = connectionState(device);
    if (!connection) return null;
    const { label, hint, className } = look[connection.state];
    const since = connection.state === "online" ? null : ago(connection.since);
    return (
        <div className="flex flex-col items-center gap-1">
            <span
                className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium",
                    className,
                )}
            >
                <Icon state={connection.state} />
                {label}
                {since && <span className="font-normal opacity-75">· {since}</span>}
            </span>
            {hint && <span className="text-xs text-gray-400">{hint}</span>}
        </div>
    );
}

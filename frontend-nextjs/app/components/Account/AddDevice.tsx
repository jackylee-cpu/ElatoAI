"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { claimDeviceAction, listUnclaimedDevices } from "@/app/actions";
import { cn } from "@/lib/utils";

const skipDeviceRegistration = process.env.NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION === "True";

type Unclaimed = { device_id: string; mac_address: string; user_code: string };

const cardClass =
    "rounded-[24px] bg-white/90 shadow-[0_8px_24px_rgba(80,120,180,0.08)] backdrop-blur-sm";

/** A toy shows up here a few seconds after it joins Wi-Fi. */
export default function AddDevice({ hasDevices }: { hasDevices: boolean }) {
    const router = useRouter();
    const [unclaimed, setUnclaimed] = useState<Unclaimed[]>([]);
    const [error, setError] = useState("");
    const [busyId, setBusyId] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            const devices = await listUnclaimedDevices();
            if (!cancelled) {
                setUnclaimed(Array.isArray(devices) ? devices : []);
            }
        };
        load();
        const timer = setInterval(load, 5000);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, []);

    const claimed = () => {
        setError("");
        router.refresh();
    };

    const claim = async (deviceId: string) => {
        setBusyId(deviceId);
        const ok = await claimDeviceAction(deviceId);
        setBusyId(null);
        if (!ok) {
            setError("Could not claim that device. Someone may have just taken it.");
            return;
        }
        setUnclaimed((devices) => devices.filter((d) => d.device_id !== deviceId));
        claimed();
    };

    return (
        <div className="flex flex-col gap-3">
            <h2 className="px-1 text-base font-semibold text-gray-800">
                {hasDevices ? "Add another device" : "Add a device"}
            </h2>
            {skipDeviceRegistration && (
                <p className="px-1 text-xs text-purple-600">
                    This build skips device registration.
                </p>
            )}
            {unclaimed.length === 0 ? (
                <div className={cn(cardClass, "px-5 py-4 text-sm text-gray-500")}>
                    <p className="font-medium text-gray-700">No new devices found yet.</p>
                    <p className="mt-1 text-xs leading-relaxed">
                        Power on the toy, join its{" "}
                        <span className="font-mono">AIBuddy-XXXX</span> Wi-Fi
                        (XXXX is the end of its MAC address), open{" "}
                        <span className="font-mono">http://192.168.4.1/wifi</span>{" "}
                        and give it your Wi-Fi. It shows up here within a few
                        seconds of connecting.
                    </p>
                </div>
            ) : (
                unclaimed.map((device) => (
                    <div
                        key={device.device_id}
                        className={cn(cardClass, "flex items-center gap-3 px-5 py-4")}
                    >
                        <div className="min-w-0 flex-1">
                            <p className="font-medium text-gray-900">
                                Device {device.user_code}
                            </p>
                            <p className="truncate font-mono text-[11px] text-gray-400">
                                {device.mac_address}
                            </p>
                        </div>
                        <button
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => claim(device.device_id)}
                            className="shrink-0 rounded-full bg-[#4C74F6] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                        >
                            {busyId === device.device_id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                "Add"
                            )}
                        </button>
                    </div>
                ))
            )}
            {error && <p className="px-1 text-xs text-red-500">{error}</p>}
        </div>
    );
}

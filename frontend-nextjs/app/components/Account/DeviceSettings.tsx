"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import _ from "lodash";
import { ChevronRight, Link2Off, Loader2, Volume2, Wifi } from "lucide-react";
import { unbindDeviceAction } from "@/app/actions";
import { updateDevice } from "@/db/devices";
import { createClient } from "@/utils/supabase/client";
import { useToast } from "@/components/ui/use-toast";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { BackIcon } from "../Playground/icons";
import MemorySection from "../Settings/MemorySection";
import { cn } from "@/lib/utils";

type SettingsDevice = Pick<IDevice, "device_id" | "mac_address" | "user_code" | "volume"> & {
    claimed_at: string | null;
    last_seen_at: string | null;
    firmware_version: string | null;
    firmware_reported_at: string | null;
};

const cardClass =
    "rounded-[24px] bg-white/90 shadow-[0_8px_24px_rgba(80,120,180,0.08)] backdrop-blur-sm";

const rowClass =
    "flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-4 text-base text-gray-800 last:border-b-0";

const sectionTitleClass = "mb-2 px-1 text-base font-semibold text-gray-800";

function formatDate(iso: string | null) {
    if (!iso) return null;
    return new Date(iso).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

function formatAgo(iso: string | null) {
    if (!iso) return null;
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    if (minutes < 60) return rtf.format(-Math.max(minutes, 0), "minute");
    const hours = Math.round(minutes / 60);
    if (hours < 48) return rtf.format(-hours, "hour");
    return rtf.format(-Math.round(hours / 24), "day");
}

export default function DeviceSettings({
    currentUser,
    device,
}: {
    currentUser: IUser;
    device: SettingsDevice;
}) {
    const supabase = createClient();
    const router = useRouter();
    const { toast } = useToast();
    const [volume, setVolume] = useState([device.volume ?? 50]);
    const [confirming, setConfirming] = useState(false);
    const [eraseMemory, setEraseMemory] = useState(false);
    const [unbinding, setUnbinding] = useState(false);

    // Same as the Setting page: one debounced writer, flushed on the way out so
    // the last drag is never lost.
    const saveVolume = useMemo(
        () => _.debounce((value: number) => {
            updateDevice(supabase, { volume: value }, device.device_id);
        }, 1000),
        [supabase, device.device_id],
    );
    useEffect(() => () => saveVolume.flush(), [saveVolume]);

    const handleUnbind = async () => {
        setUnbinding(true);
        const ok = await unbindDeviceAction(device.device_id, eraseMemory);
        setUnbinding(false);
        if (!ok) {
            // One transaction on the server: a failure changed nothing.
            toast({
                description: "Could not unbind this device. Nothing was changed.",
                variant: "destructive",
            });
            return;
        }
        setConfirming(false);
        toast({
            description: eraseMemory
                ? "Device unbound, and what it remembered is erased."
                : "Device unbound. Its memory is kept for when you claim it again.",
        });
        router.push("/home/account");
        router.refresh();
    };

    // The board reports both at boot; whichever is later is its last check-in.
    const lastCheckIn = [device.last_seen_at, device.firmware_reported_at]
        .filter((t): t is string => !!t)
        .sort()
        .at(-1) ?? null;

    // Dates are formatted in the browser only: the server's locale, time zone
    // and clock differ from the parent's, and a mismatch breaks hydration.
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    const about: { label: string; value: string | null; mono?: boolean; dated?: boolean }[] = [
        { label: "Firmware", value: device.firmware_version },
        { label: "MAC address", value: device.mac_address, mono: true },
        { label: "Bound since", value: mounted ? formatDate(device.claimed_at) : null, dated: true },
        { label: "Last check-in", value: mounted ? formatAgo(lastCheckIn) : null, dated: true },
    ];

    return (
        <div className="relative z-10 mx-auto flex h-full w-full max-w-lg flex-col px-4 pt-[max(0.75rem,env(safe-area-inset-top))] md:max-w-xl md:px-8 md:pt-8">
            <header className="relative mb-3 flex h-14 shrink-0 items-center justify-center md:h-16">
                <Link
                    href="/home/account"
                    aria-label="Back to Me"
                    className="absolute left-0 top-1/2 -translate-y-1/2 transition-transform hover:scale-105 active:scale-95"
                >
                    <BackIcon className="h-10 w-10" />
                </Link>
                <h1 className="font-fredoka text-[28px] font-semibold tracking-tight text-gray-900 md:text-[32px]">
                    Device Settings
                </h1>
            </header>

            <div className="scrollbar-hide flex flex-1 flex-col gap-5 overflow-y-auto pb-[max(2rem,env(safe-area-inset-bottom))]">
                <div className="flex flex-col items-center gap-2 pt-2">
                    <div className="flex h-28 w-28 items-center justify-center rounded-full bg-white/90 shadow-[0_8px_24px_rgba(80,120,180,0.12)] ring-8 ring-white/40">
                        <span className="text-6xl" aria-hidden="true">🧸</span>
                    </div>
                    <p className="mt-1 text-xl font-semibold text-gray-900">AI Buddy</p>
                    <p className="text-sm text-gray-500">SN: {device.user_code}</p>
                </div>

                <section>
                    <h2 className={sectionTitleClass}>Volume</h2>
                    <div className={cn(cardClass, "p-4")}>
                        <VolumeSlider
                            value={volume[0]}
                            onChange={(value) => {
                                setVolume([value]);
                                saveVolume(value);
                            }}
                        />
                        {/* The voice server reads volume when a session starts,
                            and dropping a live one just for this would cut the
                            child off mid-sentence. */}
                        <p className="mt-2 px-1 text-xs text-gray-400">
                            Applies the next time AI Buddy connects.
                        </p>
                    </div>
                </section>

                <section>
                    <h2 className={sectionTitleClass}>Network</h2>
                    <Link
                        href={`/home/account/devices/${device.device_id}/wifi`}
                        className={cn(cardClass, rowClass, "hover:bg-white")}
                    >
                        <span className="flex items-center gap-3">
                            <Wifi className="h-5 w-5 text-gray-500" />
                            Wi-Fi
                        </span>
                        <ChevronRight className="h-5 w-5 shrink-0 text-gray-400" />
                    </Link>
                </section>

                {/* Child details live on the account, so every device shares
                    them; they are edited in My Info. */}
                <section>
                    <h2 className={sectionTitleClass}>Child Information</h2>
                    <Link href="/home/account/child" className={cn(cardClass, "block overflow-hidden")}>
                        <div className={rowClass}>
                            Name
                            <span className="flex min-w-0 items-center gap-1 text-sm text-gray-500">
                                <span className="truncate">{currentUser.supervisee_name || "Not set"}</span>
                                <ChevronRight className="h-5 w-5 shrink-0 text-gray-400" />
                            </span>
                        </div>
                        <div className={rowClass}>
                            Age
                            <span className="flex items-center gap-1 text-sm text-gray-500">
                                {currentUser.supervisee_age || "Not set"}
                                <ChevronRight className="h-5 w-5 text-gray-400" />
                            </span>
                        </div>
                    </Link>
                </section>

                <section>
                    <div className={cn(cardClass, "p-4")}>
                        <MemorySection
                            selectedUser={currentUser}
                            deviceId={device.device_id}
                        />
                    </div>
                </section>

                <section>
                    <h2 className={sectionTitleClass}>About</h2>
                    <div className={cn(cardClass, "overflow-hidden")}>
                        {about.map((item) => (
                            <div key={item.label} className={rowClass}>
                                {item.label}
                                <span
                                    className={cn(
                                        "min-w-0 truncate text-sm",
                                        item.value ? "text-gray-500" : "text-gray-300",
                                        item.mono && "font-mono text-xs"
                                    )}
                                >
                                    {item.value ?? (item.dated && !mounted ? "" : "Not reported yet")}
                                </span>
                            </div>
                        ))}
                    </div>
                </section>

                <button
                    type="button"
                    onClick={() => {
                        setEraseMemory(false);
                        setConfirming(true);
                    }}
                    className="flex w-full items-center justify-center gap-2 rounded-full border border-gray-300 bg-white/90 py-3.5 text-base font-medium text-gray-900 transition-transform hover:bg-white active:scale-[0.99]"
                >
                    <Link2Off className="h-5 w-5" />
                    Unbind device
                </button>
            </div>

            <Dialog
                open={confirming}
                onOpenChange={(open) => {
                    if (!open && !unbinding) setConfirming(false);
                }}
            >
                <DialogContent className="max-w-[calc(100vw-2rem)] rounded-[24px] sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Unbind Device {device.user_code}?</DialogTitle>
                        <DialogDescription>
                            It stops talking and goes back to waiting to be paired.
                            What it remembers about your child is kept: claim this
                            device again and it picks up where it left off.
                        </DialogDescription>
                    </DialogHeader>
                    <label className="flex flex-row items-start gap-3 rounded-md border border-gray-200 p-3 text-sm">
                        <Checkbox
                            className="mt-0.5"
                            checked={eraseMemory}
                            onCheckedChange={(checked) => setEraseMemory(checked === true)}
                            disabled={unbinding}
                        />
                        <span>
                            Also erase everything this device remembers - what it
                            knows about your child, its conversation notes and
                            transcripts.{" "}
                            <span className="font-medium text-red-600">This cannot be undone.</span>
                        </span>
                    </label>
                    <DialogFooter className="gap-2">
                        <Button variant="outline" disabled={unbinding} onClick={() => setConfirming(false)}>
                            Cancel
                        </Button>
                        <Button
                            variant={eraseMemory ? "destructive" : "default"}
                            disabled={unbinding}
                            onClick={handleUnbind}
                        >
                            {unbinding ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : eraseMemory ? "Unbind and erase" : "Unbind"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

/** A thick pill the finger can grab anywhere, the fill showing the level. */
function VolumeSlider({
    value,
    onChange,
}: {
    value: number;
    onChange: (value: number) => void;
}) {
    return (
        <SliderPrimitive.Root
            value={[value]}
            onValueChange={(next) => onChange(next[0])}
            min={1}
            max={100}
            step={1}
            className="relative flex h-12 w-full touch-none select-none items-center"
        >
            <SliderPrimitive.Track className="relative h-full w-full grow overflow-hidden rounded-full bg-[#EEF1F6]">
                <SliderPrimitive.Range className="absolute h-full rounded-full bg-[#7CC4F8]" />
            </SliderPrimitive.Track>
            <Volume2
                aria-hidden="true"
                className="pointer-events-none absolute left-4 h-5 w-5 text-gray-800"
            />
            <span className="pointer-events-none absolute right-4 text-sm tabular-nums text-gray-600">
                {value}%
            </span>
            <SliderPrimitive.Thumb aria-label="Volume" className="block h-12 w-12 rounded-full bg-white/30 outline-none focus-visible:ring-2 focus-visible:ring-[#4C74F6]/40" />
        </SliderPrimitive.Root>
    );
}

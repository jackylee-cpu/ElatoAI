"use client";

import Image from "next/image";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { BackIcon } from "../Playground/icons";
import AddDevice from "./AddDevice";
import { AccountAvatar } from "./AccountAvatar";
import { EmojiComponent } from "../Playground/EmojiImage";
import { cn, getPersonalityAvatarSrc } from "@/lib/utils";
import type { DeviceBattery } from "@/lib/deviceBattery";
import type { DeviceToy } from "@/db/devices";
import { LowBatteryBadge } from "./BatteryStatus";

type AccountDevice = Pick<IDevice, "device_id" | "mac_address" | "user_code"> & DeviceBattery & DeviceToy;

interface AccountDashboardProps {
    currentUser: IUser;
    devices: AccountDevice[];
}

const cardClass =
    "rounded-[24px] bg-white/90 shadow-[0_8px_24px_rgba(80,120,180,0.08)] backdrop-blur-sm";

export default function AccountDashboard({
    currentUser,
    devices,
}: AccountDashboardProps) {
    const displayName =
        currentUser.supervisor_name?.trim() ||
        currentUser.email?.split("@")[0] ||
        "Me";
    const personality = currentUser.personality;
    const personalitySrc = personality ? getPersonalityAvatarSrc(personality) : null;

    return (
        <div className="relative z-10 mx-auto flex h-full w-full max-w-lg flex-col px-4 pt-[max(0.75rem,env(safe-area-inset-top))] md:max-w-xl md:px-8 md:pt-8">
            <header className="relative mb-3 flex h-14 shrink-0 items-center justify-center md:h-16">
                <Link
                    href="/home"
                    aria-label="Back to playground"
                    className="absolute left-0 top-1/2 -translate-y-1/2 transition-transform hover:scale-105 active:scale-95"
                >
                    <BackIcon className="h-10 w-10" />
                </Link>
                <h1 className="font-fredoka text-[28px] font-semibold tracking-tight text-gray-900 md:text-[32px]">
                    Me
                </h1>
            </header>

            <div className="scrollbar-hide flex flex-1 flex-col gap-5 overflow-y-auto pb-[max(2rem,env(safe-area-inset-bottom))]">
                {/* Profile: opens Personal Info, as the avatar does in the
                    app we modelled this on. */}
                <Link
                    href="/home/account/profile"
                    className={cn(cardClass, "flex items-center gap-4 p-4 transition-transform active:scale-[0.99]")}
                >
                    <AccountAvatar src={currentUser.avatar_url} />
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-xl font-semibold text-gray-900">
                            {displayName}
                        </p>
                        {currentUser.email && (
                            <p className="truncate text-sm text-gray-400">
                                {currentUser.email}
                            </p>
                        )}
                        <span
                            className={cn(
                                "mt-1.5 inline-block rounded-full border px-2.5 py-0.5 text-xs",
                                currentUser.is_premium
                                    ? "border-[#FAC04F] bg-[#FFF6E0] text-[#B7801A]"
                                    : "border-gray-300 text-gray-500"
                            )}
                        >
                            {currentUser.is_premium ? "Premium" : "Free plan"}
                        </span>
                    </div>
                    <ChevronRight className="h-5 w-5 shrink-0 text-gray-300" />
                </Link>

                <section className="flex flex-col gap-3">
                    {devices.length > 0 && (
                        <h2 className="px-1 text-base font-semibold text-gray-800">
                            My Devices
                        </h2>
                    )}
                    {devices.length > 0 && (
                        <div className="flex flex-col gap-3">
                            {devices.map((device) => (
                                <Link
                                    key={device.device_id}
                                    href={`/home/account/devices/${device.device_id}`}
                                    className={cn(cardClass, "flex items-center gap-4 p-4 transition-transform active:scale-[0.99]")}
                                >
                                    <div className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-[#EEF3FF]">
                                        {device.toy?.image_url ? (
                                            <Image
                                                src={device.toy.image_url}
                                                alt=""
                                                fill
                                                sizes="56px"
                                                className="object-cover"
                                            />
                                        ) : (
                                            <span className="text-2xl" aria-hidden="true">🧸</span>
                                        )}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p className="flex items-center gap-2 font-medium text-gray-900">
                                            <span className="truncate">{device.toy?.name || "AI Buddy"}</span>
                                            <LowBatteryBadge device={device} />
                                        </p>
                                        <p className="truncate text-xs text-gray-500">
                                            SN: {device.user_code}
                                        </p>
                                        <p className="truncate font-mono text-[11px] text-gray-400">
                                            {device.mac_address}
                                        </p>
                                    </div>
                                    <ChevronRight className="h-5 w-5 shrink-0 text-gray-300" />
                                </Link>
                            ))}
                        </div>
                    )}
                    <AddDevice hasDevices={devices.length > 0} />
                </section>

                {personality && (
                    <section>
                        <h2 className="mb-2 px-1 text-base font-semibold text-gray-800">
                            Current Character
                        </h2>
                        <Link
                            href="/home"
                            className={cn(cardClass, "flex items-center gap-4 p-4 transition-transform active:scale-[0.99]")}
                        >
                            <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-2xl bg-[#FFF1E6]">
                                {personalitySrc ? (
                                    <Image
                                        src={personalitySrc}
                                        alt=""
                                        fill
                                        sizes="56px"
                                        className="object-cover"
                                    />
                                ) : (
                                    <div className="flex h-full w-full items-center justify-center">
                                        <EmojiComponent personality={personality} size={32} />
                                    </div>
                                )}
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="truncate font-medium text-gray-900">
                                    {personality.title}
                                </p>
                                <p className="text-xs text-[#F25C5C]">Change character</p>
                            </div>
                            <ChevronRight className="h-5 w-5 shrink-0 text-gray-300" />
                        </Link>
                    </section>
                )}

                <div className={cn(cardClass, "overflow-hidden")}>
                    <MenuRow href="/home/account/child" label="My Info" />
                </div>
            </div>
        </div>
    );
}

function MenuRow({ href, label }: { href: string; label: string }) {
    return (
        <Link
            href={href}
            className="flex items-center justify-between border-b border-gray-100 px-5 last:border-b-0 py-4 text-base text-gray-800 hover:bg-gray-50"
        >
            {label}
            <ChevronRight className="h-5 w-5 text-gray-400" />
        </Link>
    );
}

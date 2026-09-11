"use client";

import React, { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import AppSettings from "./AppSettings";
import MemorySection from "./MemorySection";
import MyInfoForm from "./MyInfoForm";
import { playgroundAssets } from "../Playground/playgroundAssets";
import { cn } from "@/lib/utils";

interface SettingsDashboardProps {
    selectedUser: IUser;
    allLanguages: ILanguage[];
}

type SettingsTab = "info" | "setting";

const SettingsDashboard: React.FC<SettingsDashboardProps> = ({
    selectedUser,
    allLanguages,
}) => {
    const [tab, setTab] = useState<SettingsTab>("info");

    return (
        <div className="relative h-dvh w-full overflow-hidden bg-[#d4e8f8]">
            <Image
                src={playgroundAssets.bg}
                alt=""
                fill
                priority
                sizes="100vw"
                className="object-cover object-top"
            />

            <div className="relative z-10 mx-auto flex h-full w-full max-w-lg flex-col px-4 pt-[max(0.75rem,env(safe-area-inset-top))] md:max-w-xl md:px-8 md:pt-8">
                <header className="relative mb-3 flex h-14 shrink-0 items-center justify-center md:h-16">
                    <Link
                        href="/home"
                        aria-label="Back to playground"
                        className="absolute left-0 top-1/2 -translate-y-1/2 transition-transform hover:scale-105 active:scale-95"
                    >
                        <Image
                            src={playgroundAssets.back}
                            alt=""
                            width={40}
                            height={40}
                            className="h-10 w-10 object-contain"
                            priority
                        />
                    </Link>
                    <h1 className="font-fredoka text-[28px] font-semibold tracking-tight text-gray-900 md:text-[32px]">
                        {tab === "info" ? "My Info" : "Setting"}
                    </h1>
                </header>

                <div className="mx-auto mb-5 grid w-full grid-cols-2 rounded-full bg-white/90 p-1 shadow-[0_4px_16px_rgba(80,120,180,0.08)]">
                    {(
                        [
                            { id: "info", label: "My Info" },
                            { id: "setting", label: "Setting" },
                        ] as const
                    ).map((item) => (
                        <button
                            key={item.id}
                            type="button"
                            onClick={() => setTab(item.id)}
                            className={cn(
                                "rounded-full py-2.5 text-sm font-medium transition-all md:text-base",
                                tab === item.id
                                    ? "bg-white text-gray-900 shadow-sm"
                                    : "text-gray-400 hover:text-gray-600"
                            )}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>

                {tab === "info" ? (
                    <MyInfoForm
                        selectedUser={selectedUser}
                        allLanguages={allLanguages}
                    />
                ) : (
                    <div className="scrollbar-hide flex-1 overflow-y-auto pb-8">
                        <div className="rounded-[24px] bg-white/90 p-4 shadow-[0_8px_24px_rgba(80,120,180,0.08)] backdrop-blur-sm">
                            <AppSettings
                                selectedUser={selectedUser}
                                hideUserForm
                            />
                            <div className="mt-8 border-t pt-6">
                                <MemorySection selectedUser={selectedUser} />
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default SettingsDashboard;

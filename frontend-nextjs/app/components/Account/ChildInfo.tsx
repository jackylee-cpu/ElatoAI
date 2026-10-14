"use client";

import Link from "next/link";
import MyInfoForm from "@/app/components/Settings/MyInfoForm";
import { BackIcon } from "../Playground/icons";

export default function ChildInfo({
    currentUser,
    allLanguages,
    allRegions,
}: {
    currentUser: IUser;
    allLanguages: ILanguage[];
    allRegions: IRegion[];
}) {
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
                    My Info
                </h1>
            </header>
            <div className="min-h-0 flex-1">
                <MyInfoForm
                    selectedUser={currentUser}
                    allLanguages={allLanguages}
                    allRegions={allRegions}
                />
            </div>
        </div>
    );
}

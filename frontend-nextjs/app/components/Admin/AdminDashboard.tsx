"use client";

import React from "react";
import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ModelSettingsTab from "./ModelSettingsTab";
import LatencyTab from "./LatencyTab";
import CharactersTab from "./CharactersTab";
import { BackIcon } from "../Playground/icons";
import { cn } from "@/lib/utils";

interface AdminDashboardProps {
    settings: IVoiceStackSettings;
    turnMetrics: ITurnMetric[];
    personalities: IAdminPersonality[];
}

const tabTriggerClass = cn(
    "rounded-full py-2.5 text-sm font-medium text-gray-400 shadow-none",
    "data-[state=active]:bg-white data-[state=active]:text-gray-900 data-[state=active]:shadow-sm",
    "md:text-base"
);

const AdminDashboard: React.FC<AdminDashboardProps> = ({
    settings,
    turnMetrics,
    personalities,
}) => {
    return (
        <div className="relative z-10 mx-auto flex h-full w-full max-w-5xl flex-col px-4 pt-[max(0.75rem,env(safe-area-inset-top))] md:px-8 md:pt-8">
            <header className="relative mb-3 flex h-14 shrink-0 items-center justify-center md:h-16">
                <Link
                    href="/home"
                    aria-label="Back to playground"
                    className="absolute left-0 top-1/2 -translate-y-1/2 transition-transform hover:scale-105 active:scale-95"
                >
                    <BackIcon className="h-10 w-10" />
                </Link>
                <h1 className="font-fredoka text-[28px] font-semibold tracking-tight text-gray-900 md:text-[32px]">
                    Admin
                </h1>
            </header>

            <Tabs
                defaultValue="model"
                className="flex min-h-0 flex-1 flex-col"
            >
                <TabsList className="mx-auto mb-5 grid h-auto w-full max-w-lg grid-cols-3 rounded-full bg-white/90 p-1 shadow-[0_4px_16px_rgba(80,120,180,0.08)]">
                    <TabsTrigger value="model" className={tabTriggerClass}>
                        Model
                    </TabsTrigger>
                    <TabsTrigger value="latency" className={tabTriggerClass}>
                        Latency
                    </TabsTrigger>
                    <TabsTrigger
                        value="characters"
                        className={tabTriggerClass}
                    >
                        Characters
                    </TabsTrigger>
                </TabsList>

                <div className="scrollbar-hide min-h-0 flex-1 overflow-y-auto pb-8">
                    <div className="rounded-[24px] bg-white/90 p-4 shadow-[0_8px_24px_rgba(80,120,180,0.08)] backdrop-blur-sm md:p-6">
                        <p className="mb-4 text-sm text-gray-500">
                            Settings here apply to every session, on the web
                            app and on the toys.
                        </p>
                        <TabsContent value="model" className="mt-0">
                            <ModelSettingsTab settings={settings} />
                        </TabsContent>
                        <TabsContent value="latency" className="mt-0">
                            <LatencyTab rows={turnMetrics} />
                        </TabsContent>
                        <TabsContent value="characters" className="mt-0">
                            <CharactersTab personalities={personalities} />
                        </TabsContent>
                    </div>
                </div>
            </Tabs>
        </div>
    );
};

export default AdminDashboard;

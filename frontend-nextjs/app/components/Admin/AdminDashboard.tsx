"use client";

import React from "react";
import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ModelSettingsTab from "./ModelSettingsTab";
import LatencyTab from "./LatencyTab";
import CharactersTab from "./CharactersTab";
import IpsTab from "./IpsTab";
import AdminsTab from "./AdminsTab";
import AccountsTab from "./AccountsTab";
import { BackIcon } from "../Playground/icons";
import { cn } from "@/lib/utils";

interface AdminDashboardProps {
    roles: AdminRole[];
    currentUserId: string;
    settings: IVoiceStackSettings;
    turnMetrics: ITurnMetric[];
    admins: IAdminRoleEntry[];
    accounts: IAccountEntry[];
    personalities: IAdminPersonality[];
    ips: IIp[];
    modes: IMode[];
    styles: IStyle[];
}

const tabTriggerClass = cn(
    "shrink-0 flex-1 rounded-full px-3 py-2.5 text-sm font-medium text-gray-400 shadow-none",
    "data-[state=active]:bg-white data-[state=active]:text-gray-900 data-[state=active]:shadow-sm",
    "md:text-base"
);

const AdminDashboard: React.FC<AdminDashboardProps> = ({
    roles,
    currentUserId,
    settings,
    turnMetrics,
    admins,
    accounts,
    personalities,
    ips,
    modes,
    styles,
}) => {
    // Content admins see characters and IPs only. Hiding the rest is for
    // clarity; RLS is what stops them, and the page does not even fetch the
    // super admin's data for them.
    const isSuper = roles.includes("super_admin");
    const tabs = isSuper
        ? [
              { value: "model", label: "Model" },
              { value: "latency", label: "Latency" },
              { value: "characters", label: "Characters" },
              { value: "ips", label: "IPs" },
              { value: "accounts", label: "Accounts" },
              { value: "admins", label: "Admins" },
          ]
        : [
              { value: "characters", label: "Characters" },
              { value: "ips", label: "IPs" },
          ];

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
                defaultValue={tabs[0].value}
                className="flex min-h-0 flex-1 flex-col"
            >
                <TabsList
                    // A row that scrolls on a phone, where six labels do
                    // not fit; an even grid once they do.
                    className="scrollbar-hide mx-auto mb-5 flex h-auto w-full max-w-2xl justify-start overflow-x-auto rounded-full bg-white/90 p-1 shadow-[0_4px_16px_rgba(80,120,180,0.08)] md:grid"
                    style={{
                        gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`,
                    }}
                >
                    {tabs.map((tab) => (
                        <TabsTrigger
                            key={tab.value}
                            value={tab.value}
                            className={tabTriggerClass}
                        >
                            {tab.label}
                        </TabsTrigger>
                    ))}
                </TabsList>

                <div className="scrollbar-hide min-h-0 flex-1 overflow-y-auto pb-8">
                    <div className="rounded-[24px] bg-white/90 p-4 shadow-[0_8px_24px_rgba(80,120,180,0.08)] backdrop-blur-sm md:p-6">
                        <p className="mb-4 text-sm text-gray-500">
                            Settings here apply to every session, on the web
                            app and on the toys.
                        </p>
                        {isSuper && (
                            <>
                                <TabsContent value="model" className="mt-0">
                                    <ModelSettingsTab settings={settings} />
                                </TabsContent>
                                <TabsContent value="latency" className="mt-0">
                                    <LatencyTab rows={turnMetrics} />
                                </TabsContent>
                                <TabsContent value="accounts" className="mt-0">
                                    <AccountsTab accounts={accounts} />
                                </TabsContent>
                                <TabsContent value="admins" className="mt-0">
                                    <AdminsTab
                                        admins={admins}
                                        currentUserId={currentUserId}
                                    />
                                </TabsContent>
                            </>
                        )}
                        <TabsContent value="characters" className="mt-0">
                            <CharactersTab
                                personalities={personalities}
                                ips={ips}
                                modes={modes}
                                styles={styles}
                            />
                        </TabsContent>
                        <TabsContent value="ips" className="mt-0">
                            <IpsTab
                                ips={ips}
                                modes={modes}
                                styles={styles}
                                personalities={personalities}
                            />
                        </TabsContent>
                    </div>
                </div>
            </Tabs>
        </div>
    );
};

export default AdminDashboard;

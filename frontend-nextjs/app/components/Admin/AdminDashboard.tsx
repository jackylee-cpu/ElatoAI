"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ModelSettingsTab from "./ModelSettingsTab";
import LatencyTab from "./LatencyTab";
import CharactersTab from "./CharactersTab";
import IpsTab from "./IpsTab";
import AdminsTab from "./AdminsTab";
import AccountsTab from "./AccountsTab";
import AuditTab from "./AuditTab";
import UsageTab from "./UsageTab";
import DevicesTab from "./DevicesTab";
import OtaTab from "./OtaTab";
import OverviewPreview from "./preview/OverviewPreview";
import SupportPreview from "./preview/SupportPreview";
import FactoryPreview from "./preview/FactoryPreview";
import PlannedPage from "./preview/PlannedPage";
import { PreviewBanner } from "./preview/PreviewKit";
import { AdminPage, AdminPageId, pagesFor } from "./adminPages";
import type { PresenceMap } from "@/lib/devicePresence";
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
    audit: IAdminAuditEntry[];
    devices: IAdminDevice[];
    presence: PresenceMap;
    firmwareReleases: IAdminFirmwareRelease[];
    usage: React.ComponentProps<typeof UsageTab>;
}

const panelClass =
    "rounded-[24px] bg-white/90 p-4 shadow-[0_8px_24px_rgba(80,120,180,0.08)] backdrop-blur-sm md:p-6";

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
    audit,
    devices,
    presence,
    firmwareReleases,
    usage,
}) => {
    // Content admins see characters and IPs only. Hiding the rest is for
    // clarity; RLS is what stops them, and the page does not even fetch the
    // super admin's data for them.
    const isSuper = roles.includes("super_admin");
    const groups = useMemo(() => pagesFor(isSuper), [isSuper]);
    const pages = useMemo(() => groups.flatMap((group) => group.pages), [groups]);
    const [current, setCurrent] = useState<AdminPageId>(
        isSuper ? "model" : "characters"
    );

    // The hash keeps the page across a reload and makes it linkable. Read
    // after mount, so the server render and the first client render agree.
    useEffect(() => {
        const fromHash = window.location.hash.slice(1);
        if (pages.some((page) => page.id === fromHash)) {
            setCurrent(fromHash as AdminPageId);
        }
    }, [pages]);

    // What the Devices page searches for when another page sends you there.
    const [deviceQuery, setDeviceQuery] = useState("");

    const open = (id: AdminPageId) => {
        setCurrent(id);
        setDeviceQuery("");
        window.history.replaceState(null, "", `#${id}`);
    };

    const openDevice = (mac: string) => {
        open("devices");
        setDeviceQuery(mac);
    };

    const page = pages.find((entry) => entry.id === current) ?? pages[0];

    const renderLive = (id: AdminPageId) => {
        switch (id) {
            case "model":
                return <ModelSettingsTab settings={settings} />;
            case "latency":
                return <LatencyTab rows={turnMetrics} />;
            case "accounts":
                return (
                    <AccountsTab
                        accounts={accounts}
                        admins={admins}
                        currentUserId={currentUserId}
                    />
                );
            case "admins":
                return <AdminsTab admins={admins} currentUserId={currentUserId} />;
            case "audit":
                return <AuditTab entries={audit} />;
            case "usage":
                return <UsageTab {...usage} />;
            case "devices":
                return (
                    <DevicesTab
                        devices={devices}
                        presence={presence}
                        usage={usage}
                        ips={ips}
                        initialQuery={deviceQuery}
                    />
                );
            case "ota":
                return <OtaTab releases={firmwareReleases} devices={devices} onOpenDevice={openDevice} />;
            case "characters":
                return (
                    <CharactersTab
                        personalities={personalities}
                        ips={ips}
                        modes={modes}
                        styles={styles}
                    />
                );
            case "ips":
                return (
                    <IpsTab
                        ips={ips}
                        modes={modes}
                        styles={styles}
                        personalities={personalities}
                    />
                );
            default:
                return null;
        }
    };

    const renderPreview = (id: AdminPageId) => {
        switch (id) {
            case "overview":
                return <OverviewPreview onOpen={open} />;
            case "support":
                return <SupportPreview />;
            case "factory":
                return <FactoryPreview />;
            default:
                return null;
        }
    };

    return (
        <div className="relative z-10 mx-auto flex h-full w-full max-w-7xl flex-col gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] md:flex-row md:gap-6 md:px-6 md:pt-6">
            <aside className="flex shrink-0 flex-col gap-3 md:w-56 md:overflow-y-auto md:pb-6 scrollbar-hide">
                <div className="flex items-center gap-3 rounded-[24px] bg-white/90 px-3 py-2.5 shadow-[0_8px_24px_rgba(80,120,180,0.08)]">
                    <Link
                        href="/home"
                        aria-label="Back to playground"
                        className="shrink-0 transition-transform hover:scale-105 active:scale-95"
                    >
                        <BackIcon className="h-9 w-9" />
                    </Link>
                    <div className="min-w-0">
                        <h1 className="font-fredoka text-[22px] font-semibold leading-tight tracking-tight text-gray-900">
                            Admin
                        </h1>
                        <p className="text-xs text-gray-500">
                            {isSuper ? "Super admin" : "Content admin"}
                        </p>
                    </div>
                </div>

                <nav
                    aria-label="Admin pages"
                    // A row that scrolls on a phone; a grouped column from md up.
                    className="scrollbar-hide flex gap-1 overflow-x-auto rounded-full bg-white/90 p-1 shadow-[0_4px_16px_rgba(80,120,180,0.08)] md:flex-col md:gap-3 md:overflow-visible md:rounded-[24px] md:p-2.5"
                >
                    {groups.map((group) => (
                        <div key={group.label} className="contents md:flex md:flex-col md:gap-0.5">
                            <div className="hidden px-2.5 pb-0.5 text-[11px] font-medium uppercase tracking-wider text-gray-400 md:block">
                                {group.label}
                            </div>
                            {group.pages.map((entry) => (
                                <NavButton
                                    key={entry.id}
                                    page={entry}
                                    active={entry.id === page.id}
                                    onClick={() => open(entry.id)}
                                />
                            ))}
                        </div>
                    ))}
                </nav>
            </aside>

            <main className="scrollbar-hide min-h-0 min-w-0 flex-1 overflow-y-auto pb-8 md:pb-10">
                <header className="mb-4 flex flex-col gap-1">
                    <h2 className="font-fredoka text-[26px] font-semibold tracking-tight text-gray-900 md:text-[30px]">
                        {page.title}
                    </h2>
                    <p className="text-sm text-gray-600">{page.description}</p>
                </header>

                {page.kind === "live" && (
                    <div className={panelClass}>{renderLive(page.id)}</div>
                )}
                {page.kind === "preview" && (
                    <div className="flex flex-col gap-4">
                        <PreviewBanner />
                        {renderPreview(page.id)}
                    </div>
                )}
                {page.kind === "planned" && <PlannedPage id={page.id} />}
            </main>
        </div>
    );
};

function NavButton({
    page,
    active,
    onClick,
}: {
    page: AdminPage;
    active: boolean;
    onClick: () => void;
}) {
    // On a phone the nav is a sideways-scrolling row; a page opened from the
    // hash or a link elsewhere could otherwise be off screen.
    const ref = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, [active]);

    return (
        <button
            ref={ref}
            type="button"
            onClick={onClick}
            aria-current={active ? "page" : undefined}
            className={cn(
                "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 py-2 text-left text-sm font-medium transition-colors md:py-1.5",
                active
                    ? "bg-[#2a78cf] text-white shadow-sm"
                    : "text-gray-600 hover:bg-sky-50 hover:text-gray-900"
            )}
        >
            {page.label}
            {page.kind !== "live" && (
                <span
                    className={cn(
                        "ml-auto hidden rounded-full px-1.5 text-[10px] font-medium uppercase tracking-wide md:inline",
                        active ? "bg-white/20 text-white" : "bg-gray-100 text-gray-400"
                    )}
                >
                    {page.kind === "preview" ? "Preview" : "Planned"}
                </span>
            )}
        </button>
    );
}

export default AdminDashboard;

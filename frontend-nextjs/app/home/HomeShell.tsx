"use client";

import { usePathname } from "next/navigation";
import { SidebarNav } from "../components/Nav/SidebarNavItems";
import { MobileNav } from "../components/Nav/MobileNav";

export function HomeShell({
    children,
    navItems,
    mobileNavItems,
}: {
    children: React.ReactNode;
    navItems: SidebarNavItem[];
    mobileNavItems: SidebarNavItem[];
}) {
    const pathname = usePathname();
    const isNewHomeUi =
        pathname === "/home" || pathname === "/home/settings";

    if (isNewHomeUi) {
        return (
            <div className="flex min-h-0 w-full flex-1 flex-col">
                {children}
            </div>
        );
    }

    return (
        <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-2 pb-20 md:flex-row md:pb-2">
            <aside className="w-full pt-2 sm:py-4 md:fixed md:h-screen md:w-[270px] md:overflow-y-auto">
                <SidebarNav items={navItems} />
            </aside>
            <main className="flex flex-1 justify-center px-4 sm:py-4 md:ml-[270px]">
                <div className="w-full max-w-5xl">{children}</div>
            </main>
            <MobileNav items={mobileNavItems} />
        </div>
    );
}

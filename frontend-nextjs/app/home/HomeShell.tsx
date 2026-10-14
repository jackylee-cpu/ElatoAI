"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { SidebarNav } from "../components/Nav/SidebarNavItems";
import { MobileNav } from "../components/Nav/MobileNav";
import { playgroundAssets } from "../components/Playground/playgroundAssets";

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
        pathname === "/home" ||
        pathname === "/home/settings" ||
        pathname.startsWith("/home/account");

    if (isNewHomeUi) {
        // The background lives here rather than in each page, so switching
        // between Playground, Settings and Me keeps the same <Image>
        // mounted instead of tearing down and repainting a 440KB backdrop on
        // every navigation. Pages render only their own z-10 content column.
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

import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { SidebarNav } from "../components/Nav/SidebarNavItems";
import { Gamepad2, Plus, PlusCircle, Settings, SlidersHorizontal } from "lucide-react";
import { Metadata } from "next";
import { getOpenGraphMetadata } from "@/lib/utils";
import { MobileNav } from "../components/Nav/MobileNav";
import { getUserById } from "@/db/users";
import { isAdminEmail } from "@/lib/admin";

const ICON_SIZE = 20;

export const dynamic = "force-dynamic";
export const revalidate = 60;
export const fetchCache = "force-no-store";

export const metadata: Metadata = {
    title: "Home",
    ...getOpenGraphMetadata("Home"),
};

const sidebarNavItems: SidebarNavItem[] = [
    {
        title: "Playground",
            href: "/home",
            icon: <Gamepad2 size={ICON_SIZE} />,
        },
        {
            title: "Settings",
            href: "/home/settings",
            icon: <Settings size={ICON_SIZE} />,
        },
        {
            title: "Create new",
            href: "/home/create",
            icon: <Plus size={ICON_SIZE+4} strokeWidth={2.5} />,
            isPrimary: true,
        },
    ];

const adminNavItem: SidebarNavItem = {
    title: "Admin",
    href: "/home/admin",
    icon: <SlidersHorizontal size={ICON_SIZE} />,
};

export default async function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const supabase = createClient();

    const {
        data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
        redirect("/login");
    }

    const dbUser = await getUserById(supabase, user.id);

    if (!dbUser) {
        redirect("/login");
    }

    // Admin is a desktop page and the mobile bar is a fixed three buttons, so
    // it goes in the sidebar only. Adding it to the array below would shift the
    // indices these three are picked by.
    const navItems = isAdminEmail(dbUser.email)
        ? [...sidebarNavItems, adminNavItem]
        : sidebarNavItems;

    const mobileNavItems = [
        sidebarNavItems[0], // Playground
        sidebarNavItems[2], // Create
        sidebarNavItems[1], // Settings
    ];

    return (
        <div className="flex flex-1 flex-col mx-auto w-full max-w-[1400px] gap-2 pb-20 md:pb-2 md:flex-row">
            <aside className="w-full md:w-[270px] sm:py-4 pt-2 md:overflow-y-auto md:fixed md:h-screen">
                <SidebarNav items={navItems} />
            </aside>
            <main className="flex-1 sm:py-4 px-4 flex justify-center md:ml-[270px]">
                <div className="max-w-5xl w-full">{children}</div>
            </main>
            <MobileNav items={mobileNavItems} />
        </div>
    );
}

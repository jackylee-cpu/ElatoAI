import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { Gamepad2, Plus, Settings, SlidersHorizontal } from "lucide-react";
import { Metadata } from "next";
import { getOpenGraphMetadata } from "@/lib/utils";
import { getUserById } from "@/db/users";
import { isAdminEmail } from "@/lib/admin";
import { HomeShell } from "./HomeShell";

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
        icon: <Plus size={ICON_SIZE + 4} strokeWidth={2.5} />,
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
        <HomeShell navItems={navItems} mobileNavItems={mobileNavItems}>
            {children}
        </HomeShell>
    );
}

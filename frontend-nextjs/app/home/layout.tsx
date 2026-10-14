import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { Gamepad2, SlidersHorizontal, User } from "lucide-react";
import { Metadata } from "next";
import { getOpenGraphMetadata } from "@/lib/utils";
import { createUser, getUserById } from "@/db/users";
import { defaultPersonalityId } from "@/lib/data";
import { getAdminRoles } from "@/lib/admin";
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
        title: "Me",
        href: "/home/account",
        icon: <User size={ICON_SIZE} />,
    },
    // No "Create new": parents do not make characters in phase 1. See
    // app/home/create/page.tsx.
];

const adminNavItem: SidebarNavItem = {
    title: "Admin",
    href: "/admin",
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

    // A new account has no public.users row yet: one that signed up without
    // email confirmation, or one an admin created. Make it here rather than in
    // page.tsx, which renders alongside this layout and so lost the race --
    // the first visit bounced to /login and never reached /onboard.
    if (!dbUser) {
        await createUser(supabase, user, {
            personality_id:
                user.user_metadata?.personality_id ?? defaultPersonalityId,
        });
        redirect("/onboard");
    }

    // Admin is a desktop page, so it goes in the sidebar only.
    const adminRoles = await getAdminRoles(supabase, user.id);
    const navItems = adminRoles.length > 0
        ? [...sidebarNavItems, adminNavItem]
        : sidebarNavItems;

    // Playground and Me. "Create" used to sit between them and is gone
    // with /home/create; indexing [2] here would hand MobileNav undefined.
    const mobileNavItems = sidebarNavItems;

    return (
        <HomeShell navItems={navItems} mobileNavItems={mobileNavItems}>
            {children}
        </HomeShell>
    );
}

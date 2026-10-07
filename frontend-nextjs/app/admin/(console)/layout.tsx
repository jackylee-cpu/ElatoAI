import { requireAdmin } from "@/lib/admin";
import { getOpenGraphMetadata } from "@/lib/utils";
import { Metadata } from "next";

export const metadata: Metadata = {
    title: "Admin",
    ...getOpenGraphMetadata("Admin"),
};

export default async function AdminConsoleLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    // The guard runs again inside every server action. This one only stops the
    // page rendering; a server action is reachable without it.
    await requireAdmin();
    return <>{children}</>;
}

import { redirect } from "next/navigation";

// The parent app used to keep a second settings screen here, beside Me.
// Bookmarks still land: child details on My Info, everything else on Me.
export default function SettingsPage({
    searchParams,
}: {
    searchParams: { tab?: string };
}) {
    redirect(searchParams.tab === "setting" ? "/home/account" : "/home/account/child");
}

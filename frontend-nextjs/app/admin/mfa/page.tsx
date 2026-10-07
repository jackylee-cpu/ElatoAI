import { notFound, redirect } from "next/navigation";
import { getAdminSession, hasVerifiedTotp } from "@/lib/admin";
import { getOpenGraphMetadata } from "@/lib/utils";
import { Metadata } from "next";
import MfaForm from "./MfaForm";

export const metadata: Metadata = {
    title: "Admin sign-in",
    ...getOpenGraphMetadata("Admin sign-in"),
};

/**
 * The one admin page that does not need TOTP, because it is where TOTP is set
 * up and entered. It still needs a role: nobody else has a reason to enrol a
 * factor here.
 */
export default async function AdminMfaPage() {
    const session = await getAdminSession();
    if (!session) {
        redirect("/login");
    }
    if (session.roles.length === 0) {
        notFound();
    }
    if (await hasVerifiedTotp(session.supabase)) {
        redirect("/admin");
    }

    return <MfaForm email={session.user.email ?? ""} />;
}

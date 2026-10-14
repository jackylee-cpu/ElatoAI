import ChangePassword from "@/app/components/Account/ChangePassword";
import { getOpenGraphMetadata } from "@/lib/utils";
import { Metadata } from "next";

export const metadata: Metadata = {
    title: "Change Password",
    ...getOpenGraphMetadata("Change Password"),
};

export default function ChangePasswordPage() {
    return <ChangePassword />;
}

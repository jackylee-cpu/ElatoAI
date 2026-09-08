import { Metadata } from "next";
import { getOpenGraphMetadata } from "@/lib/utils";

export const metadata: Metadata = {
    title: "Login",
    ...getOpenGraphMetadata("Login"),
};

export default async function Layout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <div className="flex min-h-dvh w-full flex-1 flex-col items-stretch bg-[#F2F4F7] md:items-center md:justify-center md:p-6 lg:p-10">
            {children}
        </div>
    );
}

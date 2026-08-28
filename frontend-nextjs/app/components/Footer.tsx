"use client";

import { Label } from "@/components/ui/label";
import { usePathname } from "next/navigation";

export default function Footer() {
    const pathname = usePathname();
    const isHome = pathname.includes("/home");
    return (
        <footer
            className={`w-full ${
                isHome ? "pb-16" : "pb-2"
            } border-gray-200 flex flex-col sm:flex-row items-center sm:justify-center border-t-[1px] mx-auto text-center text-xs sm:gap-8 sm:py-1 py-2`}
        >
            <Label className={`font-normal text-xs text-gray-500`}>
               © {new Date().getFullYear()}
            </Label>
        </footer>
    );
}

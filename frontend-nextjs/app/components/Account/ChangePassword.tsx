"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { changePasswordAction } from "@/app/actions";
import { useToast } from "@/components/ui/use-toast";
import { BackIcon } from "../Playground/icons";

const fieldClass =
    "w-full rounded-[20px] border-0 bg-white px-4 py-3.5 text-base text-gray-900 shadow-[0_4px_16px_rgba(80,120,180,0.08)] outline-none placeholder:text-gray-300 focus-visible:ring-2 focus-visible:ring-[#4C74F6]/30";

const labelClass = "mb-2 block text-sm font-medium text-gray-600";

export default function ChangePassword() {
    const router = useRouter();
    const { toast } = useToast();
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setSaving(true);
        setError(null);
        const result = await changePasswordAction(password, confirmPassword);
        setSaving(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        toast({ description: "Your password has been changed." });
        router.push("/home/account/profile");
    };

    return (
        <div className="relative z-10 mx-auto flex h-full w-full max-w-lg flex-col px-4 pt-[max(0.75rem,env(safe-area-inset-top))] md:max-w-xl md:px-8 md:pt-8">
            <header className="relative mb-3 flex h-14 shrink-0 items-center justify-center md:h-16">
                <Link
                    href="/home/account/profile"
                    aria-label="Back to Personal Info"
                    className="absolute left-0 top-1/2 -translate-y-1/2 transition-transform hover:scale-105 active:scale-95"
                >
                    <BackIcon className="h-10 w-10" />
                </Link>
                <h1 className="font-fredoka text-[28px] font-semibold tracking-tight text-gray-900 md:text-[32px]">
                    Change Password
                </h1>
            </header>

            <form
                onSubmit={handleSubmit}
                className="scrollbar-hide flex flex-1 flex-col gap-5 overflow-y-auto pb-[max(2rem,env(safe-area-inset-bottom))] pt-2"
            >
                <label className="block">
                    <span className={labelClass}>New password</span>
                    <input
                        type="password"
                        autoComplete="new-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="At least 6 characters"
                        required
                        className={fieldClass}
                    />
                </label>
                <label className="block">
                    <span className={labelClass}>Confirm password</span>
                    <input
                        type="password"
                        autoComplete="new-password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Type it again"
                        required
                        className={fieldClass}
                    />
                </label>

                {error && (
                    <p role="alert" className="rounded-[16px] bg-[#FDECEC] px-4 py-3 text-sm text-[#D64545]">
                        {error}
                    </p>
                )}

                <button
                    type="submit"
                    disabled={saving}
                    className="mt-2 flex h-14 w-full shrink-0 items-center justify-center rounded-full bg-gradient-to-r from-[#5B6CFF] to-[#3D8BFF] text-base font-semibold tracking-[0.18em] text-white shadow-[0_10px_24px_rgba(80,110,230,0.35)] transition-transform hover:scale-[1.01] active:scale-[0.99] disabled:opacity-70"
                >
                    {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : "SAVE"}
                </button>
            </form>
        </div>
    );
}

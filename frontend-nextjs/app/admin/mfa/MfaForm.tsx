"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Step =
    | { kind: "loading" }
    | { kind: "enroll"; factorId: string; qrCode: string; secret: string }
    | { kind: "verify"; factorId: string }
    | { kind: "error"; message: string };

/**
 * Enrol an authenticator app on the first visit, then ask for a code on every
 * new session. Verifying upgrades the session to aal2, which is what
 * has_role() in the database and the admin pages both require.
 *
 * Losing the authenticator is fixed on the database host by deleting the
 * account's rows in auth.mfa_factors; the next visit here enrols a new one.
 */
export default function MfaForm({ email }: { email: string }) {
    const router = useRouter();
    const [step, setStep] = useState<Step>({ kind: "loading" });
    const [code, setCode] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // React runs effects twice in development; enrolling twice would leave a
    // stray unverified factor behind.
    const started = useRef(false);

    useEffect(() => {
        if (started.current) return;
        started.current = true;

        const supabase = createClient();
        (async () => {
            const { data, error } = await supabase.auth.mfa.listFactors();
            if (error) {
                setStep({ kind: "error", message: error.message });
                return;
            }

            const verified = data.totp.find((factor) => factor.status === "verified");
            if (verified) {
                setStep({ kind: "verify", factorId: verified.id });
                return;
            }

            // An enrolment abandoned before its first code is useless; clear
            // it so enrolling again does not trip over the old one.
            for (const factor of data.all) {
                if (factor.factor_type === "totp" && factor.status !== "verified") {
                    await supabase.auth.mfa.unenroll({ factorId: factor.id });
                }
            }

            const enrolled = await supabase.auth.mfa.enroll({
                factorType: "totp",
                friendlyName: "aibuddy admin",
            });
            if (enrolled.error) {
                setStep({ kind: "error", message: enrolled.error.message });
                return;
            }
            setStep({
                kind: "enroll",
                factorId: enrolled.data.id,
                qrCode: enrolled.data.totp.qr_code,
                secret: enrolled.data.totp.secret,
            });
        })();
    }, []);

    const onSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (step.kind !== "enroll" && step.kind !== "verify") return;

        setBusy(true);
        setError(null);
        const supabase = createClient();
        const { error } = await supabase.auth.mfa.challengeAndVerify({
            factorId: step.factorId,
            code: code.trim(),
        });
        setBusy(false);

        if (error) {
            setError("That code did not work. Check the time on your phone and try the next one.");
            setCode("");
            return;
        }
        router.replace("/admin");
        router.refresh();
    };

    return (
        <div className="relative z-10 mx-auto flex h-full w-full max-w-md flex-col justify-center px-4">
            <div className="rounded-[24px] bg-white/90 p-6 shadow-[0_8px_24px_rgba(80,120,180,0.08)] backdrop-blur-sm">
                <h1 className="font-fredoka text-2xl font-semibold text-gray-900">
                    Admin sign-in
                </h1>
                <p className="mt-1 text-sm text-gray-500">{email}</p>

                {step.kind === "loading" && (
                    <p className="mt-6 text-sm text-gray-500">Loading…</p>
                )}

                {step.kind === "error" && (
                    <p className="mt-6 text-sm text-red-600">{step.message}</p>
                )}

                {step.kind === "enroll" && (
                    <div className="mt-5 flex flex-col gap-3 text-sm text-gray-600">
                        <p>
                            Admin needs an authenticator app. Scan this with
                            Google Authenticator, 1Password or similar, then
                            enter the 6-digit code it shows.
                        </p>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                            src={step.qrCode}
                            alt="Authenticator QR code"
                            className="mx-auto h-48 w-48 rounded-xl bg-white p-2"
                        />
                        <p className="text-xs">
                            Can&apos;t scan? Enter this key:{" "}
                            <code className="break-all font-mono text-gray-900">
                                {step.secret}
                            </code>
                        </p>
                    </div>
                )}

                {step.kind === "verify" && (
                    <p className="mt-5 text-sm text-gray-600">
                        Enter the 6-digit code from your authenticator app.
                    </p>
                )}

                {(step.kind === "enroll" || step.kind === "verify") && (
                    <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
                        <Input
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            pattern="[0-9]{6}"
                            maxLength={6}
                            placeholder="123456"
                            value={code}
                            onChange={(event) => setCode(event.target.value)}
                            autoFocus
                            required
                        />
                        {error && <p className="text-sm text-red-600">{error}</p>}
                        <Button type="submit" disabled={busy || code.trim().length !== 6}>
                            {busy ? "Checking…" : "Continue"}
                        </Button>
                    </form>
                )}

                <Link href="/home" className="mt-4 block text-center text-xs text-gray-500 hover:text-gray-700">
                    Back to playground
                </Link>
            </div>
        </div>
    );
}

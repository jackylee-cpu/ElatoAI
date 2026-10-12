"use client";

import { useState } from "react";
import Link from "next/link";
import { Eye, EyeOff, Lock, Mail, MailCheck } from "lucide-react";
import { SubmitButton } from "../login/submit-button";
import { authLink } from "../authLink";
import { MIN_PASSWORD_LENGTH } from "@/lib/passwords";


interface SignUpFormProps {
  formAction: (formData: FormData) => Promise<void>;
  message?: string;
  sent: boolean;
  toy_id?: string;
  personality_id?: string;
}

const fieldClass =
  "h-12 w-full rounded-2xl border border-[#E8EAF0] bg-white pl-11 pr-4 text-[15px] text-[#1A1C2B] outline-none placeholder:text-[#B0B5C3] transition focus:border-[#6B67FF]/45 focus:shadow-[0_0_0_4px_rgba(107,103,255,0.10)]";

const iconClass =
  "pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#B0B5C3]";

export default function SignUpForm({
  formAction,
  message,
  sent,
  toy_id,
  personality_id,
}: SignUpFormProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [mismatch, setMismatch] = useState(false);

  const loginHref = authLink("/login", toy_id, personality_id);

  if (sent) {
    return (
      <section className="relative z-10 flex flex-1 flex-col rounded-t-[1.75rem] bg-white px-6 pb-8 pt-6 md:justify-center md:rounded-none md:px-10 md:py-10 lg:px-14">
        <div className="mx-auto w-full max-w-sm text-center md:max-w-[360px]">
          <MailCheck className="mx-auto h-10 w-10 text-[#6B67FF]" strokeWidth={1.5} />
          <h2 className="mt-4 text-[1.375rem] font-bold tracking-tight text-[#1A1C2B] md:text-[1.625rem]">
            Check your email
          </h2>
          <p className="mt-2 text-sm leading-6 text-[#8B90A0]">
            We sent you a link to confirm your address. Open it on this device
            to finish creating your account. If it is not there in a few
            minutes, look in your spam folder.
          </p>
          <Link
            href={loginHref}
            className="mt-6 inline-block text-sm font-semibold text-[#6B67FF] hover:text-[#4DA6FF]"
          >
            Back to log in
          </Link>
        </div>
      </section>
    );
  }

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    const form = new FormData(event.currentTarget);
    const differ = form.get("password") !== form.get("confirm_password");
    setMismatch(differ);
    if (differ) {
      event.preventDefault();
    }
  };

  return (
    <section className="relative z-10 flex flex-1 flex-col rounded-t-[1.75rem] bg-white px-6 pb-8 pt-6 md:justify-center md:rounded-none md:px-10 md:py-10 lg:px-14">
      <div className="mx-auto w-full max-w-sm md:max-w-[360px]">
        <div className="mb-6">
          <h2 className="text-[1.375rem] font-bold tracking-tight text-[#1A1C2B] md:text-[1.625rem]">
            Create your account ✨
          </h2>
          <p className="mt-1 text-sm leading-5 text-[#8B90A0]">
            Sign up to set up your Buddy and pair your toy.
          </p>
        </div>

        <form className="flex flex-col gap-3" action={formAction} onSubmit={onSubmit}>
          <label className="relative block">
            <span className="sr-only">Email address</span>
            <Mail className={iconClass} strokeWidth={1.75} />
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="Email address"
              className={fieldClass}
            />
          </label>

          <label className="relative block">
            <span className="sr-only">Password</span>
            <Lock className={iconClass} strokeWidth={1.75} />
            <input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              placeholder={`Password (at least ${MIN_PASSWORD_LENGTH} characters)`}
              className={`${fieldClass} pr-11`}
            />
            <button
              type="button"
              aria-label={showPassword ? "Hide password" : "Show password"}
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-[#B0B5C3] hover:text-[#6B7280]"
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" strokeWidth={1.75} />
              ) : (
                <Eye className="h-4 w-4" strokeWidth={1.75} />
              )}
            </button>
          </label>

          <label className="relative block">
            <span className="sr-only">Confirm password</span>
            <Lock className={iconClass} strokeWidth={1.75} />
            <input
              id="confirm_password"
              name="confirm_password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              placeholder="Confirm password"
              onChange={() => setMismatch(false)}
              aria-invalid={mismatch}
              className={`${fieldClass} ${mismatch ? "border-red-300" : ""}`}
            />
          </label>
          {mismatch && (
            <p className="-mt-1 px-1 text-xs text-red-500">
              The two passwords do not match.
            </p>
          )}

          <SubmitButton
            formAction={formAction}
            pendingText="Creating account..."
            className="mt-1 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#6B67FF] to-[#4DA6FF] text-[15px] font-semibold text-white shadow-[0_10px_24px_rgba(107,103,255,0.32)] transition active:scale-[0.98] disabled:opacity-70"
          >
            Sign Up <span aria-hidden>→</span>
          </SubmitButton>

          {message && (
            <p className="rounded-2xl bg-[#F3F5FC] px-4 py-3 text-center text-sm text-[#1A1C2B]">
              {message}
            </p>
          )}
        </form>

        <p className="mt-6 text-center text-sm text-[#8B90A0] md:mt-8">
          Already have an account?{" "}
          <Link
            href={loginHref}
            className="font-semibold text-[#6B67FF] hover:text-[#4DA6FF]"
          >
            Log in
          </Link>
        </p>
      </div>
    </section>
  );
}

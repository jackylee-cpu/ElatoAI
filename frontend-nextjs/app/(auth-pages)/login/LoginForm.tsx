"use client";

import { useState } from "react";
import Link from "next/link";
import { Eye, EyeOff, Lock, Mail } from "lucide-react";
import { FaApple, FaFacebook, FaGoogle } from "react-icons/fa";
import { SubmitButton } from "./submit-button";
import { loginWithGoogle } from "../../components/GoogleLoginButton";
import { defaultPersonalityId, defaultToyId } from "@/lib/data";

interface LoginFormProps {
  formAction: (formData: FormData) => Promise<void>;
  message?: string;
  toy_id?: string;
  personality_id?: string;
  isGoogleOAuthEnabled: boolean;
}

const fieldClass =
  "h-12 w-full rounded-2xl border border-[#E8EAF0] bg-white pl-11 pr-4 text-[15px] text-[#1A1C2B] outline-none placeholder:text-[#B0B5C3] transition focus:border-[#6B67FF]/45 focus:shadow-[0_0_0_4px_rgba(107,103,255,0.10)]";

const socialClass =
  "flex h-11 items-center justify-center gap-1.5 rounded-2xl border border-[#E8EAF0] bg-white text-[11px] font-medium text-[#1A1C2B] sm:text-xs";

export default function LoginForm({
  formAction,
  message,
  toy_id,
  personality_id,
  isGoogleOAuthEnabled,
}: LoginFormProps) {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <section className="relative z-10 flex flex-1 flex-col rounded-t-[1.75rem] bg-white px-6 pb-8 pt-6 md:-mt-0 md:justify-center md:rounded-none md:px-10 md:py-10 lg:px-14">
      <div className="mx-auto w-full max-w-sm md:max-w-[360px]">
        <div className="mb-6">
          <h2 className="text-[1.375rem] font-bold tracking-tight text-[#1A1C2B] md:text-[1.625rem]">
            Welcome back 👋
          </h2>
          <p className="mt-1 text-sm leading-5 text-[#8B90A0]">
            Log in to continue your journey with Buddy.
          </p>
        </div>

        <form className="flex flex-col gap-3" action={formAction}>
          <label className="relative block">
            <span className="sr-only">Email address</span>
            <Mail
              className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#B0B5C3]"
              strokeWidth={1.75}
            />
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
            <Lock
              className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#B0B5C3]"
              strokeWidth={1.75}
            />
            <input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              required
              placeholder="Password"
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

          <div className="flex items-center justify-between py-0.5">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-[#6B7280]">
              <input
                type="checkbox"
                name="remember"
                className="h-4 w-4 rounded border-[#D1D5DB] accent-[#6B67FF]"
              />
              Remember me
            </label>
            <Link
              href="/forgot-password"
              className="text-sm font-medium text-[#6B67FF] hover:text-[#4DA6FF]"
            >
              Forgot password?
            </Link>
          </div>

          <SubmitButton
            formAction={formAction}
            pendingText="Signing in..."
            className="mt-1 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#6B67FF] to-[#4DA6FF] text-[15px] font-semibold text-white shadow-[0_10px_24px_rgba(107,103,255,0.32)] transition active:scale-[0.98] disabled:opacity-70"
          >
            Log In <span aria-hidden>→</span>
          </SubmitButton>

          {message && (
            <p className="rounded-2xl bg-[#F3F5FC] px-4 py-3 text-center text-sm text-[#1A1C2B]">
              {message}
            </p>
          )}
        </form>

        <p className="mt-3 rounded-2xl bg-[#F3F5FC] px-4 py-3 text-center text-xs leading-5 text-[#8B90A0]">
          Local admin:{" "}
          <span className="font-medium text-[#1A1C2B]">admin@elatoai.com</span>
          {" / "}
          <span className="font-medium text-[#1A1C2B]">admin</span>
        </p>

        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-[#E8EAF0]" />
          <span className="shrink-0 text-xs text-[#9CA3AF]">Or continue with</span>
          <div className="h-px flex-1 bg-[#E8EAF0]" />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <button type="button" disabled className={`${socialClass} opacity-40`} title="Coming soon">
            <FaApple className="h-3.5 w-3.5" />
            Apple
          </button>
          <button
            type="button"
            disabled={!isGoogleOAuthEnabled}
            onClick={() =>
              loginWithGoogle(
                toy_id ?? defaultToyId,
                personality_id ?? defaultPersonalityId
              )
            }
            className={`${socialClass} hover:bg-[#F8F9FB] disabled:opacity-40`}
          >
            <FaGoogle className="h-3.5 w-3.5 text-[#EA4335]" />
            Google
          </button>
          <button type="button" disabled className={`${socialClass} opacity-40`} title="Coming soon">
            <FaFacebook className="h-3.5 w-3.5 text-[#1877F2]" />
            Facebook
          </button>
        </div>

        <p className="mt-6 text-center text-sm text-[#8B90A0] md:mt-8">
          Don&apos;t have an account?{" "}
          <span className="font-semibold text-[#6B67FF]">Sign up</span>
        </p>
      </div>
    </section>
  );
}

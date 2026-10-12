import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { getBaseUrl } from "@/lib/utils";
import AuthHero from "../AuthHero";
import { MIN_PASSWORD_LENGTH } from "@/lib/passwords";
import SignUpForm from "./SignUpForm";

interface SignUpProps {
  searchParams?: { [key: string]: string | string[] | undefined };
}

/**
 * Create an account with email and password.
 *
 * Production has mailer_autoconfirm off, so signUp() returns no session and
 * GoTrue mails a confirmation link to /auth/callback, which creates the
 * public.users row and sends the new parent to /onboard. Where autoconfirm is
 * on (local Supabase) a session comes back at once and /home does the same.
 */
export default async function SignUp({ searchParams }: SignUpProps) {
  const toy_id = searchParams?.toy_id as string | undefined;
  const personality_id = searchParams?.personality_id as string | undefined;
  const message =
    typeof searchParams?.message === "string" ? searchParams.message : undefined;
  const sent = searchParams?.sent === "1";

  const signUp = async (formData: FormData) => {
    "use server";

    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    const password = String(formData.get("password") ?? "");
    const confirm = String(formData.get("confirm_password") ?? "");

    const back = (params: Record<string, string>) => {
      const query = new URLSearchParams(params);
      if (toy_id) query.set("toy_id", toy_id);
      if (personality_id) query.set("personality_id", personality_id);
      return redirect(`/signup?${query}`);
    };

    // The form checks these too; a server action can be called without it.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return back({ message: "Enter a valid email address." });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return back({
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
    }
    if (password !== confirm) {
      return back({ message: "The two passwords do not match." });
    }

    const supabase = createClient();
    const origin = headers().get("origin") ?? getBaseUrl();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { toy_id, personality_id },
        emailRedirectTo: `${origin}/auth/callback`,
      },
    });

    if (error) {
      return back({ message: signUpMessage(error) });
    }
    if (data.session) {
      return redirect("/home");
    }
    // With confirmations on, GoTrue answers an existing address with a
    // look-alike user that has no identities, rather than an error, so that
    // sign-up cannot be used to test which emails have accounts. Saying so
    // here gives that away; for a parent who forgot they signed up, telling
    // them is worth more.
    if (data.user && data.user.identities?.length === 0) {
      return back({ message: ALREADY_REGISTERED });
    }
    return back({ sent: "1" });
  };

  return (
    <article className="flex min-h-dvh w-full flex-col overflow-hidden bg-white md:min-h-[560px] md:w-full md:max-w-[960px] md:flex-row md:rounded-[2rem] md:shadow-[0_24px_60px_rgba(107,103,255,0.12)]">
      <AuthHero />

      <SignUpForm
        formAction={signUp}
        message={message}
        sent={sent}
        toy_id={toy_id}
        personality_id={personality_id}
      />
    </article>
  );
}

const ALREADY_REGISTERED =
  "An account with this email already exists. Log in instead, or reset the password.";

// Older GoTrue releases send no `code`, so the message is checked as well.
function signUpMessage(error: { code?: string; message: string }): string {
  if (
    error.code === "user_already_exists" ||
    error.code === "email_exists" ||
    /already registered/i.test(error.message)
  ) {
    return ALREADY_REGISTERED;
  }
  if (error.code === "over_email_send_rate_limit" || /rate limit/i.test(error.message)) {
    return "Too many sign-ups just now. Please try again in a few minutes.";
  }
  if (error.code === "signup_disabled") {
    return "New sign-ups are closed. Ask us for an account.";
  }
  if (/sending confirmation/i.test(error.message)) {
    return "We could not send the confirmation email. Please try again later.";
  }
  return error.message;
}

import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import LoginForm from "./LoginForm";
import AuthHero from "../AuthHero";

interface LoginProps {
  searchParams?: { [key: string]: string | string[] | undefined };
}

/**
 * Sign in only. It used to fall through to signUp() on any failed sign-in, so a
 * mistyped password for an existing account answered "check your email" and a
 * typo in the address silently created a second account. Sign-up is /signup.
 */
export default async function Login({ searchParams }: LoginProps) {
  const toy_id = searchParams?.toy_id as string | undefined;
  const personality_id = searchParams?.personality_id as string | undefined;
  const isGoogleOAuthEnabled = process.env.GOOGLE_OAUTH === "True";
  const message =
    typeof searchParams?.message === "string"
      ? searchParams.message
      : undefined;

  const signIn = async (formData: FormData) => {
    "use server";

    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    const supabase = createClient();

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (!error) {
      return redirect("/home");
    }

    return redirect(`/login?${new URLSearchParams({ message: signInMessage(error) })}`);
  };

  return (
    <article className="flex min-h-dvh w-full flex-col overflow-hidden bg-white md:min-h-[560px] md:w-full md:max-w-[960px] md:flex-row md:rounded-[2rem] md:shadow-[0_24px_60px_rgba(107,103,255,0.12)]">
      <AuthHero />

      <LoginForm
        formAction={signIn}
        message={message}
        toy_id={toy_id}
        personality_id={personality_id}
        isGoogleOAuthEnabled={isGoogleOAuthEnabled}
      />
    </article>
  );
}

// Older GoTrue releases send no `code`, so the message is checked as well.
function signInMessage(error: { code?: string; message: string }): string {
  if (error.code === "invalid_credentials" || /invalid login credentials/i.test(error.message)) {
    return "Wrong email or password.";
  }
  if (error.code === "email_not_confirmed" || /email not confirmed/i.test(error.message)) {
    return "Please confirm your email first -- open the link we sent you.";
  }
  return error.message;
}

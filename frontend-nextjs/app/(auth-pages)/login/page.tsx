import { headers } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import LoginForm from "./LoginForm";

interface LoginProps {
  searchParams?: { [key: string]: string | string[] | undefined };
}

export default async function Login({ searchParams }: LoginProps) {
  const toy_id = searchParams?.toy_id as string | undefined;
  const personality_id = searchParams?.personality_id as string | undefined;
  const isGoogleOAuthEnabled = process.env.GOOGLE_OAUTH === "True";
  const message =
    typeof searchParams?.message === "string"
      ? searchParams.message
      : undefined;

  const signInOrSignUp = async (formData: FormData) => {
    "use server";

    const email = formData.get("email") as string;
    const password = formData.get("password") as string;
    const supabase = createClient();

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (!signInError) {
      return redirect("/home");
    }

    const origin = headers().get("origin");
    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          toy_id: toy_id,
          personality_id: personality_id,
        },
        emailRedirectTo: `${origin}/auth/callback`,
      },
    });

    if (signUpError) {
      return redirect(`/login?message=${signUpError.message}`);
    }

    return redirect("/login?message=Check email to continue sign in process");
  };

  return (
    <article className="flex min-h-dvh w-full flex-col overflow-hidden bg-white md:min-h-[560px] md:w-full md:max-w-[960px] md:flex-row md:rounded-[2rem] md:shadow-[0_24px_60px_rgba(107,103,255,0.12)]">
      <header className="relative shrink-0 md:w-[46%] md:min-h-[560px]">
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-b from-[#EEF0FF] via-[#F3F5FC] to-white md:bg-gradient-to-br md:from-[#E8EAFF] md:via-[#F4F6FB] md:to-[#EEF7FF]"
        />
        <div
          aria-hidden
          className="absolute inset-0 bg-[url('/brand/login-hero.png')] bg-[length:130%_auto] bg-[center_bottom] bg-no-repeat md:bg-cover md:bg-[right_center]"
        />
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-white to-transparent md:hidden"
        />

        <div className="relative z-10 px-6 pb-2 pt-10 md:px-10 md:pt-10">
          <h1 className="text-[1.875rem] font-bold leading-none tracking-tight md:text-[2.125rem]">
            <span className="relative inline-block bg-gradient-to-r from-[#6B67FF] to-[#4DA6FF] bg-clip-text pr-2 text-transparent">
              Ai
              <span
                aria-hidden
                className="absolute -right-0.5 -top-1 text-[10px] text-[#6B67FF]"
              >
                ✦
              </span>
            </span>
            <span className="text-[#1A1C2B]">Buddy</span>
          </h1>
          <p className="mt-2 max-w-[240px] text-[13px] leading-5 text-[#8B90A0] md:max-w-[280px] md:text-sm md:leading-6">
            Your AI toy companion, always here to learn and play with you.
          </p>
        </div>

        <div className="relative h-40 w-full sm:h-48 md:hidden" />
      </header>

      <LoginForm
        formAction={signInOrSignUp}
        message={message}
        toy_id={toy_id}
        personality_id={personality_id}
        isGoogleOAuthEnabled={isGoogleOAuthEnabled}
      />
    </article>
  );
}

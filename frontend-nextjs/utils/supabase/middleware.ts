import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

// Routes that need a signed-in account, and those that also need an admin role.
const SIGNED_IN = ["/home", "/admin", "/api/admin"];
const ADMIN = ["/admin", "/api/admin"];
// Where an admin who has not passed TOTP this session is sent. It needs the
// role but not aal2, or nobody could ever reach aal2.
const MFA_PAGE = "/admin/mfa";

function under(pathname: string, prefixes: string[]): boolean {
  return prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

/**
 * Refresh the Supabase session cookie on every request, and turn away requests
 * for protected routes before they render.
 *
 * Pages and server actions check again themselves (lib/admin.ts) and the
 * database checks has_role() under them, so this is the first of three lines.
 * It fails closed: if Supabase cannot be reached, a protected route redirects
 * to /login rather than rendering.
 */
export const updateSession = async (request: NextRequest) => {
  const { pathname } = request.nextUrl;

  // The admin page used to live under /home; keep old bookmarks working.
  if (pathname === "/home/admin" || pathname.startsWith("/home/admin/")) {
    const url = request.nextUrl.clone();
    url.pathname = pathname.replace(/^\/home\/admin/, "/admin");
    return NextResponse.redirect(url);
  }

  const isApi = pathname.startsWith("/api/");
  const deny = (status: 401 | 403, to: string) => {
    if (isApi) {
      return NextResponse.json({ error: "Forbidden" }, { status });
    }
    return NextResponse.redirect(new URL(to, request.url));
  };

  let response = NextResponse.next({ request });

  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value)
            );
            response = NextResponse.next({ request });
            cookiesToSet.forEach(({ name, value, options }) =>
              response.cookies.set(name, value, options)
            );
          },
        },
      }
    );

    // Refreshes the session if it expired -- required for Server Components.
    // https://supabase.com/docs/guides/auth/server-side/nextjs
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!under(pathname, SIGNED_IN)) {
      return response;
    }
    if (!user) {
      return deny(401, "/login");
    }
    if (!under(pathname, ADMIN)) {
      return response;
    }

    const { data: roles, error } = await supabase
      .from("admin_roles")
      .select("role")
      .eq("user_id", user.id);
    if (error || !roles || roles.length === 0) {
      return deny(403, "/home");
    }

    if (pathname !== MFA_PAGE) {
      const { data: aal } =
        await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.currentLevel !== "aal2") {
        return deny(403, MFA_PAGE);
      }
    }

    return response;
  } catch (e) {
    console.error("middleware could not check the session", e);
    if (under(pathname, SIGNED_IN)) {
      return deny(401, "/login");
    }
    return NextResponse.next({ request });
  }
};

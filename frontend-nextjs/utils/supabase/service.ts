import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase client backed by the service role key.
 *
 * The device-facing API routes act on behalf of hardware that has no Supabase
 * session, so they cannot use the cookie-backed client in `./server`. Server
 * only -- importing this from a "use client" file would ship the service role
 * key to the browser.
 */
export const createServiceClient = () =>
    createSupabaseClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false, autoRefreshToken: false } },
    );

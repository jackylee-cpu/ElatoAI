import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { issueBindTicket } from "@/db/devices";
import {
    BIND_TICKET_TTL_SECONDS,
    BIND_TICKETS_PER_MINUTE,
    hashBindTicket,
    newBindTicket,
} from "@/lib/deviceAuth";

const noStore = { "Cache-Control": "no-store" };

/**
 * The signed-in account, from the session cookie the web app runs on, or from
 * `Authorization: Bearer <Supabase access token>` for a caller without the
 * cookie, such as the native shell or a test script.
 */
const signedInUserId = async (req: Request): Promise<string | null> => {
    const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const { data: { user } } = bearer
        ? await createServiceClient().auth.getUser(bearer)
        : await createClient().auth.getUser();
    return user?.id ?? null;
};

/**
 * POST: a bind ticket for the signed-in account (P0-11).
 *
 * The app hands it to a board over Bluetooth with the WiFi password; the board
 * presents it to /api/generate_auth_token and becomes this account's. It is
 * good once, for one board, for five minutes, and only its hash is kept.
 *
 *   200  { ticket, expires_at, expires_in }
 *   401  nobody is signed in
 *   429  this account asked for five already in the last minute
 */
export async function POST(req: Request) {
    const userId = await signedInUserId(req);
    if (!userId) {
        return NextResponse.json({ error: "Sign in first" }, { status: 401, headers: noStore });
    }

    const ticket = newBindTicket();
    let expiresAt: string | null;
    try {
        expiresAt = await issueBindTicket(
            createServiceClient(),
            userId,
            hashBindTicket(ticket),
            BIND_TICKET_TTL_SECONDS,
            BIND_TICKETS_PER_MINUTE,
        );
    } catch (error) {
        console.error("device_bind_ticket: could not issue", error);
        return NextResponse.json({ error: "Could not issue a ticket" }, { status: 500, headers: noStore });
    }

    if (!expiresAt) {
        return NextResponse.json(
            { error: "Too many tickets, try again in a minute" },
            { status: 429, headers: { ...noStore, "Retry-After": "60" } },
        );
    }

    return NextResponse.json(
        { ticket, expires_at: expiresAt, expires_in: BIND_TICKET_TTL_SECONDS },
        { headers: noStore },
    );
}

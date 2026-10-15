-- Claiming a board takes a bind ticket, not a code anyone can read (P0-11).
--
-- Until now any signed-in account could list every board that had called home
-- in the last ten minutes and take one, and a pairing code moved a board to
-- whoever typed it, owner or not. The board has no screen, so nothing it could
-- show proves the person claiming it is holding it.
--
-- Now the app, signed in, asks for a bind ticket and hands it to the board over
-- Bluetooth together with the WiFi password (R-21): being close enough to do
-- that is the proof. The board, once online, presents the ticket with its own
-- device secret to /api/generate_auth_token, and claim_device_with_ticket binds
-- it to the ticket's account. A ticket is good for one board, once, for five
-- minutes. A board that already has an owner is never taken: its owner unbinds
-- it first, or an admin does (R-11).
--
-- Brands need nothing here. Each brand runs its own database (R-34), so a
-- ticket issued by one brand's app does not exist in another brand's database
-- and is refused like any unknown ticket.
--
-- Only the ticket's SHA-256 is stored, like device_secrets: whoever reads this
-- table cannot claim a board with what is in it. Re-runnable.

CREATE TABLE IF NOT EXISTS public.device_bind_tickets (
    ticket_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.users (user_id) ON UPDATE CASCADE ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    device_id uuid REFERENCES public.devices (device_id) ON DELETE SET NULL
);

COMMENT ON TABLE public.device_bind_tickets IS
    'One-time tickets the app hands a board over Bluetooth so the board can claim itself for that account (P0-11)';
COMMENT ON COLUMN public.device_bind_tickets.ticket_hash IS
    'SHA-256 (hex) of the ticket; the ticket itself is never stored';
COMMENT ON COLUMN public.device_bind_tickets.device_id IS
    'The board that used it, so the same board presenting it again is answered the same way';

-- The rate limit counts an account's tickets from the last minute.
CREATE INDEX IF NOT EXISTS device_bind_tickets_user_created_idx
    ON public.device_bind_tickets (user_id, created_at DESC);

-- Nothing but the web app's server touches tickets.
ALTER TABLE public.device_bind_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.device_bind_tickets FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.device_bind_tickets TO service_role;

-- ── issue ───────────────────────────────────────────────────────────────────

-- Record a new ticket for this account. Returns when it expires, or NULL when
-- the account has asked for p_per_minute tickets in the last minute already
-- and must wait.
--
-- The advisory lock makes the count and the insert one step per account, so
-- a burst of parallel requests cannot all see four and all get in.
CREATE OR REPLACE FUNCTION public.issue_device_bind_ticket(
    p_user_id uuid,
    p_ticket_hash text,
    p_ttl_seconds integer DEFAULT 300,
    p_per_minute integer DEFAULT 5
)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    recent integer;
    expires timestamptz := now() + make_interval(secs => p_ttl_seconds);
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('device_bind_ticket:' || p_user_id::text, 0));

    SELECT count(*) INTO recent
    FROM public.device_bind_tickets
    WHERE user_id = p_user_id AND created_at > now() - interval '1 minute';

    IF recent >= p_per_minute THEN
        RETURN NULL;
    END IF;

    -- Spent and expired tickets are worth nothing a day on; keep the table to
    -- what could still matter.
    DELETE FROM public.device_bind_tickets
    WHERE user_id = p_user_id AND expires_at < now() - interval '1 day';

    INSERT INTO public.device_bind_tickets (ticket_hash, user_id, expires_at)
    VALUES (p_ticket_hash, p_user_id, expires);

    RETURN expires;
END;
$$;

-- ── claim ───────────────────────────────────────────────────────────────────

-- Bind a board to the account a ticket was issued to. One transaction: the
-- ticket is spent exactly when the board changes hands. Returns
--
--   'claimed'         the board was unowned and is now the ticket's account's
--   'already_yours'   the board already belongs to that account -- the owner
--                     gave it new WiFi, or the board asked twice because the
--                     first answer was lost; nothing changes but the ticket
--                     is spent
--   'device_owned'    another account owns the board; nothing changes and the
--                     ticket stays good for another board
--   'ticket_invalid'  no such ticket, or it expired, or another board used it
--
-- The caller has already checked the board's device secret.
CREATE OR REPLACE FUNCTION public.claim_device_with_ticket(
    p_device_id uuid,
    p_ticket_hash text
)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    ticket public.device_bind_tickets%ROWTYPE;
    owner uuid;
BEGIN
    -- Ticket first, then board, in every caller, so two claims never wait on
    -- each other in opposite orders. unbind_device locks only the board.
    SELECT * INTO ticket
    FROM public.device_bind_tickets
    WHERE ticket_hash = p_ticket_hash
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN 'ticket_invalid';
    END IF;

    SELECT user_id INTO owner
    FROM public.devices
    WHERE device_id = p_device_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'no device %', p_device_id;
    END IF;

    IF ticket.used_at IS NOT NULL THEN
        -- The same board asking again with the ticket it just used, and still
        -- owned by that account: tell it the same thing as the first time.
        IF ticket.device_id = p_device_id AND owner = ticket.user_id THEN
            RETURN 'already_yours';
        END IF;
        RETURN 'ticket_invalid';
    END IF;

    IF ticket.expires_at <= now() THEN
        RETURN 'ticket_invalid';
    END IF;

    IF owner IS NOT NULL AND owner <> ticket.user_id THEN
        RETURN 'device_owned';
    END IF;

    IF owner IS NULL THEN
        UPDATE public.devices
        SET user_id = ticket.user_id, claimed_at = now()
        WHERE device_id = p_device_id;
    END IF;

    UPDATE public.device_bind_tickets
    SET used_at = now(), device_id = p_device_id
    WHERE ticket_hash = p_ticket_hash;

    RETURN CASE WHEN owner IS NULL THEN 'claimed' ELSE 'already_yours' END;
END;
$$;

-- Both take the account or trust the caller to have checked the board, so only
-- the web app's server may call them. Supabase grants EXECUTE on new functions
-- in `public` to anon and authenticated by default.
REVOKE ALL ON FUNCTION public.issue_device_bind_ticket(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_device_with_ticket(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_device_bind_ticket(uuid, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_device_with_ticket(uuid, text) TO service_role;

-- Usage and cost per toy (P2-09).
--
-- turn_metrics already had LLM tokens. It gains what the other two providers
-- bill on, and which board the turn ran on:
--
--   stt_audio_ms  audio actually sent to the recognizer (Azure bills streamed
--                 audio by the second), as pipecat's STTUsageMetricsData
--                 reports it.
--   tts_chars     characters sent to TTS (MiniMax bills per character), from
--                 TTSUsageMetricsData.
--   device_id     the board, from the verified device token. NULL for the web
--                 playground, which has no board.
--   row_kind      'turn'   a conversational turn, as before;
--                 'usage'  usage that arrived with no turn to attach to (a
--                          press with nothing said, audio still streaming when
--                          the session ended);
--                 'memory' a memory consolidation call, which runs outside the
--                          voice pipeline but is billed by OpenRouter all the
--                          same.
--                 The latency tab reads 'turn' rows only.
--
-- Prices are not stored per row. The LLM price comes from OpenRouter's
-- catalogue for the model on the row; the STT and TTS rates and the exchange
-- rate live in app_settings under 'usage_rates', so a corrected rate fixes
-- every month at once.
--
-- Re-runnable: IF NOT EXISTS, ON CONFLICT DO NOTHING, CREATE OR REPLACE.

ALTER TABLE public.turn_metrics
    ADD COLUMN IF NOT EXISTS device_id uuid
        REFERENCES public.devices (device_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS stt_audio_ms integer,
    ADD COLUMN IF NOT EXISTS tts_chars integer,
    ADD COLUMN IF NOT EXISTS row_kind text NOT NULL DEFAULT 'turn';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'turn_metrics_row_kind_check'
          AND conrelid = 'public.turn_metrics'::regclass
    ) THEN
        ALTER TABLE public.turn_metrics
            ADD CONSTRAINT turn_metrics_row_kind_check
            CHECK (row_kind IN ('turn', 'usage', 'memory'));
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS turn_metrics_device_created_idx
    ON public.turn_metrics (device_id, created_at DESC);

-- Starting rates, to be checked against the first bills (P2-09's test):
--   Azure Speech-to-Text, standard real-time: US$1 per audio hour.
--   MiniMax speech-2.6-turbo: US$60 per million characters.
INSERT INTO public.app_settings (key, value)
VALUES (
    'usage_rates',
    '{"stt_usd_per_hour": 1.0, "tts_usd_per_million_chars": 60, "usd_to_hkd": 7.8}'::jsonb
)
ON CONFLICT (key) DO NOTHING;

-- ── aggregates for the Usage page ────────────────────────────────────────────
-- Summed in the database so the page never pulls a month of rows. SECURITY
-- DEFINER only to name each board by its MAC: devices is owner-only and has no
-- admin policy, and these return nothing about a board but its MAC.

CREATE OR REPLACE FUNCTION public.admin_usage_by_device(
    p_from timestamptz,
    p_to   timestamptz
)
RETURNS TABLE (
    device_id         uuid,
    mac_address       text,
    llm_model         text,
    turns             bigint,
    stt_audio_ms      bigint,
    tts_chars         bigint,
    prompt_tokens     bigint,
    completion_tokens bigint,
    last_at           timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT public.has_role('super_admin') THEN
        RAISE EXCEPTION 'only a super admin can read usage'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT t.device_id,
           d.mac_address,
           t.llm_model,
           count(*) FILTER (WHERE t.row_kind = 'turn'),
           coalesce(sum(t.stt_audio_ms), 0)::bigint,
           coalesce(sum(t.tts_chars), 0)::bigint,
           coalesce(sum(t.prompt_tokens), 0)::bigint,
           coalesce(sum(t.completion_tokens), 0)::bigint,
           max(t.created_at)
      FROM public.turn_metrics AS t
      LEFT JOIN public.devices AS d ON d.device_id = t.device_id
     WHERE t.created_at >= p_from
       AND t.created_at < p_to
     GROUP BY t.device_id, d.mac_address, t.llm_model;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_usage_by_day(
    p_from     timestamptz,
    p_to       timestamptz,
    p_timezone text DEFAULT 'Asia/Hong_Kong'
)
RETURNS TABLE (
    day               date,
    llm_model         text,
    turns             bigint,
    devices           bigint,
    stt_audio_ms      bigint,
    tts_chars         bigint,
    prompt_tokens     bigint,
    completion_tokens bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT public.has_role('super_admin') THEN
        RAISE EXCEPTION 'only a super admin can read usage'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT (t.created_at AT TIME ZONE p_timezone)::date,
           t.llm_model,
           count(*) FILTER (WHERE t.row_kind = 'turn'),
           count(DISTINCT t.device_id),
           coalesce(sum(t.stt_audio_ms), 0)::bigint,
           coalesce(sum(t.tts_chars), 0)::bigint,
           coalesce(sum(t.prompt_tokens), 0)::bigint,
           coalesce(sum(t.completion_tokens), 0)::bigint
      FROM public.turn_metrics AS t
     WHERE t.created_at >= p_from
       AND t.created_at < p_to
     GROUP BY 1, 2;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_usage_by_device(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_usage_by_device(timestamptz, timestamptz) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_usage_by_day(timestamptz, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_usage_by_day(timestamptz, timestamptz, text) TO authenticated;

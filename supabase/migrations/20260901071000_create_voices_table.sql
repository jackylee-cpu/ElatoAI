CREATE TABLE IF NOT EXISTS public.voices (
    voice_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    provider text NOT NULL,
    status text NOT NULL DEFAULT 'complete',
    user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.voices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public voices are viewable by everyone"
ON public.voices FOR SELECT
USING (user_id IS NULL OR auth.uid() = user_id);

CREATE POLICY "Users can manage their own voices"
ON public.voices FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

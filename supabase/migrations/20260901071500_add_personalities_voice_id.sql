ALTER TABLE public.personalities
ADD COLUMN IF NOT EXISTS voice_id uuid REFERENCES public.voices(voice_id) ON DELETE SET NULL;

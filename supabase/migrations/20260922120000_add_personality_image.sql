-- Artwork for user-created characters, and a category so they are reachable.
--
-- Two gaps that together made a freshly created character invisible:
--
-- 1. personalities had no image column at all. The playground only ever drew
--    artwork for built-in characters, from /personality/<key>.jpeg shipped with
--    the frontend; anything with a creator_id fell back to an emoji picked by
--    hashing its id. There was nowhere to put an uploaded picture.
-- 2. The playground tabs are an exclusive pick of is_story / is_child_voice /
--    is_doctor, and the picker requires the active flag to be true. Character
--    creation wrote all three as false, so a new character matched no tab and
--    showed up nowhere.
--
-- Deliberately NOT touched: personalities_provider_check, per the note in
-- 20260910120000 -- rebuilding it is what broke character creation once before.


-- ── personalities.image_url ──────────────────────────────────────────────────
-- Public URL of the uploaded picture, null for characters that have none (they
-- keep the built-in artwork or the emoji fallback). Kept as a full URL rather
-- than a storage path so the frontend renders it without a signing round trip
-- and so an externally hosted image stays possible.

ALTER TABLE "public"."personalities"
    ADD COLUMN IF NOT EXISTS "image_url" text;


-- ── backfill: give uncategorised user characters a tab ───────────────────────
-- Every character created before this migration has all three flags false and
-- is therefore unreachable in the picker. Story is the default the creation
-- form now offers, so use it here too. Built-in characters (creator_id null)
-- are left alone: their flags were set deliberately.

UPDATE "public"."personalities"
SET "is_story" = true
WHERE "creator_id" IS NOT NULL
  AND "is_story" = false
  AND "is_child_voice" = false
  AND "is_doctor" = false;


-- ── storage bucket for character artwork ─────────────────────────────────────
-- Public: the picture is drawn next to a character anyone signed in can see, so
-- a signed URL would buy nothing and cost a round trip per tile. Reads on a
-- public bucket go through /storage/v1/object/public and skip RLS entirely.

INSERT INTO storage.buckets (id, name, public)
VALUES ('character-images', 'character-images', true)
ON CONFLICT (id) DO NOTHING;

-- Writes are per-user: an object lives under <uid>/<file>, and only that user
-- may create, replace or remove it. service_role bypasses all of this.

DROP POLICY IF EXISTS "character images are readable by anyone"
    ON storage.objects;
CREATE POLICY "character images are readable by anyone"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'character-images');

DROP POLICY IF EXISTS "users upload their own character images"
    ON storage.objects;
CREATE POLICY "users upload their own character images"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'character-images'
        AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    );

DROP POLICY IF EXISTS "users replace their own character images"
    ON storage.objects;
CREATE POLICY "users replace their own character images"
    ON storage.objects FOR UPDATE TO authenticated
    USING (
        bucket_id = 'character-images'
        AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    );

DROP POLICY IF EXISTS "users delete their own character images"
    ON storage.objects;
CREATE POLICY "users delete their own character images"
    ON storage.objects FOR DELETE TO authenticated
    USING (
        bucket_id = 'character-images'
        AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    );

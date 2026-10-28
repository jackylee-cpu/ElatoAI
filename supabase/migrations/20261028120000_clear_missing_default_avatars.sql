-- Email sign-ups were given avatar_url '/user_avatar/user_avatar_<0-9>.png',
-- picked at random by createUser() in frontend-nextjs/db/users.ts. Those
-- files never existed in this repo, so the URL returned the app's 404 HTML
-- page and every non-OAuth account showed a broken image on the Me and
-- Personal Info pages (admin@elatoai.com was seeded with '' and so showed the
-- placeholder icon). createUser() now stores '' unless the OAuth provider
-- gave an avatar; this clears the dead paths already stored. Re-runnable.

UPDATE public.users
SET avatar_url = ''
WHERE avatar_url ~ '^/user_avatar/user_avatar_[0-9]+\.png$';

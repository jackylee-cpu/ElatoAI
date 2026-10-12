#!/usr/bin/env bash
# Multi-device + sign-up release -- run ON THE SERVER.
#
# Ships three commits on top of ea960a0 (production runs bac24e9, and nothing
# between the two touches the web app, the voice server or the schema):
#   "Let one account own any number of devices."
#   "Split sign-up from login, and send a new account to onboarding."
#   "Let a super admin create login accounts from the console."
#   "Give new accounts Cantonese speech recognition by default."
# The voice server is unchanged and is NOT redeployed. CI will still build a
# fastapi image for this sha (the migrations folder changed); leave it unused.
#
# NOT in this release: per-device memory and the unbind dialog (P1-12). Every
# device on an account shares the account's memory, character and child
# profile, and Unbind still acts at once -- both as in production today.
#
# Before running, on the dev Mac:
#   1. the release commit is pushed:   git push mygithub release-multi-device:main
#      and the GHCR frontend workflow is green (images are tagged with the short sha)
# On the server:
#   2. docker login ghcr.io  (PAT with read:packages), if not already
#
#   RELEASE=<short sha> bash release-2026-10-12-multi-device.sh
#   STEP=3 RELEASE=... bash ...            # resume from a step
#   STEP=5 LAST=5 RELEASE=... bash ...     # only the checks
#
# Order matters: new web app first, then the migrations. The old web app reads
# the user through users_device_id_fkey, so its /home fails for every parent
# once 20261009130000 drops users.device_id. The new one works on either schema.
#
# Rollback:
#   - before step 4: FRONTEND_IMAGE=<id printed by step 0> docker compose -f
#     docker-compose.ghcr.yml up -d in frontend-nextjs. Nothing else changed.
#   - after step 4: prefer rolling forward. The old web app needs the column
#     back first -- re-add it from the CSV step 2 wrote:
#       ALTER TABLE public.users ADD COLUMN device_id uuid UNIQUE
#         REFERENCES public.devices (device_id) ON UPDATE CASCADE ON DELETE SET NULL;
#       -- then load user_id,device_id from the CSV and UPDATE users from it
#     A pointer is only valid while that device is still on that account; a
#     second device claimed since then has no slot to go back into.
set -euo pipefail

RELEASE="${RELEASE:?set RELEASE to the short sha pushed to mygithub/main}"
REPO="${REPO:-$HOME/aibuddy}"
DB="${DB:-supabase-db}"
AUTH="${AUTH:-supabase-auth}"
FRONTEND_DIR="$REPO/frontend-nextjs"
SITE="${SITE:-https://elatoai.hkqft.com}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
STEP="${STEP:-0}"
LAST="${LAST:-5}"
STAMP="$(date +%Y%m%d-%H%M%S)"
MIGRATION=20261009130000_one_account_many_devices.sql
# Only a column default; safe in any order, and re-runnable.
LANGUAGE_DEFAULT=20261012120000_users_language_default_zh_hk.sql

step() { [ "$1" -ge "$STEP" ] && [ "$1" -le "$LAST" ]; }
say()  { printf '\n=== %s\n' "$*"; }
q()    { docker exec -i "$DB" psql -X -At -U postgres -d postgres -c "$1"; }
apply() {
    echo "  applying $1"
    docker exec -i "$DB" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres \
        < "$REPO/supabase/migrations/$1"
}
has_column() { [ "$(q "select count(*) from information_schema.columns where table_schema='public' and table_name='$1' and column_name='$2'")" = "1" ]; }
web_is_new() {   # /signup is new in this release; the old web app answers 404
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$SITE/signup")" = "200" ]
}

if step 0; then
    say "0. Preflight"
    for f in "$FRONTEND_DIR/docker-compose.ghcr.yml" "$FRONTEND_DIR/.env.production"; do
        [ -f "$f" ] || { echo "missing $f -- set REPO=..."; exit 1; }
    done
    docker ps --format '{{.Names}}' | grep -qx "$DB" || { echo "no container $DB -- set DB=..."; exit 1; }
    # compose must Recreate the running container, not Create a second
    # project next to it: no container here means the wrong directory.
    [ -n "$(cd "$FRONTEND_DIR" && docker compose -f docker-compose.ghcr.yml ps -q)" ] \
        || { echo "no running container for the compose project in $FRONTEND_DIR"; exit 1; }
    grep -q '^SUPABASE_SERVICE_ROLE_KEY=.\+' "$FRONTEND_DIR/.env.production" \
        || { echo "web app env has no SUPABASE_SERVICE_ROLE_KEY; claiming and the Accounts tab need it"; exit 1; }
    # Sign-up behaves differently with and without email confirmation; say
    # which one this is so the manual check below expects the right thing.
    if docker ps --format '{{.Names}}' | grep -qx "$AUTH"; then
        echo "  email confirmation: GOTRUE_MAILER_AUTOCONFIRM=$(docker exec "$AUTH" printenv GOTRUE_MAILER_AUTOCONFIRM || echo unset) (false = sign-up sends a confirmation email)"
        docker exec "$AUTH" printenv GOTRUE_SMTP_HOST >/dev/null 2>&1 \
            && echo "  SMTP host is set" || echo "  no GOTRUE_SMTP_HOST -- confirmation emails cannot go out"
    else
        echo "  no container $AUTH -- set AUTH=... to see the email-confirmation setting"
    fi
    echo "  accounts on en-US (new ones get zh-HK after step 4; these keep en-US): $(q "select count(*) from public.users where language_code = 'en-US'")"
    echo "  users still pointing at a device (copied to CSV in step 2): $(has_column users device_id && q "select count(*) from public.users where device_id is not null" || echo "column already gone")"
    echo "  running frontend image (for rollback):"
    (cd "$FRONTEND_DIR" && docker compose -f docker-compose.ghcr.yml images --format '{{.Repository}}:{{.Tag}} {{.ID}}' 2>/dev/null \
        || docker compose -f docker-compose.ghcr.yml images)
    echo "  ok"
fi

if step 1; then
    say "1. Source (for the migration file)"
    git -C "$REPO" pull --ff-only origin main
    git -C "$REPO" merge-base --is-ancestor "$RELEASE" HEAD \
        || { echo "checkout does not contain $RELEASE"; exit 1; }
    for m in "$MIGRATION" "$LANGUAGE_DEFAULT"; do
        [ -f "$REPO/supabase/migrations/$m" ] || { echo "  missing $m -- wrong release?"; exit 1; }
    done
    git -C "$REPO" log --oneline -1
fi

if step 2; then
    say "2. Backup"
    mkdir -p "$BACKUP_DIR"
    out="$BACKUP_DIR/aibuddy-public-$STAMP.dump"
    docker exec "$DB" pg_dump -U postgres -d postgres -n public -Fc > "$out"
    [ -s "$out" ] || { echo "  dump is empty"; exit 1; }
    echo "  $out ($(du -h "$out" | cut -f1))"
    if has_column users device_id; then
        csv="$BACKUP_DIR/users-device-id-$STAMP.csv"
        q "copy (select user_id, device_id from public.users where device_id is not null) to stdout with csv header" > "$csv"
        echo "  $csv ($(($(wc -l < "$csv") - 1)) rows)"
    fi
fi

if step 3; then
    say "3. Frontend $RELEASE (waits for CI)"
    tries=0
    until out="$(docker pull -q "ghcr.io/jackylee-cpu/aibuddy/frontend:$RELEASE" 2>&1)"; do
        if echo "$out" | grep -qiE "unauthorized|denied|authentication"; then
            echo "  GHCR refused the pull: docker login ghcr.io with a read:packages PAT first"; exit 1
        fi
        tries=$((tries + 1)); [ "$tries" -le 40 ] || { echo "  frontend:$RELEASE not on GHCR after 20 min -- check Actions"; exit 1; }
        echo "  waiting for frontend:$RELEASE ..."; sleep 30
    done
    (cd "$FRONTEND_DIR" && export FRONTEND_IMAGE="ghcr.io/jackylee-cpu/aibuddy/frontend:$RELEASE" \
        && docker compose -f docker-compose.ghcr.yml pull && docker compose -f docker-compose.ghcr.yml up -d)
    tries=0
    until web_is_new; do
        tries=$((tries + 1)); [ "$tries" -le 30 ] || { echo "  new web app not answering after 5 min"; exit 1; }
        sleep 10
    done
    echo "  new web app is live"
fi

if step 4; then
    say "4. Drop users.device_id; new accounts default to zh-HK"
    web_is_new || { echo "  the old web app is still serving -- not dropping the column"; exit 1; }
    apply "$MIGRATION"
    apply "$LANGUAGE_DEFAULT"
fi

if step 5; then
    say "5. Checks"
    fails=0
    ok()  { echo "  ok   $*"; }
    bad() { echo "  FAIL $*"; fails=$((fails + 1)); }

    has_column users device_id && bad "users.device_id still there" || ok "users.device_id dropped"
    [ "$(q "select to_regclass('public.devices_user_id_idx') is not null")" = "t" ] \
        && ok "devices_user_id_idx exists" || bad "devices_user_id_idx missing"
    [ "$(q "select column_default from information_schema.columns where table_schema='public' and table_name='users' and column_name='language_code'")" = "'zh-HK'::text" ] \
        && ok "users.language_code defaults to zh-HK" || bad "users.language_code default is not zh-HK"
    echo "  accounts with more than one device: $(q "select count(*) from (select user_id from public.devices where user_id is not null group by 1 having count(*) > 1) s")"

    for p in /signup /login; do
        code="$(curl -s -o /dev/null -w '%{http_code}' "$SITE$p")"
        [ "$code" = "200" ] && ok "$p -> 200" || bad "$p -> $code"
    done
    for p in /home /admin; do
        loc="$(curl -s -o /dev/null -w '%{redirect_url}' "$SITE$p")"
        case "$loc" in */login) ok "signed out $p -> /login" ;; *) bad "signed out $p -> '$loc'" ;; esac
    done

    echo "  frontend errors in the last 5 min:"
    (cd "$FRONTEND_DIR" && docker compose -f docker-compose.ghcr.yml logs --since 5m 2>&1 | grep -iE "error" | tail -5 || true)

    if [ "$fails" -gt 0 ]; then
        say "$fails check(s) failed. Release $RELEASE is deployed but not verified."
        exit 1
    fi
    say "Release $RELEASE is live and the automatic checks pass. By hand, in a browser:"
    cat <<EOF
  - an existing parent signs in -> /home loads with their character; Settings
    lists their board
  - wrong password on /login -> "Wrong email or password.", no email sent
  - /signup with a new address:
      confirmation on  -> "Check your email"; the link, opened in the same
                          browser, lands on /onboard
      confirmation off -> straight to /onboard
  - the new account's Settings -> My Info shows Cantonese; talking to a board
    or the playground in Cantonese is understood (it was transcribed as English)
  - accounts made before this release keep en-US. To move them all:
      docker exec -i $DB psql -U postgres -d postgres -c "update public.users set language_code = 'zh-HK' where language_code = 'en-US'"
  - /signup with an existing address -> "already exists", no second account
  - super admin -> /admin -> Accounts lists logins; create one, sign in as it
    in a private window -> /onboard
  - claim a second board on one account: both show in Settings, each with its
    own volume; Unbind one, the other stays and keeps talking
EOF
fi

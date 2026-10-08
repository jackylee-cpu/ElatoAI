#!/usr/bin/env bash
# Security batch release -- run ON THE SERVER.
#
# Ships every phase-1 fix in one go: RLS lock-down (P0-02..05), device secrets
# and 24h device tokens (P0-06/08), signed browser voice tokens (P0-09),
# /browser off (P0-10), admin roles (P0-12), character read/write rules
# (P0-15), the doctor identity gone (P0-16), the Cantonese cast (R-02).
# Since 2026-10-08 also: OpenRouter provider pinning (P2-10), firmware OTA with
# rollback (P0-13) and the C3 playback freeze (P2-11) -- release p0-13-ota.
# Supersedes release-2026-10-07-da98048.sh, which was never run: production is
# still on the schema from before 20260911170000.
#
# Before running, on the dev Mac:
#   1. the release commit is pushed:   git push mygithub <branch>:main
#      and both GHCR workflows are green (they tag images with the short sha)
# On the server:
#   2. docker login ghcr.io  (PAT with read:packages), if not already
#   3. the account that becomes the first super admin has signed up on the site
#
#   RELEASE=<short sha> ADMIN_EMAIL=<email> bash release-2026-10-07-security-batch.sh
#   STEP=6 RELEASE=... ADMIN_EMAIL=... bash ...      # resume from a step
#   STEP=8 LAST=8 RELEASE=... ADMIN_EMAIL=... bash ...   # only the checks
#
# Order matters:
#   backup -> additive migrations -> new images -> restricting migrations.
# The old web app cannot create users, claim devices or save onboarding once
# 20261007130000 / 20261007160000 are in, so those wait for the new web app.
#
# After it: old firmware cannot get a device token -- re-flash every board.
#
# Rollback: step 0 prints the running image ids; FRONTEND_IMAGE= / FASTAPI_IMAGE=
# with those and `docker compose up -d` brings the code back. The schema does
# not roll back by itself -- restore from the step 2 dump (pg_restore --clean
# -n public) only if the new schema itself is the problem, since it also
# rewinds every row written since.
set -euo pipefail

RELEASE="${RELEASE:?set RELEASE to the short sha pushed to mygithub/main}"
ADMIN_EMAIL="${ADMIN_EMAIL:?set ADMIN_EMAIL to the account that becomes the first super admin}"
REPO="${REPO:-$HOME/aibuddy}"
DB="${DB:-supabase-db}"
FASTAPI_DIR="$REPO/server/fastapi"
FRONTEND_DIR="$REPO/frontend-nextjs"
SITE="${SITE:-https://elatoai.hkqft.com}"
# Supabase is served under a path prefix here, not at the host root.
SUPA="${SUPA:-$SITE/supabase-api}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
STEP="${STEP:-0}"
LAST="${LAST:-8}"
STAMP="$(date +%Y%m%d-%H%M%S)"

# Applied after the new web app is live, in this order. All re-runnable.
RESTRICTING=(
    20261007130000_lock_down_users_devices_conversations.sql
    20261007140000_personalities_server_writes_only.sql
    20261007160000_retire_doctor_identity.sql
    20261007170000_cantonese_cast.sql
    20261007180000_admin_roles.sql
    20261007190000_personalities_read_published.sql
    20261007191000_admin_role_without_totp.sql
    # Not additive after all: its policy calls has_role(), which 180000 creates.
    # As step 4 it failed on production with "function public.has_role(unknown)
    # does not exist" (2026-10-08). The new web app copes without it meanwhile:
    # the token answer just carries no `ota`.
    20261008100000_firmware_releases.sql
)

step() { [ "$1" -ge "$STEP" ] && [ "$1" -le "$LAST" ]; }
say()  { printf '\n=== %s\n' "$*"; }
q()    { docker exec -i "$DB" psql -X -At -U postgres -d postgres -c "$1"; }
apply() {
    echo "  applying $1"
    docker exec -i "$DB" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres \
        < "$REPO/supabase/migrations/$1"
}
has_table()  { [ "$(q "select to_regclass('public.$1') is not null")" = "t" ]; }
has_column() { [ "$(q "select count(*) from information_schema.columns where table_schema='public' and table_name='$1' and column_name='$2'")" = "1" ]; }
web_is_new() {   # the new route answers POST; the old one only had GET
    [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$SITE/api/generate_auth_token" \
        -H 'Content-Type: application/json' -d '{}')" = "400" ]
}
admin_account() {
    docker exec -i "$DB" psql -X -At -U postgres -d postgres -v email="$ADMIN_EMAIL" \
        <<< "select id from auth.users where lower(email) = lower(:'email');"
}

if step 0; then
    say "0. Preflight"
    for f in "$FASTAPI_DIR/docker-compose.ghcr.yml" "$FASTAPI_DIR/.env" \
             "$FRONTEND_DIR/docker-compose.ghcr.yml" "$FRONTEND_DIR/.env.production"; do
        [ -f "$f" ] || { echo "missing $f -- set REPO=..."; exit 1; }
    done
    docker ps --format '{{.Names}}' | grep -qx "$DB" || { echo "no container $DB -- set DB=..."; exit 1; }
    docker network inspect aibuddy-internal >/dev/null 2>&1 \
        || { echo "network aibuddy-internal missing -- wrong host?"; exit 1; }
    # compose must Recreate the running containers, not Create a second
    # project next to them: no container here means the wrong directory.
    for d in "$FASTAPI_DIR" "$FRONTEND_DIR"; do
        [ -n "$(cd "$d" && docker compose -f docker-compose.ghcr.yml ps -q)" ] \
            || { echo "no running container for the compose project in $d -- this is not where it was started"; exit 1; }
    done
    grep -q '^SUPABASE_SERVICE_ROLE_KEY=.\+' "$FRONTEND_DIR/.env.production" \
        || { echo "web app env has no SUPABASE_SERVICE_ROLE_KEY; claiming and device tokens need it"; exit 1; }
    if grep -qiE '^ENABLE_BROWSER_TEST=(1|true|yes)' "$FASTAPI_DIR/.env"; then
        echo "  ENABLE_BROWSER_TEST is on in $FASTAPI_DIR/.env -- remove it (P0-10)"; exit 1
    fi
    [ -n "$(admin_account)" ] \
        || { echo "no account $ADMIN_EMAIL in auth.users -- sign up on the site first"; exit 1; }
    grep -q '^ADMIN_EMAILS=' "$FRONTEND_DIR/.env.production" \
        && echo "  note: ADMIN_EMAILS in .env.production is no longer read; delete it when convenient"
    echo "  NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION in web env: $(grep -E '^NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION=' "$FRONTEND_DIR/.env.production" | cut -d= -f2- || echo unset) (True lets unclaimed boards in)"
    echo "  running images (for rollback):"
    for d in "$FASTAPI_DIR" "$FRONTEND_DIR"; do
        (cd "$d" && docker compose -f docker-compose.ghcr.yml images --format '{{.Repository}}:{{.Tag}} {{.ID}}' 2>/dev/null \
            || docker compose -f docker-compose.ghcr.yml images)
    done
    echo "  ok"
fi

if step 1; then
    say "1. Source (for the migration files)"
    git -C "$REPO" pull --ff-only origin main
    git -C "$REPO" merge-base --is-ancestor "$RELEASE" HEAD \
        || { echo "checkout does not contain $RELEASE"; exit 1; }
    for m in "${RESTRICTING[@]}" 20261007150000_add_device_secrets.sql; do
        [ -f "$REPO/supabase/migrations/$m" ] || { echo "  missing migration $m -- wrong release?"; exit 1; }
    done
    git -C "$REPO" log --oneline -1
fi

if step 2; then
    say "2. Backup the public schema"
    mkdir -p "$BACKUP_DIR"
    out="$BACKUP_DIR/aibuddy-public-$STAMP.dump"
    docker exec "$DB" pg_dump -U postgres -d postgres -n public -Fc > "$out"
    [ -s "$out" ] || { echo "  backup is empty"; exit 1; }
    echo "  $out ($(du -h "$out" | cut -f1))"
fi

if step 3; then
    say "3. DEVICE_JWT_SECRET (one value, both envs)"
    a="$(grep -E '^DEVICE_JWT_SECRET=' "$FASTAPI_DIR/.env" || true)"
    b="$(grep -E '^DEVICE_JWT_SECRET=' "$FRONTEND_DIR/.env.production" || true)"
    if [ -n "$a" ] && [ "$a" = "$b" ]; then
        echo "  already set and identical"
    elif [ -n "$a$b" ]; then
        echo "  set in only one env, or different values -- fix by hand, they must match"; exit 1
    else
        cp "$FASTAPI_DIR/.env" "$FASTAPI_DIR/.env.bak-$STAMP"
        cp "$FRONTEND_DIR/.env.production" "$FRONTEND_DIR/.env.production.bak-$STAMP"
        secret="$(openssl rand -base64 48 | tr -d '\n')"
        for f in "$FASTAPI_DIR/.env" "$FRONTEND_DIR/.env.production"; do
            printf '\n# Device and browser voice tokens: web app signs, voice server verifies. Same value in both.\nDEVICE_JWT_SECRET=%s\n' "$secret" >> "$f"
        done
        unset secret
        echo "  written to both (backups: *.bak-$STAMP)"
    fi
fi

if step 4; then
    say "4. Additive migrations (the running code is fine with these)"
    # These older ones are not all re-runnable, hence the checks.
    has_column personalities voices || apply 20260911170000_add_personality_voices.sql
    has_table regions               || apply 20260923120000_add_regions.sql
    has_table memory_facts          || apply 20260924120000_add_memory_facts.sql
    has_table ips                   || apply 20261007120000_add_ips_modes_styles.sql
    has_table device_secrets        || apply 20261007150000_add_device_secrets.sql
    for t in regions memory_facts ips modes styles device_secrets; do
        has_table "$t" || { echo "  $t still missing"; exit 1; }
    done
    has_column personalities voices && has_column conversations ip_key \
        || { echo "  columns still missing"; exit 1; }
    q "NOTIFY pgrst, 'reload schema'" >/dev/null
    echo "  schema ok"
fi

if step 5; then
    say "5. Images $RELEASE (waits for CI)"
    for img in fastapi frontend; do
        tries=0
        until out="$(docker pull -q "ghcr.io/jackylee-cpu/aibuddy/$img:$RELEASE" 2>&1)"; do
            if echo "$out" | grep -qiE "unauthorized|denied|authentication"; then
                echo "  GHCR refused the pull: docker login ghcr.io with a read:packages PAT first"; exit 1
            fi
            tries=$((tries + 1)); [ "$tries" -le 40 ] || { echo "  $img:$RELEASE not on GHCR after 20 min -- check Actions"; exit 1; }
            echo "  waiting for $img:$RELEASE ..."; sleep 30
        done
    done
    (cd "$FASTAPI_DIR" && export FASTAPI_IMAGE="ghcr.io/jackylee-cpu/aibuddy/fastapi:$RELEASE" \
        && docker compose -f docker-compose.ghcr.yml up -d)
    (cd "$FRONTEND_DIR" && export FRONTEND_IMAGE="ghcr.io/jackylee-cpu/aibuddy/frontend:$RELEASE" \
        && docker compose -f docker-compose.ghcr.yml up -d)
    tries=0
    until web_is_new; do
        tries=$((tries + 1)); [ "$tries" -le 30 ] || { echo "  new web app not answering after 5 min"; exit 1; }
        sleep 10
    done
    echo "  new web app is live"
fi

if step 6; then
    say "6. Restricting migrations"
    web_is_new || { echo "  the old web app is still serving -- not locking down"; exit 1; }
    for m in "${RESTRICTING[@]}"; do apply "$m"; done
    q "NOTIFY pgrst, 'reload schema'" >/dev/null
fi

if step 7; then
    say "7. First super admin"
    if [ "$(q "select count(*) from public.admin_roles where role = 'super_admin'")" != "0" ]; then
        echo "  a super admin already exists -- grant further roles on /admin"
    else
        uid="$(admin_account)"
        [ -n "$uid" ] || { echo "  no account $ADMIN_EMAIL"; exit 1; }
        q "insert into public.admin_roles (user_id, role) values ('$uid', 'super_admin')" >/dev/null
        echo "  $ADMIN_EMAIL is super admin"
    fi
fi

if step 8; then
    say "8. Checks"
    fails=0
    ok()  { echo "  ok    $*"; }
    bad() { echo "  FAIL  $*"; fails=$((fails + 1)); }

    # -- database --
    [ "$(q "select count(*) from information_schema.role_table_grants where table_schema='public' and table_name in ('users','devices','conversations','memory_facts','memory_segments','memories','admin_roles','app_settings','turn_metrics','device_secrets','firmware_releases') and grantee='anon'")" = "0" ] \
        && ok "anon holds no grant on private tables" || bad "anon still holds grants on private tables"
    [ "$(q "select count(*) from pg_policies where schemaname='public' and qual='true' and tablename <> all(array['ips','ip_modes','ip_styles','modes','styles','regions','languages','voices'])")" = "0" ] \
        && ok "no USING (true) policy on private tables" \
        || bad "USING (true) policies left: $(q "select string_agg(tablename||'.'||policyname, ', ') from pg_policies where schemaname='public' and qual='true' and tablename <> all(array['ips','ip_modes','ip_styles','modes','styles','regions','languages','voices'])")"
    [ "$(q "select count(*) from pg_policies where schemaname='public' and tablename in ('conversations','memory_facts','memory_segments','memories') and (qual like '%has_role%' or with_check like '%has_role%')")" = "0" ] \
        && ok "no admin policy on conversations or memory (Q7)" || bad "an admin policy reaches conversations or memory"
    q "select pg_get_functiondef('public.has_role(text)'::regprocedure)" | grep -q "aal" \
        && bad "has_role() still requires TOTP (20261007191000 not applied?)" || ok "has_role() is role-only"
    [ "$(q "select count(*) from storage.buckets where id='firmware' and not public")" = "1" ] \
        && ok "firmware bucket exists and is private" || bad "firmware bucket missing or public"
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$SITE/api/ota/firmware/00000000-0000-0000-0000-000000000000")" = "401" ] \
        && ok "firmware download refuses a request without a device token" || bad "firmware download answered without a device token"
    [ "$(q "select count(*) from public.admin_roles where role='super_admin'")" -ge 1 ] \
        && ok "super admins: $(q "select count(*) from public.admin_roles where role='super_admin'")" || bad "no super admin"
    [ "$(q "select count(*) from public.personalities where creator_id is null and not is_hidden")" = "6" ] \
        && ok "6 published built-in characters" || bad "published built-ins: $(q "select count(*) from public.personalities where creator_id is null and not is_hidden")"

    # -- the key the site actually ships (P0-17) --
    tmp="$(mktemp -d)"
    curl -s "$SITE/login" > "$tmp/login.html"
    { grep -oE '/_next/static/[^"]+\.js' "$tmp/login.html" || true; } | sort -u | while read -r js; do
        curl -s "$SITE$js" || true; echo
    done > "$tmp/bundle.js"
    cat "$tmp/login.html" >> "$tmp/bundle.js"
    if grep -q 'sb_secret_' "$tmp/bundle.js"; then
        bad "a sb_secret_ key is in the site's JavaScript -- rotate it"
    else
        ok "no sb_secret_ in the site's JavaScript"
    fi
    key=""
    for jwt in $(grep -oE 'eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' "$tmp/bundle.js" | sort -u || true); do
        p="$(echo "$jwt" | cut -d. -f2 | tr '_-' '/+')"; while [ $(( ${#p} % 4 )) -ne 0 ]; do p="$p="; done
        role="$(echo "$p" | base64 -d 2>/dev/null | grep -oE '"role" *: *"[a-z_]+"' | grep -oE '[a-z_]+"$' | tr -d '"' || true)"
        case "$role" in
            anon) key="$jwt" ;;
            service_role) bad "a service_role JWT is in the site's JavaScript -- rotate the JWT secret (P0-07)" ;;
        esac
    done
    [ -n "$key" ] || key="$(grep -oE 'sb_publishable_[A-Za-z0-9_-]+' "$tmp/bundle.js" | head -1 || true)"
    rm -rf "$tmp"

    # -- what that key can do from the internet --
    if [ -z "$key" ]; then
        bad "could not find the site's anon key to test with"
    else
        ok "testing with the site's own public key"
        for t in users devices conversations memory_facts memory_segments memories admin_roles app_settings turn_metrics device_secrets; do
            body="$(curl -s "$SUPA/rest/v1/$t?select=*&limit=1" -H "apikey: $key")"
            echo "$body" | grep -q '42501' && ok "anon $t -> permission denied" || bad "anon $t -> $(echo "$body" | head -c 120)"
        done
        body="$(curl -s "$SUPA/rest/v1/personalities?select=key&or=(is_hidden.eq.true,creator_id.not.is.null)" -H "apikey: $key")"
        [ "$body" = "[]" ] && ok "anon sees no hidden or parent-made character" || bad "anon personalities -> $(echo "$body" | head -c 120)"
        code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$SUPA/rest/v1/personalities" -H "apikey: $key" -H 'Content-Type: application/json' -d '{"key":"release_probe","title":"x"}')"
        [ "$code" = "401" ] || [ "$code" = "403" ] && ok "anon insert character -> $code" || bad "anon insert character -> $code"
    fi

    # -- routes --
    for p in /home /admin; do
        loc="$(curl -s -o /dev/null -w '%{redirect_url}' "$SITE$p")"
        case "$loc" in */login) ok "signed out $p -> /login" ;; *) bad "signed out $p -> '$loc'" ;; esac
    done
    code="$(curl -s -o /dev/null -w '%{http_code}' "$SITE/api/admin/openrouter-models")"
    [ "$code" = "401" ] && ok "signed out /api/admin -> 401" || bad "signed out /api/admin -> $code"

    echo "  fastapi errors in the last 5 min:"
    (cd "$FASTAPI_DIR" && docker compose -f docker-compose.ghcr.yml logs --since 5m 2>&1 | grep -iE "error|traceback" | tail -5 || true)
    echo "  frontend errors in the last 5 min:"
    (cd "$FRONTEND_DIR" && docker compose -f docker-compose.ghcr.yml logs --since 5m 2>&1 | grep -iE "error" | tail -5 || true)

    if [ "$fails" -gt 0 ]; then
        say "$fails check(s) failed. Release $RELEASE is deployed but not verified."
        exit 1
    fi
    say "Release $RELEASE is live and the automatic checks pass. By hand, in a browser:"
    cat <<EOF
  - $ADMIN_EMAIL signs in -> Admin in the sidebar -> /admin shows Model, Latency,
    Characters, IPs, Admins; saving the model works
  - a parent account signs in -> no Admin link; typing /admin lands on /home
  - the playground lists the six Cantonese characters; a voice chat works and
    its turns appear in Settings
  - re-flash a board, claim it, talk to it. Use env spotpear-ai-toy (cloud),
    never -localws/-localall: those boards depend on a laptop and cannot OTA
    from the cloud.
  - OTA, from the dev Mac, on ONE test board before any board leaves the
    building (every Spotpear board installs the current release):
      export SUPABASE_URL=$SUPA SUPABASE_SERVICE_ROLE_KEY=<service key>
      bump FIRMWARE_VERSION in firmware-arduino/src/OTA.h, pio run -e spotpear-ai-toy
      python3 firmware-arduino/tools/release_firmware.py publish spotpear-ai-toy --current
    reboot the board: it downloads over HTTPS, reboots, confirms ~2 min after
    the greeting, and devices.firmware_version shows the new version.
EOF
fi

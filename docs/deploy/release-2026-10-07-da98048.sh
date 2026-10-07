#!/usr/bin/env bash
# Release da98048 (security lock-down + device tokens + IPs) -- run ON THE SERVER.
#
#   bash release-2026-10-07-da98048.sh            # does everything, stops at the first problem
#   STEP=5 bash release-2026-10-07-da98048.sh     # resume from a step
#   STEP=6 LAST=6 bash release-2026-10-07-da98048.sh   # only the checks
#
# Order matters:
#   additive migrations -> new images -> lock-down migration.
# The old web app cannot create users or claim devices once 20261007130000 is
# applied, so that migration only runs after the new web app answers.
# Old firmware cannot get a token from the new web app: re-flash test boards.
set -euo pipefail

RELEASE=da98048
REPO="${REPO:-$HOME/aibuddy}"
DB="${DB:-supabase-db}"
FASTAPI_DIR="$REPO/server/fastapi"
FRONTEND_DIR="$REPO/frontend-nextjs"
SITE="${SITE:-https://elatoai.hkqft.com}"
STEP="${STEP:-0}"
LAST="${LAST:-6}"
STAMP="$(date +%Y%m%d-%H%M%S)"

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

if step 0; then
    say "0. Preflight"
    for f in "$FASTAPI_DIR/docker-compose.ghcr.yml" "$FASTAPI_DIR/.env" \
             "$FRONTEND_DIR/docker-compose.ghcr.yml" "$FRONTEND_DIR/.env.production"; do
        [ -f "$f" ] || { echo "missing $f -- set REPO=..."; exit 1; }
    done
    docker ps --format '{{.Names}}' | grep -qx "$DB" || { echo "no container $DB -- set DB=..."; exit 1; }
    grep -q '^SUPABASE_SERVICE_ROLE_KEY=.\+' "$FRONTEND_DIR/.env.production" \
        || { echo "web app env has no SUPABASE_SERVICE_ROLE_KEY; claiming needs it"; exit 1; }
    echo "  NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION in web env: $(grep -E '^NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION=' "$FRONTEND_DIR/.env.production" | cut -d= -f2- || echo unset) (True lets unclaimed boards in)"
    echo "  ok"
fi

if step 1; then
    say "1. Source (for the migration files)"
    git -C "$REPO" pull --ff-only origin main
    git -C "$REPO" merge-base --is-ancestor "$RELEASE" HEAD \
        || { echo "checkout does not contain $RELEASE"; exit 1; }
    git -C "$REPO" log --oneline -1
fi

if step 2; then
    say "2. DEVICE_JWT_SECRET (one value, both envs)"
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
            printf '\n# Device tokens: web app signs, voice server verifies. Same value in both.\nDEVICE_JWT_SECRET=%s\n' "$secret" >> "$f"
        done
        unset secret
        echo "  written to both (backups: *.bak-$STAMP)"
    fi
fi

if step 3; then
    say "3. Additive migrations (the running code is fine with these)"
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
    echo "  schema ok"
fi

if step 4; then
    say "4. Images $RELEASE (waits for CI)"
    for img in fastapi frontend; do
        tries=0
        until docker pull -q "ghcr.io/jackylee-cpu/aibuddy/$img:$RELEASE" >/dev/null 2>&1; do
            tries=$((tries + 1)); [ "$tries" -le 40 ] || { echo "  $img:$RELEASE not on GHCR after 20 min -- check Actions"; exit 1; }
            echo "  waiting for $img:$RELEASE ..."; sleep 30
        done
    done
    (cd "$FASTAPI_DIR" && export FASTAPI_IMAGE="ghcr.io/jackylee-cpu/aibuddy/fastapi:$RELEASE" \
        && docker compose -f docker-compose.ghcr.yml pull && docker compose -f docker-compose.ghcr.yml up -d)
    (cd "$FRONTEND_DIR" && export FRONTEND_IMAGE="ghcr.io/jackylee-cpu/aibuddy/frontend:$RELEASE" \
        && docker compose -f docker-compose.ghcr.yml pull && docker compose -f docker-compose.ghcr.yml up -d)
    tries=0
    until web_is_new; do
        tries=$((tries + 1)); [ "$tries" -le 30 ] || { echo "  new web app not answering after 5 min"; exit 1; }
        sleep 10
    done
    echo "  new web app is live"
fi

if step 5; then
    say "5. Lock down users / devices / conversations"
    web_is_new || { echo "  the old web app is still serving -- not locking down"; exit 1; }
    apply 20261007130000_lock_down_users_devices_conversations.sql
fi

if step 6; then
    say "6. Checks"
    echo "  policies:"; q "select tablename||' | '||policyname||' | '||cmd from pg_policies where schemaname='public' and tablename in ('users','devices','conversations') order by 1"
    echo "  anon grants on the three tables (want 0): $(q "select count(*) from information_schema.role_table_grants where table_schema='public' and table_name in ('users','devices','conversations') and grantee='anon'")"
    echo "  qual=true policies left (want 0): $(q "select count(*) from pg_policies where schemaname='public' and tablename in ('users','devices','conversations') and qual='true'")"
    echo "  device_secrets rows: $(q "select count(*) from device_secrets")"
    echo "  fastapi errors in the last 5 min:"
    (cd "$FASTAPI_DIR" && docker compose -f docker-compose.ghcr.yml logs --since 5m 2>&1 | grep -iE "error|traceback" | tail -5 || true)
    echo "  frontend errors in the last 5 min:"
    (cd "$FRONTEND_DIR" && docker compose -f docker-compose.ghcr.yml logs --since 5m 2>&1 | grep -iE "error" | tail -5 || true)
    say "Done. Release $RELEASE is live."
fi

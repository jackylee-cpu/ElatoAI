#!/usr/bin/env bash
# Multi-device + sign-up + per-device memory (P1-12) release -- run ON THE SERVER.
#
# Takes production from bac24e9 to this release in one go. It supersedes
# release-2026-10-12-multi-device.sh, and it is safe whether or not that one
# was run: every step checks first or is re-runnable.
#
# Ships:
#   - one account owns any number of devices; /signup split from /login; a
#     super admin can create logins; new accounts default to zh-HK
#   - P1-12: memory per device (user_id, device_id, ip_key); Unbind asks first
#     and keeps memory unless "also erase" is ticked; clearing is one
#     transaction a live session cannot write back into; an unclaimed board is
#     refused (4401) even with a live token; the web playground has no memory
#
# Before running, on the dev Mac:
#   1. the release commit is pushed:   git push mygithub p1-12-rebased:main
#      and both GHCR workflows are green (images are tagged with the short sha)
# On the server:
#   2. docker login ghcr.io  (PAT with read:packages), if not already
#
#   RELEASE=<short sha> bash release-2026-10-12-p1-12.sh
#   STEP=5 RELEASE=... bash ...            # resume from a step
#   STEP=7 LAST=7 RELEASE=... bash ...     # only the checks
#
# Order (no window where running code meets a schema it cannot use):
#   backup -> env -> P1-12 migration (additive; old code ignores it)
#   -> new voice server + web app -> drop users.device_id + zh-HK default.
# The new voice server writes device_id / memories_revision, so it must not
# start before step 4. The old web app reads users_device_id_fkey, so the
# column is only dropped after the new one answers.
#
# Existing memory moves to each account's earliest-claimed board (step 4).
# Accounts without a board keep theirs unattached; nothing reads it.
#
# Rollback: step 0 prints the running image ids. Before step 6, putting them
# back with FASTAPI_IMAGE= / FRONTEND_IMAGE= and `docker compose up -d` is
# enough -- step 4 only added columns, functions and a trigger the old code
# never touches. After step 6 the old web app also needs users.device_id back;
# re-add it from the step 2 CSV (see release-2026-10-12-multi-device.sh).
set -euo pipefail

RELEASE="${RELEASE:?set RELEASE to the short sha pushed to mygithub/main}"
REPO="${REPO:-$HOME/aibuddy}"
DB="${DB:-supabase-db}"
AUTH="${AUTH:-supabase-auth}"
FASTAPI_DIR="$REPO/server/fastapi"
FRONTEND_DIR="$REPO/frontend-nextjs"
SITE="${SITE:-https://elatoai.hkqft.com}"
# How the web app's container reaches the voice server: compose service name
# on the shared aibuddy-internal network.
VOICE_INTERNAL="${VOICE_INTERNAL:-http://fastapi:7860}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
STEP="${STEP:-0}"
LAST="${LAST:-7}"
STAMP="$(date +%Y%m%d-%H%M%S)"

ADDITIVE=20261009140000_unbind_and_clear_memory.sql
RESTRICTING=(
    20261009130000_one_account_many_devices.sql
    20261012120000_users_language_default_zh_hk.sql
)

step() { [ "$1" -ge "$STEP" ] && [ "$1" -le "$LAST" ]; }
say()  { printf '\n=== %s\n' "$*"; }
q()    { docker exec -i "$DB" psql -X -At -U postgres -d postgres -c "$1"; }
apply() {
    echo "  applying $1"
    docker exec -i "$DB" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres \
        < "$REPO/supabase/migrations/$1"
}
has_column() { [ "$(q "select count(*) from information_schema.columns where table_schema='public' and table_name='$1' and column_name='$2'")" = "1" ]; }
env_value() { grep -E "^$1=" "$2" | tail -1 | cut -d= -f2- || true; }
web_is_new() {   # /signup is new since bac24e9; the old web app answers 404
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$SITE/signup")" = "200" ]
}
frontend_container() { (cd "$FRONTEND_DIR" && docker compose -f docker-compose.ghcr.yml ps -q frontend); }

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
            || { echo "no running container for the compose project in $d"; exit 1; }
    done
    grep -q '^SUPABASE_SERVICE_ROLE_KEY=.\+' "$FRONTEND_DIR/.env.production" \
        || { echo "web app env has no SUPABASE_SERVICE_ROLE_KEY; claiming, unbinding and Accounts need it"; exit 1; }
    if grep -qiE '^ALLOW_UNCLAIMED_DEVICES=(1|true|yes)' "$FASTAPI_DIR/.env"; then
        echo "  ALLOW_UNCLAIMED_DEVICES is on in $FASTAPI_DIR/.env -- local development only, remove it"; exit 1
    fi
    if grep -qiE '^NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION=(1|true|yes)' "$FRONTEND_DIR/.env.production"; then
        echo "  NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION is on in .env.production -- unclaimed boards would get tokens; remove it"; exit 1
    fi
    if docker ps --format '{{.Names}}' | grep -qx "$AUTH"; then
        echo "  email confirmation: GOTRUE_MAILER_AUTOCONFIRM=$(docker exec "$AUTH" printenv GOTRUE_MAILER_AUTOCONFIRM || echo unset) (false = sign-up sends a confirmation email)"
    fi
    echo "  accounts on en-US (they keep it; new ones get zh-HK): $(q "select count(*) from public.users where language_code = 'en-US'")"
    echo "  memory rows to attach to a board in step 4: facts $(q "select count(*) from public.memory_facts") / segments $(q "select count(*) from public.memory_segments") / conversations $(q "select count(*) from public.conversations")"
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
    for m in "$ADDITIVE" "${RESTRICTING[@]}"; do
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
    say "3. INTERNAL_API_TOKEN (one value, both envs) and VOICE_SERVER_INTERNAL_URL"
    # Unbind uses these to drop the board's live session at once. Without them
    # it still unbinds, and the board is refused on its next connect, but a
    # conversation in progress runs on until it ends.
    a="$(env_value INTERNAL_API_TOKEN "$FASTAPI_DIR/.env")"
    b="$(env_value INTERNAL_API_TOKEN "$FRONTEND_DIR/.env.production")"
    if [ -n "$a" ] && [ "$a" = "$b" ]; then
        echo "  INTERNAL_API_TOKEN already set and identical"
    elif [ -n "$a$b" ]; then
        echo "  INTERNAL_API_TOKEN set in only one env, or different values -- fix by hand, they must match"; exit 1
    else
        cp "$FASTAPI_DIR/.env" "$FASTAPI_DIR/.env.bak-$STAMP"
        cp "$FRONTEND_DIR/.env.production" "$FRONTEND_DIR/.env.production.bak-$STAMP"
        token="$(openssl rand -hex 32)"
        for f in "$FASTAPI_DIR/.env" "$FRONTEND_DIR/.env.production"; do
            printf '\n# Web app -> voice server /internal/*. Same value in both.\nINTERNAL_API_TOKEN=%s\n' "$token" >> "$f"
        done
        unset token
        echo "  INTERNAL_API_TOKEN written to both (backups: *.bak-$STAMP)"
    fi
    url="$(env_value VOICE_SERVER_INTERNAL_URL "$FRONTEND_DIR/.env.production")"
    if [ -n "$url" ]; then
        echo "  VOICE_SERVER_INTERNAL_URL=$url (step 7 checks it answers)"
    else
        [ -f "$FRONTEND_DIR/.env.production.bak-$STAMP" ] || cp "$FRONTEND_DIR/.env.production" "$FRONTEND_DIR/.env.production.bak-$STAMP"
        printf '\nVOICE_SERVER_INTERNAL_URL=%s\n' "$VOICE_INTERNAL" >> "$FRONTEND_DIR/.env.production"
        echo "  VOICE_SERVER_INTERNAL_URL=$VOICE_INTERNAL written"
    fi
fi

if step 4; then
    say "4. Memory per device (additive: the running code ignores it)"
    apply "$ADDITIVE"
    has_column memory_facts device_id && has_column devices memories_revision \
        || { echo "  columns still missing"; exit 1; }
    echo "  attached to a board: facts $(q "select count(*) from public.memory_facts where device_id is not null")/$(q "select count(*) from public.memory_facts"), conversations $(q "select count(*) from public.conversations where device_id is not null")/$(q "select count(*) from public.conversations")"
fi

if step 5; then
    say "5. Images $RELEASE (waits for CI)"
    has_column memory_facts device_id || { echo "  step 4 has not run -- the new voice server would fail its writes"; exit 1; }
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

if step 6; then
    say "6. Drop users.device_id; new accounts default to zh-HK"
    web_is_new || { echo "  the old web app is still serving -- not dropping the column"; exit 1; }
    for m in "${RESTRICTING[@]}"; do apply "$m"; done
fi

if step 7; then
    say "7. Checks"
    fails=0
    ok()  { echo "  ok   $*"; }
    bad() { echo "  FAIL $*"; fails=$((fails + 1)); }

    has_column users device_id && bad "users.device_id still there" || ok "users.device_id dropped"
    [ "$(q "select column_default from information_schema.columns where table_schema='public' and table_name='users' and column_name='language_code'")" = "'zh-HK'::text" ] \
        && ok "users.language_code defaults to zh-HK" || bad "users.language_code default is not zh-HK"
    for t in conversations memory_facts memory_segments; do
        has_column "$t" device_id && has_column "$t" memories_revision && ok "$t has device_id + memories_revision" || bad "$t columns missing"
        [ "$(q "select count(*) from pg_trigger where tgrelid='public.$t'::regclass and not tgisinternal and tgname like '%refuse_from_before_clear'")" = "1" ] \
            && ok "$t refuses writes from before a clear" || bad "$t has no refuse-from-before-clear trigger"
    done
    for f in "clear_device_memory(uuid,uuid)" "unbind_device(uuid,uuid,boolean)"; do
        for r in anon authenticated; do
            [ "$(q "select has_function_privilege('$r', 'public.$f', 'EXECUTE')")" = "f" ] \
                && ok "$r cannot call $f" || bad "$r can call $f"
        done
        [ "$(q "select has_function_privilege('service_role', 'public.$f', 'EXECUTE')")" = "t" ] \
            && ok "service_role can call $f" || bad "service_role cannot call $f"
    done

    # Unbind drops the board's session through this; a wrong URL or token only
    # shows when a parent unbinds a toy that is talking.
    token="$(env_value INTERNAL_API_TOKEN "$FRONTEND_DIR/.env.production")"
    url="$(env_value VOICE_SERVER_INTERNAL_URL "$FRONTEND_DIR/.env.production")"
    code="$(docker exec "$(frontend_container)" node -e "
        fetch('$url/internal/device_refresh', {method: 'POST',
            headers: {'Content-Type': 'application/json', 'X-Internal-Token': process.argv[1]},
            body: JSON.stringify({mac: '00:00:00:00:00:00'})})
        .then(r => console.log(r.status), e => console.log('unreachable: ' + e.cause?.code))" "$token" 2>&1 || true)"
    unset token
    [ "$code" = "200" ] && ok "web app -> voice server /internal answers 200" || bad "web app -> voice server /internal: $code"

    for p in /signup /login; do
        c="$(curl -s -o /dev/null -w '%{http_code}' "$SITE$p")"
        [ "$c" = "200" ] && ok "$p -> 200" || bad "$p -> $c"
    done
    for p in /home /admin; do
        loc="$(curl -s -o /dev/null -w '%{redirect_url}' "$SITE$p")"
        case "$loc" in */login) ok "signed out $p -> /login" ;; *) bad "signed out $p -> '$loc'" ;; esac
    done

    echo "  fastapi errors in the last 5 min:"
    (cd "$FASTAPI_DIR" && docker compose -f docker-compose.ghcr.yml logs --since 5m 2>&1 | grep -iE "error|traceback" | tail -5 || true)
    echo "  frontend errors in the last 5 min:"
    (cd "$FRONTEND_DIR" && docker compose -f docker-compose.ghcr.yml logs --since 5m 2>&1 | grep -iE "error" | tail -5 || true)

    if [ "$fails" -gt 0 ]; then
        say "$fails check(s) failed. Release $RELEASE is deployed but not verified."
        exit 1
    fi
    say "Release $RELEASE is live and the automatic checks pass. By hand:"
    cat <<EOF
  - an existing parent signs in -> /home shows their character; Settings lists
    their board(s), and "What your toy remembers" shows that board's memory
  - talk to a claimed board (hold BOOT): it still knows what it knew before
    (its memory moved to the account's first board)
  - Unbind -> a dialog; Cancel changes nothing. Unbind with "also erase"
    unticked -> a board that is talking goes quiet within seconds and returns
    to its pairing code; claim it again -> it remembers
  - /signup with a new address (confirmation on -> email; off -> /onboard);
    the new account's language is Cantonese
  - accounts made before this release keep en-US. To move them all:
      docker exec -i $DB psql -U postgres -d postgres -c "update public.users set language_code = 'zh-HK' where language_code = 'en-US'"
  - the web playground still talks, and adds nothing to the toy's memory
EOF
fi

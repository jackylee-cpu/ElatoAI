#!/usr/bin/env bash
# Admin audit log (P1-10), usage and cost (P2-09), admin Devices (P2-14),
# account editing, battery state (R-41) and boards locked to their toy's IP
# -- run ON THE SERVER.
#
# Takes production from 8db9d9c to this release. Probed 2026-10-14 from the
# public API: production had none of the seven migrations below. Schema
# changes, all in step 3:
#   - P1-10 audit log, P2-09 usage columns (see below)
#   - P2-14: admin_list_devices / admin_reset_device_secret /
#     admin_unbind_device; the Devices page is live, not a preview
#   - admin_delete_account: Accounts can edit, disable and delete logins
#   - R-41: devices.battery_* -- the app shows the toy's battery state
#   - an IP is one physical toy: devices.ip_key keeps a board on its toy's
#     characters, ips.default_personality_id says who the toy is, and
#     admin_set_device_ip sets it from the Devices page. Every board starts
#     unlocked, so nothing changes for a toy until someone sets its IP.
# It also ships, with no schema change:
#   - Characters and IPs get a row menu: Edit, and Delete (hide) or Show
#   - login page offers email only (Apple, Google, Facebook removed)
#   - R-37: the web app relays Wi-Fi status/scan/add/delete to a board's live
#     socket. Boards on firmware 1.0.1 do not answer yet; for them the page
#     says the toy "hasn't reported its Wi-Fi yet" until a firmware with R-37
#     reaches them by OTA. Harmless, but expect it.
#   - the parent Settings screen becomes a Me section
#   - the upstream Elato storefront (checkout route, product schema) is gone
#   - the admin console moves to a grouped sidebar; Overview, Support,
#     OTA releases and Factory are previews with example data
#   - P1-10: admin_audit_log, written by triggers on every table an admin
#     edits; append-only for everyone. New "Audit log" admin page.
#   - P2-09: turn_metrics gains device_id, stt_audio_ms, tts_chars, row_kind;
#     memory summaries are billed to the board. New "Usage & cost" page.
#   - P1-02: the voice server logs at INFO by default (it was DEBUG); what a
#     child said, the replies and memory are logged at DEBUG only, and
#     tracebacks no longer print variable values. Production must not set
#     LOG_LEVEL=DEBUG or LOG_DIAGNOSE (step 0 refuses).
#
# Before running, on the dev Mac:
#   1. the release commit is pushed:   git push mygithub dev:main
#      (a fast-forward from 8db9d9c) and both GHCR workflows are green;
#      images are tagged with the short sha
# On the server:
#   2. docker login ghcr.io  (PAT with read:packages), if not already
#
#   RELEASE=<short sha> bash release-2026-10-14-audit-usage.sh
#   STEP=4 RELEASE=... bash ...            # resume from a step
#   STEP=5 LAST=5 RELEASE=... bash ...     # only the checks
#   STEP=6 LAST=6 RELEASE=... bash ...     # after talking to a board: usage rows
#
# Order (no window where running code meets a schema it cannot use):
#   backup -> both migrations (additive; the running code ignores them)
#   -> new voice server + web app -> checks.
# The new voice server sends turn_metrics columns the old table does not have,
# and PostgREST would refuse every such row, so it must not start before step 3.
# It also reads devices.ip_key when a board connects: without the column that
# lookup fails and every board falls back to the built-in character.
# The old voice server and web app work unchanged on the new schema.
#
# Rollback: step 0 prints the running image ids. Putting them back with
# FASTAPI_IMAGE= / FRONTEND_IMAGE= and `docker compose up -d` is enough at any
# point: the migrations only add a table, columns with defaults, functions and
# triggers. The audit triggers keep recording under the old code, which is
# what we want; nothing needs dropping.
set -euo pipefail

RELEASE="${RELEASE:?set RELEASE to the short sha pushed to mygithub/main}"
REPO="${REPO:-$HOME/aibuddy}"
DB="${DB:-supabase-db}"
FASTAPI_DIR="$REPO/server/fastapi"
FRONTEND_DIR="$REPO/frontend-nextjs"
SITE="${SITE:-https://elatoai.hkqft.com}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
STEP="${STEP:-0}"
LAST="${LAST:-5}"
STAMP="$(date +%Y%m%d-%H%M%S)"
# Step 6 counts the rows written since the new voice server started.
MARK_FILE="$BACKUP_DIR/release-2026-10-14-voice-started-at"

# In this order: 140000 and 150000 write to the audit log from 120000, and
# 170500 replaces the admin_list_devices() that 140000 creates.
MIGRATIONS=(
    20261014120000_admin_audit_log.sql
    20261014130000_usage_cost.sql
    20261014140000_admin_devices.sql
    20261014150000_admin_accounts.sql
    20261014153000_device_battery.sql
    20261014170000_lock_boards_to_their_ip.sql
    20261014170500_admin_set_device_ip.sql
)
# Each admin function is refused to anon and checks the role itself.
ADMIN_FUNCTIONS=(
    "admin_list_devices()"
    "admin_reset_device_secret(uuid,text)"
    "admin_unbind_device(uuid,text)"
    "admin_set_device_ip(uuid,text,text)"
    "admin_delete_account(uuid,text)"
)
AUDITED_TABLES=(app_settings personalities ips ip_modes ip_styles admin_roles)

step() { [ "$1" -ge "$STEP" ] && [ "$1" -le "$LAST" ]; }
say()  { printf '\n=== %s\n' "$*"; }
q()    { docker exec -i "$DB" psql -X -At -U postgres -d postgres -c "$1"; }
apply() {
    echo "  applying $1"
    docker exec -i "$DB" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres \
        < "$REPO/supabase/migrations/$1"
}
has_column() { [ "$(q "select count(*) from information_schema.columns where table_schema='public' and table_name='$1' and column_name='$2'")" = "1" ]; }
has_table()  { [ "$(q "select to_regclass('public.$1') is not null")" = "t" ]; }
has_function() { [ "$(q "select to_regprocedure('public.$1') is not null")" = "t" ]; }
env_value() { grep -E "^$1=" "$2" | tail -1 | cut -d= -f2- || true; }
frontend_container() { (cd "$FRONTEND_DIR" && docker compose -f docker-compose.ghcr.yml ps -q frontend); }
fastapi_container()  { (cd "$FASTAPI_DIR" && docker compose -f docker-compose.ghcr.yml ps -q fastapi); }
# Nothing on a signed-out page tells the two web apps apart, so ask Docker:
# the container must run the release image, and answer.
runs_release() {   # runs_release <container id> <image name>
    [ -n "$1" ] && [ "$(docker inspect -f '{{.Image}}' "$1")" = \
        "$(docker image inspect -f '{{.Id}}' "ghcr.io/jackylee-cpu/aibuddy/$2:$RELEASE" 2>/dev/null)" ]
}
web_is_new() {
    runs_release "$(frontend_container)" frontend \
        && [ "$(curl -s -o /dev/null -w '%{http_code}' "$SITE/login")" = "200" ]
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
    for d in "$FASTAPI_DIR" "$FRONTEND_DIR"; do
        [ -n "$(cd "$d" && docker compose -f docker-compose.ghcr.yml ps -q)" ] \
            || { echo "no running container for the compose project in $d"; exit 1; }
    done
    grep -q '^SUPABASE_SERVICE_ROLE_KEY=.\+' "$FRONTEND_DIR/.env.production" \
        || { echo "web app env has no SUPABASE_SERVICE_ROLE_KEY; Accounts needs it"; exit 1; }
    # R-37 relays Wi-Fi through the voice server's /internal routes; P1-12
    # already set both, this only confirms nothing was lost since.
    a="$(env_value INTERNAL_API_TOKEN "$FASTAPI_DIR/.env")"
    b="$(env_value INTERNAL_API_TOKEN "$FRONTEND_DIR/.env.production")"
    [ -n "$a" ] && [ "$a" = "$b" ] \
        || { echo "INTERNAL_API_TOKEN missing or different in the two envs -- see release-2026-10-12-p1-12.sh step 3"; exit 1; }
    unset a b
    [ -n "$(env_value VOICE_SERVER_INTERNAL_URL "$FRONTEND_DIR/.env.production")" ] \
        || { echo "VOICE_SERVER_INTERNAL_URL missing from .env.production"; exit 1; }
    if grep -qiE '^ALLOW_UNCLAIMED_DEVICES=(1|true|yes)' "$FASTAPI_DIR/.env"; then
        echo "  ALLOW_UNCLAIMED_DEVICES is on in $FASTAPI_DIR/.env -- local development only, remove it"; exit 1
    fi
    # P1-02: at DEBUG the voice server logs what children said.
    if grep -qiE '^LOG_LEVEL=(DEBUG|TRACE)' "$FASTAPI_DIR/.env"; then
        echo "  LOG_LEVEL is DEBUG in $FASTAPI_DIR/.env -- it would log children's words; remove it"; exit 1
    fi
    if grep -qiE '^LOG_DIAGNOSE=(1|true|yes|on)' "$FASTAPI_DIR/.env"; then
        echo "  LOG_DIAGNOSE is on in $FASTAPI_DIR/.env -- tracebacks would print variable values; remove it"; exit 1
    fi
    echo "  turn_metrics rows so far: $(q "select count(*) from public.turn_metrics") (they keep tokens only; STT/TTS are counted from this release)"
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
    for m in "${MIGRATIONS[@]}"; do
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
fi

if step 3; then
    say "3. Migrations (additive: the running code ignores them)"
    # Each file runs in one transaction (-1) and is re-runnable, so a failure
    # rolls back cleanly and the step can simply be run again.
    for m in "${MIGRATIONS[@]}"; do apply "$m"; done
    has_table admin_audit_log && has_column turn_metrics row_kind && has_column turn_metrics device_id \
        && has_column devices battery_low && has_column devices ip_key && has_column ips default_personality_id \
        || { echo "  objects still missing"; exit 1; }
    for f in "${ADMIN_FUNCTIONS[@]}"; do
        has_function "$f" || { echo "  function $f missing"; exit 1; }
    done
    [ "$(q "select pg_get_function_result('public.admin_list_devices()'::regprocedure) like '%ip_key%'")" = "t" ] \
        || { echo "  admin_list_devices() has no ip_key -- 20261014170500 did not run last"; exit 1; }
    echo "  ok"
fi

if step 4; then
    say "4. Images $RELEASE (waits for CI)"
    has_column turn_metrics row_kind && has_column devices ip_key \
        || { echo "  step 3 has not run -- the new voice server's metrics writes and board lookups would fail"; exit 1; }
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
    mkdir -p "$BACKUP_DIR"
    q "select now()" > "$MARK_FILE"
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
    say "5. Checks"
    fails=0
    ok()  { echo "  ok   $*"; }
    bad() { echo "  FAIL $*"; fails=$((fails + 1)); }

    runs_release "$(fastapi_container)" fastapi && ok "voice server runs $RELEASE" || bad "voice server is not on $RELEASE"
    runs_release "$(frontend_container)" frontend && ok "web app runs $RELEASE" || bad "web app is not on $RELEASE"

    # -- P1-10 --
    has_table admin_audit_log && ok "admin_audit_log exists" || bad "admin_audit_log missing"
    for t in "${AUDITED_TABLES[@]}"; do
        [ "$(q "select count(*) from pg_trigger where tgrelid='public.$t'::regclass and tgname='audit_admin_change'")" = "1" ] \
            && ok "$t is audited" || bad "$t has no audit trigger"
    done
    for r in anon authenticated service_role; do
        for p in UPDATE DELETE TRUNCATE; do
            [ "$(q "select has_table_privilege('$r', 'public.admin_audit_log', '$p')")" = "f" ] \
                && ok "$r cannot $p the log" || bad "$r can $p the log"
        done
    done
    for r in anon authenticated; do
        [ "$(q "select has_table_privilege('$r', 'public.admin_audit_log', 'INSERT')")" = "f" ] \
            && ok "$r cannot INSERT into the log directly" || bad "$r can INSERT into the log"
    done
    [ "$(q "select has_function_privilege('anon', 'public.admin_audit_record(text,text,text,text,text,jsonb,jsonb)', 'EXECUTE')")" = "f" ] \
        && ok "anon cannot call admin_audit_record" || bad "anon can call admin_audit_record"
    # Even the table owner is refused; tried inside a transaction that is
    # rolled back, so nothing is left behind either way.
    out="$(docker exec -i "$DB" psql -X -q -At -U postgres -d postgres 2>&1 <<'SQL' || true
BEGIN;
INSERT INTO public.admin_audit_log (action, reason) VALUES ('release.check', 'rolled back');
DELETE FROM public.admin_audit_log WHERE action = 'release.check';
ROLLBACK;
SQL
)"
    echo "$out" | grep -q "append-only" && ok "a DELETE by the table owner is refused" || bad "DELETE was not refused: $out"
    # A real settings change writes exactly one record -- also rolled back.
    out="$(docker exec -i "$DB" psql -X -q -At -U postgres -d postgres 2>&1 <<'SQL' || true
BEGIN;
CREATE TEMP TABLE before_count AS SELECT count(*) AS n FROM public.admin_audit_log;
-- Whatever the rate is, move it a cent so the row really changes.
UPDATE public.app_settings
   SET value = jsonb_set(value, '{usd_to_hkd}',
                         to_jsonb(coalesce((value ->> 'usd_to_hkd')::numeric, 7.8) + 0.01))
 WHERE key = 'usage_rates';
SELECT (SELECT count(*) FROM public.admin_audit_log) - n FROM before_count;
ROLLBACK;
SQL
)"
    echo "$out" | grep -qx "1" && ok "a settings change writes one audit record" || bad "settings change wrote: $out"

    # -- P2-09 --
    for c in device_id stt_audio_ms tts_chars row_kind; do
        has_column turn_metrics "$c" && ok "turn_metrics.$c" || bad "turn_metrics.$c missing"
    done
    [ -n "$(q "select value from public.app_settings where key='usage_rates'")" ] \
        && ok "usage_rates: $(q "select value from public.app_settings where key='usage_rates'")" || bad "usage_rates row missing"
    for f in "admin_usage_by_device(timestamptz,timestamptz)" "admin_usage_by_day(timestamptz,timestamptz,text)"; do
        [ "$(q "select has_function_privilege('anon', 'public.$f', 'EXECUTE')")" = "f" ] \
            && ok "anon cannot call $f" || bad "anon can call $f"
    done
    # LLM prices come from OpenRouter's public catalogue, fetched by the web
    # app's server. Without it the Usage page prices LLM tokens at nothing.
    code="$(docker exec "$(frontend_container)" node -e "
        fetch('https://openrouter.ai/api/v1/models').then(r => console.log(r.status), e => console.log('unreachable: ' + e.cause?.code))" 2>&1 || true)"
    [ "$code" = "200" ] && ok "web app reaches the OpenRouter catalogue" || bad "OpenRouter catalogue from the web app: $code"

    # -- P2-14, accounts, R-41, toy IPs --
    for c in "devices battery_low" "devices battery_at" "devices ip_key" "ips default_personality_id"; do
        has_column $c && ok "${c/ /.}" || bad "${c/ /.} missing"
    done
    for f in "${ADMIN_FUNCTIONS[@]}"; do
        if ! has_function "$f"; then bad "$f missing"; continue; fi
        [ "$(q "select has_function_privilege('anon', 'public.$f', 'EXECUTE')")" = "f" ] \
            && ok "anon cannot call $f" || bad "anon can call $f"
    done
    # Called as authenticated without an admin role: refused inside the
    # function. Rolled back, so even a wrong answer changes nothing.
    out="$(docker exec -i "$DB" psql -X -q -At -U postgres -d postgres 2>&1 <<'SQL' || true
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated"}', true);
SELECT count(*) FROM public.admin_list_devices();
ROLLBACK;
SQL
)"
    echo "$out" | grep -q "only a super admin" && ok "a signed-in parent is refused admin_list_devices" || bad "admin_list_devices for a parent: $out"
    [ "$(q "select count(*) from public.devices where ip_key is not null")" = "0" ] \
        && ok "no board is locked to a toy yet (as expected on first release)" \
        || ok "$(q "select count(*) from public.devices where ip_key is not null") board(s) locked to a toy"

    # -- the rest of the release --
    token="$(env_value INTERNAL_API_TOKEN "$FRONTEND_DIR/.env.production")"
    url="$(env_value VOICE_SERVER_INTERNAL_URL "$FRONTEND_DIR/.env.production")"
    code="$(docker exec "$(frontend_container)" node -e "
        fetch('$url/internal/device_refresh', {method: 'POST',
            headers: {'Content-Type': 'application/json', 'X-Internal-Token': process.argv[1]},
            body: JSON.stringify({mac: '00:00:00:00:00:00'})})
        .then(r => console.log(r.status), e => console.log('unreachable: ' + e.cause?.code))" "$token" 2>&1 || true)"
    unset token
    [ "$code" = "200" ] && ok "web app -> voice server /internal answers 200" || bad "web app -> voice server /internal: $code"
    token="$(env_value INTERNAL_API_TOKEN "$FRONTEND_DIR/.env.production")"
    code="$(docker exec "$(frontend_container)" node -e "
        fetch('$url/internal/devices_presence', {method: 'POST',
            headers: {'X-Internal-Token': process.argv[1]}})
        .then(r => console.log(r.status), e => console.log('unreachable: ' + e.cause?.code))" "$token" 2>&1 || true)"
    unset token
    [ "$code" = "200" ] && ok "Devices page can read who is online (/internal/devices_presence)" || bad "/internal/devices_presence: $code"
    for p in /login /signup; do
        c="$(curl -s -o /dev/null -w '%{http_code}' "$SITE$p")"
        [ "$c" = "200" ] && ok "$p -> 200" || bad "$p -> $c"
    done
    for p in /home /admin; do
        loc="$(curl -s -o /dev/null -w '%{redirect_url}' "$SITE$p")"
        case "$loc" in */login) ok "signed out $p -> /login" ;; *) bad "signed out $p -> '$loc'" ;; esac
    done

    echo "  fastapi errors in the last 5 min:"
    (cd "$FASTAPI_DIR" && docker compose -f docker-compose.ghcr.yml logs --since 5m 2>&1 | grep -iE "error|traceback|Write of turn metrics failed" | tail -5 || true)
    echo "  frontend errors in the last 5 min:"
    (cd "$FRONTEND_DIR" && docker compose -f docker-compose.ghcr.yml logs --since 5m 2>&1 | grep -iE "error" | tail -5 || true)

    if [ "$fails" -gt 0 ]; then
        say "$fails check(s) failed. Release $RELEASE is deployed but not verified."
        exit 1
    fi
    say "Release $RELEASE is live and the automatic checks pass. By hand:"
    cat <<EOF
  - talk to a claimed board for two or three turns (hold BOOT), wait a minute
    for the session to end, then run:   STEP=6 LAST=6 RELEASE=$RELEASE bash $0
  - /admin as super admin: the sidebar has every page; Model, Latency,
    Characters, IPs, Accounts and Admins work as before; Latency still lists
    turns
  - Audit log: change a character's subtitle and change it back -> two
    records naming you, each with the old and new value. Saving an IP without
    changing anything adds no record
  - after that conversation, the voice server log holds no transcript, reply,
    child's name or memory fact (P1-02):
      (cd $FASTAPI_DIR && docker compose -f docker-compose.ghcr.yml logs --since 15m) | grep -E "USER.TRANSCRIPT|Learned"
    shows only chars=/lengths, never the words
  - Usage & cost: this month lists the board you talked to by its AIBuddy-XXXX
    name with STT, LLM and TTS amounts; no "could not reach OpenRouter" banner
  - Devices: every board is listed, the one you talked to shows Online with
    its Wi-Fi; its IP reads "Not locked"
  - Accounts: create a throwaway account, edit its email, disable it (it can
    no longer sign in), then delete it with a reason -> Audit log has
    account.create / account.update / account.delete records
  - Characters / IPs: the row menu hides one and Show brings it back; the
    page stays clickable after each confirmation
  - Toy lock, when you set up a real toy: make one IP per toy (e.g. rabbit),
    move its character in, pick it as the IP's default, put "you are a rabbit"
    in the IP's rules, then Devices -> Set toy IP. Pick a different character
    as the parent: the board still speaks as the toy's character
  - a parent's Me page shows the toy's battery (low / ok) after it connects
  - /admin as a content admin: only Characters and IPs
  - a parent: /login offers email only (no Apple, Google, Facebook); Me shows
    their board(s); a board on
    1.0.1 says it "hasn't reported its Wi-Fi yet" (expected until R-37 firmware)
  - the rates are starting guesses (Azure US\$1/audio hour, MiniMax US\$60/M
    chars). Check them against the first bills on the Usage page (P2-09 test)
EOF
fi

if step 6; then
    say "6. Usage rows written since the new voice server started"
    [ -s "$MARK_FILE" ] || { echo "  no start time recorded -- step 4 has not run"; exit 1; }
    since="$(cat "$MARK_FILE")"
    echo "  since $since:"
    q "select row_kind, count(*), count(device_id) as with_board,
              coalesce(sum(stt_audio_ms), 0) as stt_ms, coalesce(sum(tts_chars), 0) as tts_chars,
              coalesce(sum(prompt_tokens + completion_tokens), 0) as tokens
         from public.turn_metrics where created_at >= '$since'
        group by row_kind order by row_kind" | sed 's/^/    /'
    turns="$(q "select count(*) from public.turn_metrics where created_at >= '$since' and row_kind = 'turn' and device_id is not null")"
    stt="$(q "select count(*) from public.turn_metrics where created_at >= '$since' and row_kind = 'turn' and coalesce(stt_audio_ms, 0) > 0")"
    if [ "$turns" -gt 0 ] && [ "$stt" -gt 0 ]; then
        echo "  ok: board turns carry the board and STT audio"
    else
        echo "  FAIL: no board turn with STT audio yet -- talk to a claimed board first, or check the fastapi log for 'Write of turn metrics failed'"
        exit 1
    fi
fi

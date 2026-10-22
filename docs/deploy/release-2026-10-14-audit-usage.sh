#!/usr/bin/env bash
# Admin audit log (P1-10), usage and cost (P2-09), admin Devices (P2-14),
# account editing, battery state (R-41), boards locked to their toy's IP,
# bind tickets (P0-11) and staged OTA rollouts (P2-16) -- run ON THE SERVER.
#
# Takes production from 8db9d9c to this release. Probed 2026-10-14 from the
# public API: production had none of the migrations below. Extended 2026-10-15
# with five more (bind tickets, four for OTA rollouts) and the web app's new
# env vars. Extended 2026-10-16 with device_wifi (R-37) and the fixes since
# 63f3b06, which UAT runs; every step is re-runnable, so the same command
# takes UAT forward. Extended 2026-10-22 with the OTA failure reason.
# Schema changes, all in step 3:
#   - OTA failure reason: firmware_rollout_devices gains failed_reason and
#     failed_reset; ota_note_report takes them (two new parameters that default
#     to NULL, so the old web app's four-name call still resolves). Auto-pause
#     now leaves out lost_installs (installs lost to power, not the build) and
#     needs at least 2 rollbacks as well as more than 5%. One flat toy no
#     longer pauses a release, as AIBuddy-16C0 did to 1.1.0 on 2026-10-16
#   - R-37: device_wifi holds each board's saved Wi-Fi names (never
#     passwords), written by the voice server through record_device_wifi()
#     (service role only); parents read only their own boards' rows, and a
#     board that changes owner loses its row. The Wi-Fi page reads it, so a
#     sleeping board's list survives a voice server restart
#   - P0-11: device_bind_tickets, issue_device_bind_ticket and
#     claim_device_with_ticket (service role only). A board is claimed with a
#     one-time ticket its owner's app hands it over Bluetooth
#   - P2-16..P2-21: firmware_releases gains rollout_percent (default 100, so
#     the current release behaves as before), a whitelist and a pause;
#     firmware_rollout_devices records what each board did; the server pauses
#     a rollout on its own when too many boards roll back; super admins
#     upload, stage and delete releases from the OTA page. Changes to
#     firmware_releases are audited
#   - P1-10 audit log, P2-09 usage columns (see below)
#   - P2-14: admin_list_devices / admin_reset_device_secret /
#     admin_unbind_device; the Devices page is live, not a preview
#   - admin_delete_account: Accounts can edit, disable and delete logins
#   - R-41: devices.battery_* -- the app shows the toy's battery state;
#     battery_full (2026-10-16) is null until a board can sense it
#   - devices.connected_at / disconnected_at / disconnect_reason: the app
#     shows a toy as online, asleep, probably out of battery or offline.
#     Written by the voice server per session; 1.1.0 and older boards show
#     only online / offline, since they do not say why they go
#   - device_crashes + admin_list_device_crashes(): boards report crashes
#     (panic, watchdogs, brownout) after "auth"; the admin Devices page lists
#     the last 30 days. Super admins only; 1.1.0 and older never report
#   - an IP is one physical toy: devices.ip_key keeps a board on its toy's
#     characters, ips.default_personality_id says who the toy is, and
#     admin_set_device_ip sets it from the Devices page. Every board starts
#     unlocked, so nothing changes for a toy until someone sets its IP.
# It also ships, with no schema change:
#   - Characters and IPs get a row menu: Edit, and Delete (hide) or Show
#   - login page offers email only (Apple, Google, Facebook removed)
#   - R-37: the web app relays Wi-Fi status/scan/add/delete to a board's live
#     socket. Boards on firmware 1.0.1 neither report nor answer; the page now
#     asks for a software update for them (by version, or after 20s online
#     with no report) and refuses changes at once instead of after 20s, until
#     a firmware with R-37 reaches them by OTA. Expect it on every cloud board.
#   - the Wi-Fi page opens with the list already on it (4dafe61), and the
#     voice server answers "status" from the board's last report when it is
#     under a minute old
#   - volume: a change in the app reaches a 1.0.1 board at once (the voice
#     server resends it in an "auth" frame), not two answers later, and an
#     answer's end no longer puts back an older level (4120bb0, 67e9d7d)
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
#   - P0-11 hides the list of unclaimed boards unless DEVICE_CLAIM_LIST=True.
#     No app can hand a board a ticket yet (R-21), so this UAT keeps the list
#     on: step 3 adds DEVICE_CLAIM_LIST=True to .env.production when it is not
#     set (CLAIM_LIST=False to leave it off). Turn it off once the app binds.
#   - P2-22: the token answer carries the voice and backend URLs boards should
#     use. Step 3 adds DEVICE_VOICE_URL / DEVICE_BACKEND_URL for $SITE when
#     they are not set. Today's firmware ignores both; they matter once a
#     firmware with the P2-22 client is out.
#   - P2-24: the voice server decodes an IMA ADPCM mic uplink when a board
#     says so (X-Mic-Codec); boards that do not say so are PCM, as before.
#   - firmware for R-36, R-37 (switch Wi-Fi), P2-24 and P2-25 is not part of
#     this script: it goes out by OTA from the OTA page afterwards.
#   - P2-20: the OTA page uploads a ~1.6MB image to the web app, and nginx
#     refuses any body over its 1MB default with 413. Only the /supabase-api/
#     locations were raised (16m, 2026-10-09). Step 3c adds
#     $NGINX_CONF_DIR/00-upload-limit.conf, which sets 16m for the whole http
#     block, checks it with nginx -t and reloads; a location that sets its own
#     limit still wins, so 3c and step 5 send a real 2MB POST.
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
# point: the migrations only add tables, columns with defaults, functions and
# triggers. The audit triggers keep recording under the old code, which is
# what we want; nothing needs dropping. The old web app reads only is_current
# from firmware_releases, so it offers the current release to every board, as
# it did. Step 3 backs up .env.production before adding to it; the old image
# ignores the added variables. Step 3c's limit is harmless to the old code;
# to undo it, delete 00-upload-limit.conf and `docker exec nginx nginx -s reload`.
set -euo pipefail

RELEASE="${RELEASE:?set RELEASE to the short sha pushed to mygithub/main}"
CLAIM_LIST="${CLAIM_LIST:-True}"   # DEVICE_CLAIM_LIST to add when unset
REPO="${REPO:-$HOME/aibuddy}"
DB="${DB:-supabase-db}"
FASTAPI_DIR="$REPO/server/fastapi"
FRONTEND_DIR="$REPO/frontend-nextjs"
SITE="${SITE:-https://elatoai.hkqft.com}"
NGINX="${NGINX:-nginx}"                          # the host nginx container
NGINX_CONF_DIR="${NGINX_CONF_DIR:-$HOME/nginx/conf.d}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
STEP="${STEP:-0}"
LAST="${LAST:-5}"
STAMP="$(date +%Y%m%d-%H%M%S)"
# Step 6 counts the rows written since the new voice server started.
MARK_FILE="$BACKUP_DIR/release-2026-10-14-voice-started-at"

# In this order: 140000 and 150000 write to the audit log from 120000,
# 170500 replaces the admin_list_devices() that 140000 creates, and 190000
# replaces 120000's audit_admin_change() and audits firmware_releases.
# 20261012170000 and 20261016120000 stand alone (devices and users only).
# 20261022120000 replaces 200000's ota_maybe_pause() and ota_note_report().
MIGRATIONS=(
    20261012170000_device_bind_tickets.sql
    20261014120000_admin_audit_log.sql
    20261014130000_usage_cost.sql
    20261014140000_admin_devices.sql
    20261014150000_admin_accounts.sql
    20261014153000_device_battery.sql
    20261014170000_lock_boards_to_their_ip.sql
    20261014170500_admin_set_device_ip.sql
    20261014190000_firmware_rollout.sql
    20261014200000_firmware_rollout_autopause.sql
    20261014210000_admin_firmware_upload.sql
    20261014220000_admin_firmware_rollout.sql
    20261016120000_device_wifi.sql
    20261016150000_device_battery_full.sql
    20261016160000_device_connection.sql
    20261016170000_device_crashes.sql
    20261022120000_ota_failure_reason.sql
)
# Each admin function is refused to anon and checks the role itself.
ADMIN_FUNCTIONS=(
    "admin_list_devices()"
    "admin_reset_device_secret(uuid,text)"
    "admin_unbind_device(uuid,text)"
    "admin_set_device_ip(uuid,text,text)"
    "admin_delete_account(uuid,text)"
    "admin_create_firmware_release(text,text,text,text,integer,text)"
    "admin_delete_firmware_release(uuid)"
    "admin_change_firmware_rollout(uuid,text,smallint,text[],text)"
    "admin_list_device_crashes(integer)"
)
# Only the servers (service role) may call these: the web app's token and
# bind-ticket routes, and the voice server recording a board's Wi-Fi.
SERVICE_FUNCTIONS=(
    "issue_device_bind_ticket(uuid,text,integer,integer)"
    "claim_device_with_ticket(uuid,text)"
    "ota_note_offer(uuid,uuid)"
    "ota_note_report(uuid,text,text,text,text,text)"
    "ota_maybe_pause(uuid)"
    "record_device_wifi(text,text,smallint,jsonb,smallint)"
)
AUDITED_TABLES=(app_settings personalities ips ip_modes ip_styles admin_roles firmware_releases)

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
# A 2MB POST to the OTA page's upload route, signed out: the web app refuses
# it (401/403), but only nginx answers 413, so anything else means the body
# got through.
upload_status() {
    head -c 2097152 /dev/zero | curl -s -o /dev/null -w '%{http_code}' -X POST \
        -H 'Content-Type: application/octet-stream' --data-binary @- "$SITE/api/admin/firmware" || true
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
    docker ps --format '{{.Names}}' | grep -qx "$NGINX" || { echo "no container $NGINX -- set NGINX=..."; exit 1; }
    [ -d "$NGINX_CONF_DIR" ] || { echo "no $NGINX_CONF_DIR -- set NGINX_CONF_DIR=..."; exit 1; }
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
    for v in DEVICE_CLAIM_LIST DEVICE_VOICE_URL DEVICE_BACKEND_URL; do
        echo "  $v: $(env_value "$v" "$FRONTEND_DIR/.env.production" | grep . || echo "unset (step 3 adds it)")"
    done
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
        && has_column devices battery_low && has_column devices battery_full \
        && has_column devices disconnect_reason \
        && has_table device_crashes \
        && has_column devices ip_key && has_column ips default_personality_id \
        || { echo "  objects still missing"; exit 1; }
    for f in "${ADMIN_FUNCTIONS[@]}"; do
        has_function "$f" || { echo "  function $f missing"; exit 1; }
    done
    [ "$(q "select pg_get_function_result('public.admin_list_devices()'::regprocedure) like '%ip_key%'")" = "t" ] \
        || { echo "  admin_list_devices() has no ip_key -- 20261014170500 did not run after 140000"; exit 1; }
    has_table device_bind_tickets && has_table firmware_rollout_devices \
        && has_column firmware_releases rollout_percent && has_column firmware_releases stage_changed_at \
        || { echo "  bind-ticket or rollout objects missing"; exit 1; }
    has_table device_wifi \
        && [ "$(q "select count(*) from pg_trigger where tgrelid='public.devices'::regclass and tgname='devices_forget_wifi_on_owner_change'")" = "1" ] \
        || { echo "  device_wifi or its owner-change trigger missing"; exit 1; }
    for f in "${SERVICE_FUNCTIONS[@]}"; do
        has_function "$f" || { echo "  function $f missing"; exit 1; }
    done
    echo "  ok"

    say "3b. Web app env (.env.production; read when step 4 recreates the container)"
    envf="$FRONTEND_DIR/.env.production"
    add_env() {   # add_env <name> <value> <comment>: only when the name is unset
        if grep -qE "^$1=" "$envf"; then
            echo "  $1 already set: $(env_value "$1" "$envf")"
            return
        fi
        [ -f "$envf.bak-$STAMP" ] || cp "$envf" "$envf.bak-$STAMP"
        printf '\n# %s\n%s=%s\n' "$3" "$1" "$2" >> "$envf"
        echo "  added $1=$2"
    }
    host="${SITE#https://}"; host="${host%%/*}"
    add_env DEVICE_CLAIM_LIST "$CLAIM_LIST" \
        "P0-11: True lists unowned boards in Me to claim without a ticket. UAT only, until the app binds over Bluetooth (R-21)."
    add_env DEVICE_VOICE_URL "wss://$host/fastapi/ws/esp32" \
        "P2-22: sent to boards with their token. Today's firmware ignores it."
    add_env DEVICE_BACKEND_URL "https://$host" \
        "P2-22: sent to boards with their token. Today's firmware ignores it."
    [ ! -f "$envf.bak-$STAMP" ] || echo "  backup: $envf.bak-$STAMP"
    unset envf host

    say "3c. nginx upload limit (P2-20: firmware images are ~1.6MB)"
    conf="$NGINX_CONF_DIR/00-upload-limit.conf"
    want="# P2-20, release 2026-10-14: the admin OTA page uploads firmware images
# (~1.6MB) to the web app. nginx's default is 1m. http-level, so a location
# that sets its own client_max_body_size keeps it.
client_max_body_size 16m;"
    if [ -f "$conf" ] && [ "$(cat "$conf")" = "$want" ]; then
        echo "  $conf already in place"
    else
        printf '%s\n' "$want" > "$conf" || { echo "  cannot write $conf"; exit 1; }
        # A file nginx reads outside the http block must not stay behind.
        if ! out="$(docker exec "$NGINX" nginx -t 2>&1)"; then
            rm -f "$conf"; echo "  nginx -t failed with $conf; removed it:"
            echo "$out"; exit 1
        fi
        docker exec "$NGINX" nginx -s reload
        sleep 2
        echo "  added $conf and reloaded nginx"
    fi
    c="$(upload_status)"
    [ "$c" != "413" ] && [ "$c" != "000" ] \
        || { echo "  2MB POST to $SITE/api/admin/firmware still -> $c: either nginx does not read $NGINX_CONF_DIR"
             echo "  (set NGINX_CONF_DIR=...) or a server/location block sets a lower client_max_body_size"; exit 1; }
    echo "  2MB POST to /api/admin/firmware -> $c (not 413)"
    unset conf want c out
fi

if step 4; then
    say "4. Images $RELEASE (waits for CI)"
    has_column turn_metrics row_kind && has_column devices ip_key && has_column devices battery_full \
        && has_column devices disconnect_reason \
        && has_table device_crashes \
        && has_table firmware_rollout_devices && has_table device_bind_tickets && has_table device_wifi \
        || { echo "  step 3 has not run -- the new voice server's metrics writes and board lookups would fail"; exit 1; }
    grep -qE '^DEVICE_CLAIM_LIST=' "$FRONTEND_DIR/.env.production" \
        || { echo "  DEVICE_CLAIM_LIST is not in .env.production -- run step 3 (3b) first"; exit 1; }
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
    for c in "devices battery_low" "devices battery_at" "devices battery_full" "devices connected_at" \
             "devices disconnected_at" "devices disconnect_reason" "devices ip_key" "ips default_personality_id"; do
        has_column $c && ok "${c/ /.}" || bad "${c/ /.} missing"
    done
    # Only the voice server writes the battery and connection state; a
    # parent only reads it.
    for c in battery_low battery_charging battery_full connected_at disconnected_at disconnect_reason; do
        [ "$(q "select has_column_privilege('authenticated', 'public.devices', '$c', 'UPDATE')")" = "f" ] \
            && ok "a parent cannot set devices.$c" || bad "a parent can set devices.$c"
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

    # -- P0-11 bind tickets, P2-16 OTA rollouts --
    for r in anon authenticated; do
        [ "$(q "select has_table_privilege('$r', 'public.device_bind_tickets', 'SELECT')")" = "f" ] \
            && ok "$r cannot read device_bind_tickets" || bad "$r can read device_bind_tickets"
    done
    for f in "${SERVICE_FUNCTIONS[@]}"; do
        if ! has_function "$f"; then bad "$f missing"; continue; fi
        for r in anon authenticated; do
            [ "$(q "select has_function_privilege('$r', 'public.$f', 'EXECUTE')")" = "f" ] \
                && ok "$r cannot call $f" || bad "$r can call $f"
        done
    done
    [ "$(q "select has_table_privilege('anon', 'public.firmware_rollout_devices', 'SELECT')")" = "f" ] \
        && ok "anon cannot read firmware_rollout_devices" || bad "anon can read firmware_rollout_devices"

    # -- crash reports --
    [ "$(q "select relrowsecurity from pg_class where oid = 'public.device_crashes'::regclass")" = "t" ] \
        && ok "device_crashes has row-level security" || bad "device_crashes has no row-level security"
    for r in anon authenticated; do
        [ "$(q "select has_table_privilege('$r', 'public.device_crashes', 'SELECT')")" = "f" ] \
            && ok "$r cannot read device_crashes" || bad "$r can read device_crashes"
    done
    echo "  device_crashes rows: $(q "select count(*) from public.device_crashes") (0 until a board with the report crashes)"

    # -- R-37 device_wifi --
    [ "$(q "select relrowsecurity from pg_class where oid = 'public.device_wifi'::regclass")" = "t" ] \
        && ok "device_wifi has row-level security" || bad "device_wifi has no row-level security"
    [ "$(q "select has_table_privilege('anon', 'public.device_wifi', 'SELECT')")" = "f" ] \
        && ok "anon cannot read device_wifi" || bad "anon can read device_wifi"
    for p in INSERT UPDATE DELETE; do
        [ "$(q "select has_table_privilege('authenticated', 'public.device_wifi', '$p')")" = "f" ] \
            && ok "a parent cannot $p device_wifi" || bad "a parent can $p device_wifi"
    done
    # A parent sees only their own boards' rows: none for an account that
    # owns nothing, whatever the table holds.
    out="$(docker exec -i "$DB" psql -X -q -At -U postgres -d postgres 2>&1 <<'SQL' || true
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated"}', true);
SELECT count(*) FROM public.device_wifi;
ROLLBACK;
SQL
)"
    echo "$out" | grep -qx "0" && ok "a parent with no boards reads no device_wifi rows" || bad "device_wifi for a parent with no boards: $out"
    # A MAC no board has records nothing and says so (rolled back anyway).
    out="$(docker exec -i "$DB" psql -X -q -At -U postgres -d postgres 2>&1 <<'SQL' || true
BEGIN;
SELECT public.record_device_wifi('00:00:00:00:00:00', 'release-check', NULL, '[]'::jsonb, 8::smallint);
ROLLBACK;
SQL
)"
    echo "$out" | grep -qx "f" && ok "record_device_wifi ignores an unknown MAC" || bad "record_device_wifi for an unknown MAC: $out"
    echo "  device_wifi rows: $(q "select count(*) from public.device_wifi") (0 until an R-37 board connects; 1.0.1 boards never write one)"
    # The current release must still reach every board, as before this release.
    cur="$(q "select string_agg(board || ' ' || version || ' ' || rollout_percent || '%' || case when paused_at is null then '' else ' PAUSED' end, ', ') from public.firmware_releases where is_current")"
    if [ -z "$cur" ]; then
        ok "no current firmware release"
    elif echo "$cur" | grep -qvE "PAUSED| (0|10|50)%"; then
        ok "current release(s) still offered to every board: $cur"
    else
        bad "a current release is paused or staged: $cur"
    fi
    [ "$(q "select count(*) from storage.buckets where id = 'firmware' and not public")" = "1" ] \
        && ok "private firmware bucket exists (OTA page uploads go there)" || bad "no private 'firmware' storage bucket"
    c="$(upload_status)"
    [ "$c" != "413" ] && [ "$c" != "000" ] && ok "2MB POST to /api/admin/firmware -> $c (nginx lets firmware uploads through)" \
        || bad "2MB POST to /api/admin/firmware -> $c (step 3c)"
    c="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$SITE/api/device_bind_ticket" || true)"
    [ "$c" = "401" ] && ok "signed out POST /api/device_bind_ticket -> 401" || bad "signed out POST /api/device_bind_ticket -> $c"
    for v in DEVICE_CLAIM_LIST DEVICE_VOICE_URL DEVICE_BACKEND_URL; do
        val="$(docker exec "$(frontend_container)" printenv "$v" 2>/dev/null || true)"
        [ -n "$val" ] && ok "web app sees $v=$val" || bad "web app container has no $v"
    done
    for v in DEVICE_VOICE_URL:wss DEVICE_BACKEND_URL:https; do
        val="$(docker exec "$(frontend_container)" printenv "${v%%:*}" 2>/dev/null || true)"
        case "$val" in "${v##*:}://"*.*) ;; *) bad "${v%%:*} must be ${v##*:}:// on a public name: '$val'" ;; esac
    done
    unset cur c val

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
        c="$(curl -s -o /dev/null -w '%{http_code}' "$SITE$p" || true)"
        [ "$c" = "200" ] && ok "$p -> 200" || bad "$p -> $c"
    done
    for p in /home /admin; do
        loc="$(curl -s -o /dev/null -w '%{redirect_url}' "$SITE$p" || true)"
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
  - volume: on a 1.0.1 board, change the volume in the app while it is
    answering -> the same answer gets louder or quieter, not the one after
  - Accounts: create a throwaway account, edit its email, disable it (it can
    no longer sign in), then delete it with a reason -> Audit log has
    account.create / account.update / account.delete records
  - Characters / IPs: the row menu hides one and Show brings it back; the
    page stays clickable after each confirmation
  - Toy lock, when you set up a real toy: make one IP per toy (e.g. rabbit),
    move its character in, pick it as the IP's default, put "you are a rabbit"
    in the IP's rules, then Devices -> Set toy IP. Pick a different character
    as the parent: the board still speaks as the toy's character
  - a parent's Me page shows the toy's battery (low / ok) after it connects;
    a Spotpear board never shows Charging or Full (it cannot sense them)
  - Device Settings shows Online under the toy's name while it talks; a
    1.0.1 board shows Offline once it is switched off (it never says Asleep)
  - Devices (super admin): a board's panel says "Crashes, 30 d: None
    reported" until one crashes
  - Me -> Add a device (DEVICE_CLAIM_LIST=True): an unclaimed board online
    in the last ten minutes is listed and Add claims it (P0-11)
  - OTA releases page (super admin): the current release shows 100%, not
    paused, with its boards. Upload a release build as a draft and delete it
    again -> the upload is not refused by the proxy (images are ~1.6 MB), and
    the Audit log has the create and delete. Push R-36/R-37/P2-24/P2-25
    firmware later from this page: whitelist one board first
  - /admin as a content admin: only Characters and IPs
  - a parent: /login offers email only (no Apple, Google, Facebook); Me shows
    their board(s); the Wi-Fi page of a board on 1.0.1 asks to update its
    software and its buttons are off (expected until R-37 firmware). Once an
    R-37 board has connected, its Wi-Fi page lists its networks even while
    it sleeps
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

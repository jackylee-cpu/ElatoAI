#!/usr/bin/env bash
# Rotate the Supabase JWT secret and the device token secret (P0-07) -- run ON THE SERVER.
#
# Why: before P0-06 the web app handed any board that sent a MAC a user JWT
# with no expiry, signed with the Supabase JWT secret. PostgREST still accepts
# every one of them. The only way to kill them is a new secret, and with it a
# new anon key and service_role key, which that secret signs.
# DEVICE_JWT_SECRET (24-hour device tokens, 5-minute web voice tokens) is
# rotated in the same window: boards recover on their own (refused once ->
# new token with their device secret), so nobody has to pair anything again.
#
# What breaks for a moment, and comes back by itself:
#   - the web app, from step 4 until step 5 finishes (a minute or two): its
#     anon key is baked into the image at build time, so it needs a rebuild
#   - signed-in users whose access token no longer verifies are sent to /login
#   - boards drop their voice session when the voice server restarts in step 5
#     and reconnect with a new device token
#
# Steps:
#   0  survey: read-only. Where the keys live, whether they match, who else
#      holds them. Prints fingerprints only, never a secret.
#   1  prepare: new secret + keys into $ROT_DIR (mode 600). Prints the new
#      anon key -- it is public, it ships in every page -- for the GitHub
#      secret. Production is untouched.
#      THEN, by hand, on github.com/jackylee-cpu/aibuddy:
#        Settings > Secrets and variables > Actions > NEXT_PUBLIC_SUPABASE_ANON_KEY = <new anon key>
#        Actions > "Publish frontend image to GHCR" > Run workflow (main)
#      and wait for it to go green; its image tag is main's short sha.
#   2  check the new web app image carries the new anon key, not the old one
#   3  backup the env files; make a canary: a user JWT signed with the OLD
#      secret, the shape the old MAC endpoint handed out, and prove it works now
#   4  rotate Supabase: .env, app.settings.jwt_secret, recreate the stack
#   5  web app + voice server: new keys in their envs, new web app image
#   6  checks: old anon key, old canary and old device tokens refused; new
#      keys work; boards come back; no running container holds an old value
#   R  rollback (STEP=R): puts back every env file, the DB setting and the
#      previous web app image. The GitHub secret must be put back by hand.
#
#   STEP=0 LAST=0 bash rotate-2026-10-jwt-secrets.sh        # survey only
#   STEP=1 LAST=1 bash rotate-2026-10-jwt-secrets.sh        # prepare
#   STEP=2 RELEASE=<short sha> bash rotate-2026-10-jwt-secrets.sh   # 2..6
#   STEP=6 RELEASE=<short sha> bash rotate-2026-10-jwt-secrets.sh   # checks again
#   STEP=R bash rotate-2026-10-jwt-secrets.sh               # rollback
#
# Afterwards, on the dev Mac: firmware-arduino/tools/release_firmware.py reads
# SUPABASE_SERVICE_ROLE_KEY from the shell -- use the new one (cat
# $ROT_DIR/new.env on the server). Anything step 0 listed under "also holds"
# needs the new value too.
set -euo pipefail

REPO="${REPO:-$HOME/aibuddy}"
DB="${DB:-supabase-db}"
FASTAPI_DIR="$REPO/server/fastapi"
FRONTEND_DIR="$REPO/frontend-nextjs"
SITE="${SITE:-https://elatoai.hkqft.com}"
SUPA_URL="${SUPA_URL:-$SITE/supabase-api}"
FRONTEND_REPO="${FRONTEND_REPO:-ghcr.io/jackylee-cpu/aibuddy/frontend}"
ROT_DIR="${ROT_DIR:-$HOME/aibuddy-rotation}"
ROTATE_DEVICE="${ROTATE_DEVICE:-1}"
STEP="${STEP:-0}"
LAST="${LAST:-6}"
STAMP="$(date +%Y%m%d-%H%M%S)"
# The official self-hosted template's secret. A deployment still on it can be
# forged by anyone who has read the Supabase docs.
TEMPLATE_SECRET="your-super-secret-jwt-token-with-at-least-32-characters-long"
# A made-up, locally administered MAC for the generate_auth_token check; its
# row is deleted again.
PROBE_MAC="02:A1:B0:07:00:01"

say()  { printf '\n=== %s\n' "$*"; }
die()  { echo "  STOP: $*"; exit 1; }
ok()   { echo "  ok   $*"; }
bad()  { echo "  FAIL $*"; FAILED=1; }
q()    { docker exec -i "$DB" psql -X -At -U postgres -d postgres -c "$1"; }

# --- helpers (pure; tested on the dev Mac) ----------------------------------
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
b64url_decode() {
    local s="$1"
    s="${s//-/+}"; s="${s//_//}"
    case $(( ${#s} % 4 )) in 2) s="$s==" ;; 3) s="$s=" ;; esac
    printf '%s' "$s" | openssl base64 -d -A
}
hs256() {   # secret payload-json -> compact JWT
    local h p s
    h=$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)
    p=$(printf '%s' "$2" | b64url)
    s=$(printf '%s' "$h.$p" | openssl dgst -sha256 -hmac "$1" -binary | b64url)
    printf '%s.%s.%s' "$h" "$p" "$s"
}
signed_by() {   # token secret -> true when the signature is that secret's
    local hp="${1%.*}" sig="${1##*.}"
    [ -n "$2" ] && [ "$(printf '%s' "$hp" | openssl dgst -sha256 -hmac "$2" -binary | b64url)" = "$sig" ]
}
claim() {   # token name -> the claim's value, unquoted
    b64url_decode "$(printf '%s' "$1" | cut -d. -f2)" \
        | grep -o "\"$2\":[^,}]*" | head -1 | cut -d: -f2- | tr -d '" '
}
fp() { [ -n "$1" ] && printf '%s' "$1" | openssl dgst -sha256 | awk '{print substr($NF,1,10)}' || echo "-"; }
env_value() {   # KEY file -> value, outer quotes stripped
    grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2- \
        | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" || true
}
set_env() {   # KEY value file -> replace the line or append it
    local tmp; tmp=$(mktemp "$3.XXXXXX")
    awk -v k="$1" -v v="$2" 'BEGIN{d=0} index($0, k"=")==1 {print k"="v; d=1; next} {print} END{if(!d) print k"="v}' "$3" > "$tmp"
    cat "$tmp" > "$3"; rm -f "$tmp"   # keep the file's inode, owner and mode
}
replace_literal() {   # old new file -> every occurrence, no regex
    local tmp; tmp=$(mktemp "$3.XXXXXX")
    awk -v o="$1" -v n="$2" '{s=$0; out=""; while ((i=index(s,o))>0) {out=out substr(s,1,i-1) n; s=substr(s,i+length(o))} print out s}' "$3" > "$tmp"
    cat "$tmp" > "$3"; rm -f "$tmp"
}
new_secret() { openssl rand -hex 32; }
api_key() {   # secret role -> a key shaped like the self-hosted template's, 5 years
    local now; now=$(date +%s)
    hs256 "$1" "{\"role\":\"$2\",\"iss\":\"supabase\",\"iat\":$now,\"exp\":$((now + 5*365*24*3600))}"
}
# --- end helpers -------------------------------------------------------------

step() { [ "$STEP" = "R" ] && return 1; [ "$1" -ge "$STEP" ] && [ "$1" -le "$LAST" ]; }
http() {   # method url apikey bearer -> status code
    curl -s -o /dev/null -w '%{http_code}' -X "$1" "$2" -H "apikey: $3" -H "Authorization: Bearer $4"
}
container_env() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null; }
# Which running containers carry this value anywhere in their environment.
holders() {
    local v="$1" c
    for c in $(docker ps --format '{{.Names}}'); do
        container_env "$c" | grep -F -- "$v" | cut -d= -f1 | sed "s/^/$c:/" || true
    done
}
supa_dir() { docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$DB"; }
supa_files() {   # the -f arguments the stack was started with
    docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$DB" \
        | tr ',' '\n' | sed 's/^/-f /' | tr '\n' ' '
}
running_image() { docker inspect -f '{{.Config.Image}}' "$1"; }
compose_container() { (cd "$1" && docker compose -f docker-compose.ghcr.yml ps -q "$2"); }
load_state() {
    [ -f "$ROT_DIR/new.env" ] && [ -f "$ROT_DIR/old.env" ] || die "no prepared rotation in $ROT_DIR -- run step 1"
    NEW_SECRET=$(env_value JWT_SECRET "$ROT_DIR/new.env")
    NEW_ANON=$(env_value ANON_KEY "$ROT_DIR/new.env")
    NEW_SERVICE=$(env_value SERVICE_ROLE_KEY "$ROT_DIR/new.env")
    NEW_DEVICE=$(env_value DEVICE_JWT_SECRET "$ROT_DIR/new.env")
    OLD_SECRET=$(env_value JWT_SECRET "$ROT_DIR/old.env")
    OLD_ANON=$(env_value ANON_KEY "$ROT_DIR/old.env")
    OLD_SERVICE=$(env_value SERVICE_ROLE_KEY "$ROT_DIR/old.env")
    OLD_DEVICE=$(env_value DEVICE_JWT_SECRET "$ROT_DIR/old.env")
}

FAILED=0
SUPA_DIR="$(supa_dir 2>/dev/null || true)"
SUPA_ENV="$SUPA_DIR/.env"

if step 0; then
    say "0. Survey (read-only)"
    [ -n "$SUPA_DIR" ] && [ -f "$SUPA_ENV" ] || die "cannot find the Supabase stack's .env (container $DB, dir '$SUPA_DIR') -- set DB=..."
    for f in "$FASTAPI_DIR/.env" "$FRONTEND_DIR/.env.production" \
             "$FASTAPI_DIR/docker-compose.ghcr.yml" "$FRONTEND_DIR/docker-compose.ghcr.yml"; do
        [ -f "$f" ] || die "missing $f -- set REPO=..."
    done
    echo "  Supabase stack: $SUPA_DIR  ($(supa_files))"
    secret=$(env_value JWT_SECRET "$SUPA_ENV")
    anon=$(env_value ANON_KEY "$SUPA_ENV")
    service=$(env_value SERVICE_ROLE_KEY "$SUPA_ENV")
    device=$(env_value DEVICE_JWT_SECRET "$FRONTEND_DIR/.env.production")
    echo "  JWT_SECRET        fp $(fp "$secret")  length ${#secret}"
    [ "$secret" = "$TEMPLATE_SECRET" ] && echo "  !!  JWT_SECRET is the self-hosted TEMPLATE default -- anyone can mint a service_role key"
    for name in anon service; do
        key=${!name}
        signed_by "$key" "$secret" && sig="signed by JWT_SECRET" || sig="NOT signed by JWT_SECRET"
        signed_by "$key" "$TEMPLATE_SECRET" && sig="$sig, TEMPLATE key"
        echo "  ${name} key        fp $(fp "$key")  role=$(claim "$key" role) exp=$(claim "$key" exp)  ($sig)"
    done
    for c in supabase-auth supabase-rest; do
        live=$(container_env "$c" | grep -E '^(GOTRUE_JWT_SECRET|PGRST_JWT_SECRET)=' | cut -d= -f2- || true)
        [ -n "$live" ] && echo "  $c runs with secret fp $(fp "$live") ($( [ "$live" = "$secret" ] && echo matches .env || echo 'DIFFERS from .env'))"
    done
    dbs=$(q "select coalesce(current_setting('app.settings.jwt_secret', true), '')")
    echo "  DB app.settings.jwt_secret: $( [ -z "$dbs" ] && echo unset || { [ "$dbs" = "$secret" ] && echo 'set, matches' || echo 'set, DIFFERS'; })"
    for k in JWT_KEYS JWT_JWKS SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY; do
        grep -q "^$k=." "$SUPA_ENV" && echo "  !!  $k is set: this stack uses the new asymmetric/API keys -- this script does not handle that; stop and ask"
    done
    fe_service=$(env_value SUPABASE_SERVICE_ROLE_KEY "$FRONTEND_DIR/.env.production")
    fa_service=$(env_value SUPABASE_SERVICE_ROLE_KEY "$FASTAPI_DIR/.env")
    fa_device=$(env_value DEVICE_JWT_SECRET "$FASTAPI_DIR/.env")
    echo "  web app service key:    $( [ "$fe_service" = "$service" ] && echo 'matches Supabase' || echo 'DIFFERS from Supabase')"
    echo "  voice server service key: $( [ "$fa_service" = "$service" ] && echo 'matches Supabase' || echo 'DIFFERS from Supabase')"
    echo "  DEVICE_JWT_SECRET fp $(fp "$device"), voice server $( [ "$fa_device" = "$device" ] && echo matches || echo DIFFERS)"
    # The anon key the live site ships, from its JS.
    shipped=$(curl -s "$SITE/login" | grep -o '/_next/static/chunks/[^"]*\.js' | sort -u | while read -r p; do
        curl -s "$SITE$p" | grep -oE 'eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' ; done | sort -u | head -3)
    for k in $shipped; do
        echo "  site ships a JWT: role=$(claim "$k" role) fp $(fp "$k") $( [ "$k" = "$anon" ] && echo '(= ANON_KEY)' || echo '(not ANON_KEY)')"
    done
    echo "  running containers that hold these values (container:VAR):"
    for v in "$secret" "$anon" "$service" "$device"; do holders "$v"; done | sort -u | sed 's/^/    /'
    echo "  files under \$HOME that also hold the service key or the secret (outside the three env files):"
    grep -rlF --exclude-dir={.git,node_modules,backups,aibuddy-rotation} -e "$service" -e "$secret" "$HOME" 2>/dev/null \
        | grep -vxF -e "$SUPA_ENV" -e "$FRONTEND_DIR/.env.production" -e "$FASTAPI_DIR/.env" | head -20 | sed 's/^/    /' || true
    echo "  accounts: $(q "select count(*) from auth.users")   refresh tokens not revoked: $(q "select count(*) from auth.refresh_tokens where not revoked")"
    echo "  boards seen in the last 30 min: $(q "select count(*) from public.devices where last_seen_at > now() - interval '30 minutes'")"
    echo "  running images: web $(running_image "$(compose_container "$FRONTEND_DIR" frontend)")  voice $(running_image "$(compose_container "$FASTAPI_DIR" fastapi)")"
fi

if step 1; then
    say "1. Prepare new secrets (production untouched)"
    [ -f "$SUPA_ENV" ] || die "no Supabase .env"
    if [ -f "$ROT_DIR/new.env" ] && [ "${FORCE_NEW:-0}" != 1 ]; then
        die "$ROT_DIR/new.env exists already -- its anon key may be in GitHub by now. Delete it or FORCE_NEW=1 only if it was never used"
    fi
    for k in JWT_KEYS JWT_JWKS SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY; do
        grep -q "^$k=." "$SUPA_ENV" && die "$k is set; this stack needs a different procedure"
    done
    secret=$(env_value JWT_SECRET "$SUPA_ENV")
    anon=$(env_value ANON_KEY "$SUPA_ENV")
    service=$(env_value SERVICE_ROLE_KEY "$SUPA_ENV")
    device=$(env_value DEVICE_JWT_SECRET "$FRONTEND_DIR/.env.production")
    signed_by "$anon" "$secret" && signed_by "$service" "$secret" \
        || die "ANON_KEY / SERVICE_ROLE_KEY are not signed by JWT_SECRET -- the .env is not what runs; stop"
    [ "$(env_value SUPABASE_SERVICE_ROLE_KEY "$FRONTEND_DIR/.env.production")" = "$service" ] || die "web app service key differs from Supabase's"
    [ "$(env_value SUPABASE_SERVICE_ROLE_KEY "$FASTAPI_DIR/.env")" = "$service" ] || die "voice server service key differs from Supabase's"
    [ "$(env_value DEVICE_JWT_SECRET "$FASTAPI_DIR/.env")" = "$device" ] || die "DEVICE_JWT_SECRET differs between web app and voice server"

    umask 077
    mkdir -p "$ROT_DIR/backups"
    new=$(new_secret)
    new_device=$device
    [ "$ROTATE_DEVICE" = 1 ] && new_device=$(new_secret)
    printf 'JWT_SECRET=%s\nANON_KEY=%s\nSERVICE_ROLE_KEY=%s\nDEVICE_JWT_SECRET=%s\n' \
        "$new" "$(api_key "$new" anon)" "$(api_key "$new" service_role)" "$new_device" > "$ROT_DIR/new.env"
    printf 'JWT_SECRET=%s\nANON_KEY=%s\nSERVICE_ROLE_KEY=%s\nDEVICE_JWT_SECRET=%s\n' \
        "$secret" "$anon" "$service" "$device" > "$ROT_DIR/old.env"
    # For the rollback: the web app image running now, under a tag no pull overwrites.
    fc=$(compose_container "$FRONTEND_DIR" frontend)
    docker tag "$(docker inspect -f '{{.Image}}' "$fc")" "aibuddy-frontend:pre-rotation"
    printf 'FRONTEND_PREV=%s\n' "aibuddy-frontend:pre-rotation" > "$ROT_DIR/images.env"
    load_state
    echo "  new secret fp $(fp "$NEW_SECRET"), service key fp $(fp "$NEW_SERVICE"), device secret fp $(fp "$NEW_DEVICE")"
    echo "  previous web app image kept as aibuddy-frontend:pre-rotation"
    echo
    echo "  New anon key (public -- it ships in every page). Put it in the GitHub secret"
    echo "  NEXT_PUBLIC_SUPABASE_ANON_KEY, then run \"Publish frontend image to GHCR\" on main:"
    echo
    echo "$NEW_ANON"
    echo
    echo "  Do steps 2-6 soon after that build: from then on, :latest carries the new key,"
    echo "  and pulling it before step 4 would break the site."
fi

if step 2; then
    say "2. The new web app image"
    load_state
    RELEASE="${RELEASE:?set RELEASE to the short sha of the frontend build}"
    img="$FRONTEND_REPO:$RELEASE"
    docker pull -q "$img" >/dev/null
    has() { docker run --rm --entrypoint sh "$img" -c "grep -rqF '$1' /app/.next" ; }
    has "$NEW_ANON" && ok "$img carries the new anon key" || die "$img does not carry the new anon key -- GitHub secret not saved before the build?"
    has "$OLD_ANON" && die "$img still carries the old anon key"
    ok "and not the old one"
fi

if step 3; then
    say "3. Backup + canary"
    load_state
    b="$ROT_DIR/backups/$STAMP"; mkdir -p "$b"; chmod 700 "$b"
    cp -p "$SUPA_ENV" "$b/supabase.env"
    cp -p "$FRONTEND_DIR/.env.production" "$b/frontend.env.production"
    cp -p "$FASTAPI_DIR/.env" "$b/fastapi.env"
    q "select coalesce(current_setting('app.settings.jwt_secret', true), '')" > "$b/db-jwt-secret"
    chmod 600 "$b"/*
    ln -sfn "$b" "$ROT_DIR/backups/latest"
    ok "env files and DB setting copied to $b"
    # A user JWT made the way the old MAC endpoint made them: the old secret,
    # no expiry. It must work now and stop working after step 4.
    uid=$(q "select id from auth.users order by created_at limit 1")
    canary=$(hs256 "$OLD_SECRET" "{\"sub\":\"$uid\",\"role\":\"authenticated\",\"aud\":\"authenticated\",\"iat\":$(date +%s)}")
    printf '%s' "$canary" > "$ROT_DIR/canary.jwt"; chmod 600 "$ROT_DIR/canary.jwt"
    code=$(http GET "$SUPA_URL/rest/v1/users?select=user_id" "$OLD_ANON" "$canary")
    [ "$code" = 200 ] && ok "old-secret user JWT with no expiry is accepted today ($code) -- what this rotation ends" \
        || die "canary got $code before rotating; SUPA_URL=$SUPA_URL wrong?"
fi

if step 4; then
    say "4. Rotate Supabase (web app down until step 5 is done)"
    load_state
    [ -L "$ROT_DIR/backups/latest" ] || die "no backup -- run step 3"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$ROT_DIR/rotated_at"
    set_env JWT_SECRET "$NEW_SECRET" "$SUPA_ENV"
    set_env ANON_KEY "$NEW_ANON" "$SUPA_ENV"
    set_env SERVICE_ROLE_KEY "$NEW_SERVICE" "$SUPA_ENV"
    # Only written when the stack was first created, so it still holds the old one.
    if [ -n "$(cat "$ROT_DIR/backups/latest/db-jwt-secret")" ]; then
        q "alter database postgres set \"app.settings.jwt_secret\" to '$NEW_SECRET'" >/dev/null
        ok "app.settings.jwt_secret updated"
    fi
    # shellcheck disable=SC2046
    (cd "$SUPA_DIR" && docker compose $(supa_files) up -d)
    for i in $(seq 1 60); do
        r=$(http GET "$SUPA_URL/rest/v1/personalities?select=key&limit=1" "$NEW_ANON" "$NEW_ANON")
        a=$(http GET "$SUPA_URL/auth/v1/health" "$NEW_ANON" "$NEW_ANON")
        [ "$r" = 200 ] && [ "$a" = 200 ] && break
        sleep 3
    done
    [ "$r" = 200 ] && [ "$a" = 200 ] && ok "Supabase answers the new anon key (rest $r, auth $a)" \
        || die "Supabase not answering the new key after 3 min (rest $r, auth $a) -- STEP=R to roll back"
fi

if step 5; then
    say "5. Web app + voice server"
    load_state
    RELEASE="${RELEASE:?set RELEASE to the short sha of the frontend build}"
    for f in "$FRONTEND_DIR/.env.production" "$FASTAPI_DIR/.env"; do
        replace_literal "$OLD_SERVICE" "$NEW_SERVICE" "$f"
        replace_literal "$OLD_ANON" "$NEW_ANON" "$f"
        replace_literal "$OLD_SECRET" "$NEW_SECRET" "$f"
        [ "$OLD_DEVICE" != "$NEW_DEVICE" ] && replace_literal "$OLD_DEVICE" "$NEW_DEVICE" "$f"
        grep -qF -e "$OLD_SERVICE" -e "$OLD_ANON" -e "$OLD_SECRET" "$f" && die "$f still holds an old value"
    done
    ok "env files updated"
    voice=$(running_image "$(compose_container "$FASTAPI_DIR" fastapi)")
    (cd "$FRONTEND_DIR" && FRONTEND_IMAGE="$FRONTEND_REPO:$RELEASE" docker compose -f docker-compose.ghcr.yml up -d --force-recreate)
    (cd "$FASTAPI_DIR" && FASTAPI_IMAGE="$voice" docker compose -f docker-compose.ghcr.yml up -d --force-recreate)
    ok "web app on $RELEASE, voice server recreated on $voice"
fi

if step 6; then
    say "6. Checks"
    load_state
    sleep 15
    since=$(cat "$ROT_DIR/rotated_at" 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
    c=$(http GET "$SUPA_URL/rest/v1/personalities?select=key&limit=1" "$OLD_ANON" "$OLD_ANON")
    [ "$c" = 401 ] && ok "① old anon key refused ($c)" || bad "① old anon key got $c, want 401"
    if [ -f "$ROT_DIR/canary.jwt" ]; then
        c=$(http GET "$SUPA_URL/rest/v1/users?select=user_id" "$NEW_ANON" "$(cat "$ROT_DIR/canary.jwt")")
        [ "$c" = 401 ] && ok "① old-secret user JWT (no expiry) refused ($c)" || bad "① old-secret user JWT got $c, want 401"
    fi
    c=$(http GET "$SUPA_URL/rest/v1/users?select=user_id&limit=1" "$OLD_SERVICE" "$OLD_SERVICE")
    [ "$c" = 401 ] && ok "① old service_role key refused ($c)" || bad "① old service_role key got $c, want 401"
    c=$(http GET "$SUPA_URL/rest/v1/personalities?select=key&limit=1" "$NEW_ANON" "$NEW_ANON")
    [ "$c" = 200 ] && ok "new anon key works ($c)" || bad "new anon key got $c"
    c=$(http GET "$SUPA_URL/rest/v1/devices?select=device_id&limit=1" "$NEW_SERVICE" "$NEW_SERVICE")
    [ "$c" = 200 ] && ok "new service_role key works ($c)" || bad "new service_role key got $c"
    # The live site ships the new key and not the old.
    js=$(curl -s "$SITE/login" | grep -o '/_next/static/chunks/[^"]*\.js' | sort -u | while read -r p; do curl -s "$SITE$p"; done)
    printf '%s' "$js" | grep -qF "$NEW_ANON" && ok "site ships the new anon key" || bad "site does not ship the new anon key"
    printf '%s' "$js" | grep -qF "$OLD_ANON" && bad "site still ships the old anon key" || ok "site no longer ships the old one"
    # The web app's service key: a board calling in for the first time gets 202.
    c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$SITE/api/generate_auth_token" \
        -H 'Content-Type: application/json' -d "{\"macAddress\":\"$PROBE_MAC\"}")
    [ "$c" = 202 ] && ok "② generate_auth_token works (new board -> $c)" || bad "② generate_auth_token got $c, want 202"
    q "delete from public.devices where mac_address = '$PROBE_MAC'" >/dev/null
    # The voice server takes a device token signed with the new secret and
    # refuses one signed with the old.
    if [ "$OLD_DEVICE" != "$NEW_DEVICE" ]; then
        fc=$(compose_container "$FASTAPI_DIR" fastapi)
        exp=$(( $(date +%s) + 3600 ))
        payload="{\"typ\":\"device\",\"mac\":\"$PROBE_MAC\",\"sub\":\"00000000-0000-0000-0000-000000000000\",\"aud\":\"aibuddy-device\",\"exp\":$exp}"
        verdict() {
            docker exec -e T="$1" "$fc" python -c "
import os, device_auth
try:
    device_auth.verify(os.environ['T']); print('accepted')
except device_auth.InvalidToken:
    print('refused')" 2>/dev/null || echo "error"
        }
        o=$(verdict "$(hs256 "$OLD_DEVICE" "$payload")")
        n=$(verdict "$(hs256 "$NEW_DEVICE" "$payload")")
        [ "$o" = refused ] && [ "$n" = accepted ] && ok "① voice server refuses an old device token, takes a new one" \
            || bad "① device token check: old $o (want refused), new $n (want accepted)"
    fi
    echo "  boards (the voice server restarted; each comes back with a new device token):"
    for i in $(seq 1 12); do
        after=$(q "select count(*) from public.devices where user_id is not null and last_seen_at > timestamptz '$since'")
        [ "$after" -gt 0 ] && break
        sleep 10
    done
    missing=$(q "select count(*) from public.devices where user_id is not null and last_seen_at between timestamptz '$since' - interval '30 minutes' and timestamptz '$since'")
    echo "    claimed boards back since the rotation: $after   seen in the 30 min before it and not since: $missing"
    [ "$after" -gt 0 ] && ok "② at least one board got a new token" || echo "  ??   no board has called in since -- talk to one and rerun STEP=6"
    echo "  running containers still holding an old value:"
    left=$(for v in "$OLD_SECRET" "$OLD_ANON" "$OLD_SERVICE"; do holders "$v"; done
           [ "$OLD_DEVICE" != "$NEW_DEVICE" ] && holders "$OLD_DEVICE"; true)
    [ -z "$left" ] && ok "none" || { echo "$left" | sed 's/^/    /'; bad "containers above still hold an old value"; }
    echo
    echo "  By hand: ③ log in at $SITE (you may be asked to log in again), talk in the playground,"
    echo "           and talk to a board."
    [ "$FAILED" = 0 ] && echo "  all automatic checks passed" || { echo "  SOME CHECKS FAILED -- STEP=R rolls back"; exit 1; }
fi

if [ "$STEP" = "R" ]; then
    say "R. Rollback"
    b="$ROT_DIR/backups/latest"
    [ -d "$b" ] || die "no backup in $ROT_DIR/backups/latest"
    cat "$b/supabase.env" > "$SUPA_ENV"
    cat "$b/frontend.env.production" > "$FRONTEND_DIR/.env.production"
    cat "$b/fastapi.env" > "$FASTAPI_DIR/.env"
    old_db=$(cat "$b/db-jwt-secret")
    [ -n "$old_db" ] && q "alter database postgres set \"app.settings.jwt_secret\" to '$old_db'" >/dev/null
    # shellcheck disable=SC2046
    (cd "$SUPA_DIR" && docker compose $(supa_files) up -d)
    prev=$(env_value FRONTEND_PREV "$ROT_DIR/images.env")
    voice=$(running_image "$(compose_container "$FASTAPI_DIR" fastapi)")
    (cd "$FRONTEND_DIR" && FRONTEND_IMAGE="$prev" docker compose -f docker-compose.ghcr.yml up -d --force-recreate)
    (cd "$FASTAPI_DIR" && FASTAPI_IMAGE="$voice" docker compose -f docker-compose.ghcr.yml up -d --force-recreate)
    echo "  restored. Put the OLD anon key back in the GitHub secret NEXT_PUBLIC_SUPABASE_ANON_KEY:"
    env_value ANON_KEY "$ROT_DIR/old.env"
fi

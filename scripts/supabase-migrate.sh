#!/usr/bin/env bash
# Apply this repo's Supabase migrations, by hand, from a machine that can reach
# the database.
#
# Two modes, picked from what you set:
#
#   Self-hosted Supabase (your own Postgres) -- set SUPABASE_DB_URL.
#     No account, no project ref, no SUPABASE_ACCESS_TOKEN: those only exist for
#     projects hosted on supabase.com. Run this ON the server, or anywhere the
#     Postgres port is reachable from.
#
#   Hosted on supabase.com -- set SUPABASE_ACCESS_TOKEN + SUPABASE_DB_PASSWORD
#     + SUPABASE_PROJECT_REF (or NEXT_PUBLIC_SUPABASE_URL to derive the ref).
#     Same steps as .github/workflows/supabase-migrate.yml.
#
#   ./scripts/supabase-migrate.sh --check   # list only, change nothing
#   ./scripts/supabase-migrate.sh           # list, push, list again
#
# Credentials come from the environment or from SUPABASE_ENV_FILE
# (default: ./supabase/.env, which is gitignored).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

check_only=false
[ "${1:-}" = "--check" ] && check_only=true

env_file="${SUPABASE_ENV_FILE:-$repo_root/supabase/.env}"
if [ -f "$env_file" ]; then
  echo "==> Reading credentials from $env_file"
  set -a; . "$env_file"; set +a
fi

# The CLI needs supabase/config.toml and supabase/migrations to be here.
[ -f supabase/config.toml ] || { echo "ERROR: no supabase/config.toml under $repo_root -- run this from a checkout of the repo." >&2; exit 1; }

# A password with @ : / ? # or & in it breaks the URL unless percent-encoded,
# which is a confusing failure -- the CLI reports an unreachable host.
if [ -z "${SUPABASE_DB_URL:-}" ] && [ -n "${SUPABASE_DB_HOST:-}" ] && [ -n "${SUPABASE_DB_PASSWORD:-}" ]; then
  if command -v python3 >/dev/null 2>&1; then
    enc="$(SUPABASE_DB_PASSWORD="$SUPABASE_DB_PASSWORD" python3 -c \
      'import os,urllib.parse;print(urllib.parse.quote(os.environ["SUPABASE_DB_PASSWORD"],safe=""))')"
  else
    enc="$SUPABASE_DB_PASSWORD"
    echo "WARNING: no python3 to percent-encode the password; if it contains @ : / ? # or & set SUPABASE_DB_URL yourself." >&2
  fi
  SUPABASE_DB_URL="postgresql://${SUPABASE_DB_USER:-postgres}:${enc}@${SUPABASE_DB_HOST}:${SUPABASE_DB_PORT:-5432}/${SUPABASE_DB_NAME:-postgres}"
fi

if [ -n "${SUPABASE_DB_URL:-}" ]; then
  mode=direct
  # Never echo the URL itself; it carries the password.
  echo "==> Mode: direct database connection (self-hosted)"
else
  mode=linked
  ref="${SUPABASE_PROJECT_REF:-}"
  if [ -z "$ref" ]; then
    for url in "${NEXT_PUBLIC_SUPABASE_URL:-}" "${SUPABASE_URL:-}"; do
      [ -n "$url" ] || continue
      ref="$(printf '%s\n' "$url" | sed -nE 's#https://([a-z0-9]+)\.supabase\.co.*#\1#p')"
      [ -n "$ref" ] && break
    done
  fi
  missing=()
  [ -n "${SUPABASE_ACCESS_TOKEN:-}" ] || missing+=("SUPABASE_ACCESS_TOKEN")
  [ -n "${SUPABASE_DB_PASSWORD:-}" ]  || missing+=("SUPABASE_DB_PASSWORD")
  [ -n "$ref" ]                       || missing+=("SUPABASE_PROJECT_REF")
  if [ ${#missing[@]} -ne 0 ]; then
    echo "ERROR: missing ${missing[*]}" >&2
    echo "Self-hosted? Set SUPABASE_DB_URL instead -- the hosted-only credentials above do not apply." >&2
    echo "Set them in the environment or in $env_file" >&2
    exit 1
  fi
  export SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD
  echo "==> Mode: linked project $ref (supabase.com)"
fi

# Install the CLI on first run. Release assets carry the version in their name,
# so /releases/latest/download/<fixed-name> does not resolve -- ask the API.
if ! command -v supabase >/dev/null 2>&1; then
  echo "==> Installing the Supabase CLI into /usr/local/bin"
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "ERROR: unsupported architecture $(uname -m); install the CLI manually." >&2; exit 1 ;;
  esac
  asset="$(curl -fsSL https://api.github.com/repos/supabase/cli/releases/latest \
    | grep -oE "https://github.com/supabase/cli/releases/download/[^\"]+_linux_${arch}\.tar\.gz" \
    | head -n1)"
  [ -n "$asset" ] || { echo "ERROR: could not find a linux_${arch} release asset." >&2; exit 1; }
  sudo=""; [ "$(id -u)" -eq 0 ] || sudo=sudo
  curl -fsSL "$asset" | $sudo tar -xz -C /usr/local/bin supabase
fi

if [ "$mode" = linked ]; then
  echo "==> Linking project"
  supabase link --yes --project-ref "$ref"
  target=(--linked)
else
  target=(--db-url "$SUPABASE_DB_URL")
fi

echo "==> Pending migrations"
supabase migration list "${target[@]}"

if [ "$check_only" = true ]; then
  echo
  echo "==> --check given, nothing was changed."
  echo "    Read the list above before pushing. If the tables already exist but"
  echo "    show as *not* applied, do NOT push: the base migration has 22"
  echo "    statements (CREATE TYPE, CREATE POLICY) that fail on a second run."
  echo "    Mark them as already applied instead:"
  echo "      supabase migration repair --status applied <version> ..."
  exit 0
fi

echo "==> Pushing migrations"
supabase db push "${target[@]}" --yes

echo "==> Resulting state"
supabase migration list "${target[@]}"

#!/usr/bin/env bash
#
# Bootstrap the `dev` environment on Vercel end-to-end:
#   1. Verify CLI version + project link
#   2. Add three Supabase env vars scoped to the `dev` branch (preview env)
#   3. Attach `dev.dial8.ai` to the project
#   4. Configure the domain to track the `dev` git branch
#
# Idempotent: re-running is safe. Existing env vars / domains are detected
# and left alone (or updated, never duplicated).
#
# Usage:
#   ./scripts/bootstrap-dev-env.sh
#   ./scripts/bootstrap-dev-env.sh --non-interactive   # fail if values missing
#
# Required env vars (or you'll be prompted):
#   DEV_SUPABASE_URL
#   DEV_SUPABASE_ANON_KEY
#   DEV_SUPABASE_SERVICE_ROLE_KEY
#
# Optional overrides:
#   DEV_DOMAIN            (default: dev.dial8.ai)
#   DEV_GIT_BRANCH        (default: dev)
#   MIN_VERCEL_VERSION    (default: 54.0.0)

set -euo pipefail

DEV_DOMAIN="${DEV_DOMAIN:-dev.dial8.ai}"
DEV_GIT_BRANCH="${DEV_GIT_BRANCH:-dev}"
MIN_VERCEL_VERSION="${MIN_VERCEL_VERSION:-54.0.0}"
NON_INTERACTIVE="${NON_INTERACTIVE:-false}"

if [[ "${1:-}" == "--non-interactive" ]]; then
  NON_INTERACTIVE=true
fi

# ──────────────────────────────────────────────────────────────────────────
# Output helpers
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; BLUE=''; RESET=''
fi

step() { echo; echo "${BOLD}${BLUE}▶ $*${RESET}"; }
ok()   { echo "  ${GREEN}✓${RESET} $*"; }
warn() { echo "  ${YELLOW}!${RESET} $*"; }
err()  { echo "  ${RED}✗${RESET} $*" >&2; }
info() { echo "  ${DIM}$*${RESET}"; }

# ──────────────────────────────────────────────────────────────────────────
# Step 0 — Preflight
# ──────────────────────────────────────────────────────────────────────────

step "Preflight checks"

if ! command -v vercel >/dev/null 2>&1; then
  err "vercel CLI not found. Install with: npm i -g vercel@latest"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  err "jq not found. Install with: brew install jq"
  exit 1
fi

CLI_VERSION=$(vercel --version | tail -1)
ok "vercel CLI: $CLI_VERSION"

# Naive semver compare: works for x.y.z vs x.y.z
version_ge() {
  printf '%s\n%s\n' "$2" "$1" | sort -V -C
}
if ! version_ge "$CLI_VERSION" "$MIN_VERCEL_VERSION"; then
  err "vercel CLI $CLI_VERSION is older than required $MIN_VERCEL_VERSION"
  err "Run: npm i -g vercel@latest"
  exit 1
fi

if [[ ! -f .vercel/project.json && ! -f .vercel/repo.json ]]; then
  warn "Project not linked. Running 'vercel link --yes'..."
  vercel link --yes
fi

# Vercel CLI v54+ writes .vercel/repo.json with a `projects` array (supports
# monorepos). Older CLIs wrote .vercel/project.json with a flat shape.
# Handle both.
PROJECT_ID=""
PROJECT_NAME=""
ORG_ID=""

if [[ -f .vercel/repo.json ]]; then
  # New format: pick the project whose `directory` is "." (this dir)
  PROJECT_ENTRY=$(jq -r '.projects[] | select(.directory == ".") | @json' .vercel/repo.json | head -1)
  if [[ -z "$PROJECT_ENTRY" ]]; then
    # Fallback: first project in the list
    PROJECT_ENTRY=$(jq -r '.projects[0] | @json' .vercel/repo.json)
  fi
  PROJECT_ID=$(echo "$PROJECT_ENTRY" | jq -r '.id')
  PROJECT_NAME=$(echo "$PROJECT_ENTRY" | jq -r '.name')
  ORG_ID=$(echo "$PROJECT_ENTRY" | jq -r '.orgId')
elif [[ -f .vercel/project.json ]]; then
  PROJECT_JSON=$(cat .vercel/project.json)
  PROJECT_ID=$(echo "$PROJECT_JSON" | jq -r '.projectId')
  ORG_ID=$(echo "$PROJECT_JSON" | jq -r '.orgId')
  # Old format doesn't include name — fetch from API
  PROJECT_NAME=$(vercel api "/v10/projects/$PROJECT_ID" 2>/dev/null | jq -r '.name // empty')
fi

if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "null" ]]; then
  err "Could not determine projectId from .vercel/ link state"
  err "Contents of .vercel/:"
  ls -la .vercel/ >&2
  exit 1
fi

ok "Linked to project: $PROJECT_NAME ($PROJECT_ID)"
ok "Org/team: $ORG_ID"

# ──────────────────────────────────────────────────────────────────────────
# Step 1 — Collect Supabase values
# ──────────────────────────────────────────────────────────────────────────

step "Supabase credentials for the dev project"

prompt_var() {
  local name="$1"
  local label="$2"
  local secret="${3:-false}"
  local current="${!name:-}"

  if [[ -n "$current" ]]; then
    info "Using $name from environment"
    return
  fi

  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    err "$name is required in non-interactive mode (set env var)"
    exit 1
  fi

  # Read from /dev/tty so we work even when stdin is piped (npm run, etc.)
  if [[ ! -r /dev/tty ]]; then
    err "$name is required but no TTY available. Set it as an env var:"
    err "  export $name=..."
    err "  npm run bootstrap:dev"
    exit 1
  fi

  local value=""
  if [[ "$secret" == "true" ]]; then
    printf "  %s: " "$label" > /dev/tty
    IFS= read -r -s value < /dev/tty
    echo > /dev/tty
  else
    printf "  %s: " "$label" > /dev/tty
    IFS= read -r value < /dev/tty
  fi

  # Strip a single layer of surrounding straight quotes — users routinely
  # paste values copied as JSON strings like "https://...supabase.co".
  # Without this we silently stored the literal characters `""` once.
  if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi

  if [[ -z "$value" ]]; then
    err "$name cannot be empty"
    exit 1
  fi

  printf -v "$name" '%s' "$value"
  export "${name?}"
}

prompt_var DEV_SUPABASE_URL              "NEXT_PUBLIC_SUPABASE_URL          (https://xxx.supabase.co)"
prompt_var DEV_SUPABASE_ANON_KEY         "NEXT_PUBLIC_SUPABASE_ANON_KEY     (eyJ...)" true
prompt_var DEV_SUPABASE_SERVICE_ROLE_KEY "SUPABASE_SERVICE_ROLE_KEY         (eyJ...)" true

# Shape-check the values before we send anything to Vercel. A bad URL stored
# in Vercel surfaces only at runtime ("Invalid supabaseUrl") — catch it here.
if ! [[ "$DEV_SUPABASE_URL" =~ ^https://[a-zA-Z0-9.-]+\.supabase\.co/?$ ]]; then
  err "DEV_SUPABASE_URL doesn't look like a Supabase project URL"
  err "  got:      $DEV_SUPABASE_URL"
  err "  expected: https://<ref>.supabase.co"
  exit 1
fi
# Supabase anon + service-role keys are JWTs — they start with "eyJ"
if [[ "$DEV_SUPABASE_ANON_KEY" != eyJ* ]]; then
  err "DEV_SUPABASE_ANON_KEY doesn't look like a Supabase JWT (should start with eyJ)"
  exit 1
fi
if [[ "$DEV_SUPABASE_SERVICE_ROLE_KEY" != eyJ* ]]; then
  err "DEV_SUPABASE_SERVICE_ROLE_KEY doesn't look like a Supabase JWT (should start with eyJ)"
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────────
# Step 2 — Set env vars scoped to the dev branch
# ──────────────────────────────────────────────────────────────────────────

step "Configuring env vars (preview / git branch: $DEV_GIT_BRANCH)"

# Pull existing env vars as JSON so we can detect duplicates reliably.
# Vercel returns { envs: [...] } — note the wrapping object.
EXISTING_ENV_JSON=$(vercel env list preview "$DEV_GIT_BRANCH" --format json 2>/dev/null || echo '{"envs":[]}')

set_env() {
  local name="$1"
  local value="$2"
  # NOTE: the `sensitive` arg used to flip --no-sensitive on/off, but Vercel
  # CLI v54.4.1 has a bug where "sensitive" (encrypted) preview/branch-scoped
  # env vars come back empty on `vercel env pull` — verified by isolated repro.
  # Until the CLI is fixed we always set with --no-sensitive. Trade-off: the
  # value is visible to anyone with project access in the dashboard. For our
  # case (Supabase service-role key + anon key for the dev project) that's
  # the same surface as the production keys already have.
  local sensitive="${3:-false}"
  # Currently unused — kept so callers don't break — see note above
  : "$sensitive"

  local already_exists=false
  if echo "$EXISTING_ENV_JSON" | jq -e --arg n "$name" '.envs[] | select(.key == $n)' >/dev/null 2>&1; then
    already_exists=true
  fi

  if [[ "$already_exists" == "true" ]]; then
    warn "$name already exists for branch $DEV_GIT_BRANCH — removing first"
    if ! vercel env rm "$name" preview "$DEV_GIT_BRANCH" --yes >/dev/null 2>&1; then
      warn "  remove failed (continuing — add will use --force)"
    fi
  fi

  # Vercel CLI v54: env add NAME <environment> <git-branch> [options]
  # We pipe value via stdin AND pass --no-sensitive. Either path alone is
  # broken on v54.4.1 for branch-scoped previews — see note on `sensitive`
  # above. The combination here is the one that actually round-trips.
  local args=("$name" "preview" "$DEV_GIT_BRANCH" "--no-sensitive" "--yes" "--force")

  local output
  if output=$(printf '%s' "$value" | vercel env add "${args[@]}" 2>&1); then
    ok "Set $name"
  else
    err "Failed to set $name"
    echo "$output" | sed 's/^/    /'
    exit 1
  fi
}

# All three vars should be sensitive (encrypted, not shown in logs).
# NEXT_PUBLIC_SUPABASE_URL is technically client-bundle-exposed, but marking
# it sensitive in Vercel only affects how Vercel itself displays/exports it.
set_env NEXT_PUBLIC_SUPABASE_URL      "$DEV_SUPABASE_URL"              true
set_env NEXT_PUBLIC_SUPABASE_ANON_KEY "$DEV_SUPABASE_ANON_KEY"         true
set_env SUPABASE_SERVICE_ROLE_KEY     "$DEV_SUPABASE_SERVICE_ROLE_KEY" true

# ──────────────────────────────────────────────────────────────────────────
# Step 3 — Attach the domain to the project
# ──────────────────────────────────────────────────────────────────────────

step "Attaching $DEV_DOMAIN to the project"

info "Project: $PROJECT_NAME"

# Check if the domain is already attached to this project
DOMAIN_INFO=$(vercel api "/v10/projects/$PROJECT_ID/domains/$DEV_DOMAIN" 2>/dev/null || echo '{}')
if echo "$DOMAIN_INFO" | jq -e .name >/dev/null 2>&1; then
  ok "$DEV_DOMAIN already attached to $PROJECT_NAME"
else
  # POST /v10/projects/{id}/domains is the canonical endpoint
  # (vercel domains add CLI has buggy arg parsing in CLI 54.x)
  ATTACH_RESULT=$(vercel api -X POST "/v10/projects/$PROJECT_ID/domains" \
    -F "name=$DEV_DOMAIN" 2>&1) || true

  if echo "$ATTACH_RESULT" | jq -e .name >/dev/null 2>&1; then
    ok "Attached $DEV_DOMAIN"
  elif echo "$ATTACH_RESULT" | grep -qi "already.*exists\|already.*assigned"; then
    ok "$DEV_DOMAIN already attached (per Vercel)"
  else
    err "Failed to attach domain. API response:"
    echo "$ATTACH_RESULT"
    exit 1
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
# Step 4 — Pin the domain to the dev branch
# ──────────────────────────────────────────────────────────────────────────

step "Pinning $DEV_DOMAIN → branch '$DEV_GIT_BRANCH'"

CURRENT_BRANCH=$(vercel api "/v10/projects/$PROJECT_ID/domains/$DEV_DOMAIN" 2>/dev/null | jq -r '.gitBranch // empty')

if [[ "$CURRENT_BRANCH" == "$DEV_GIT_BRANCH" ]]; then
  ok "Already pinned to '$DEV_GIT_BRANCH'"
else
  if [[ -n "$CURRENT_BRANCH" ]]; then
    warn "Currently pinned to '$CURRENT_BRANCH' — updating"
  fi

  PATCH_RESULT=$(vercel api -X PATCH "/v10/projects/$PROJECT_ID/domains/$DEV_DOMAIN" \
    -F "gitBranch=$DEV_GIT_BRANCH" 2>&1) || {
    err "Failed to set git branch on domain. API response:"
    echo "$PATCH_RESULT"
    exit 1
  }

  ok "Pinned $DEV_DOMAIN → '$DEV_GIT_BRANCH'"
fi

# ──────────────────────────────────────────────────────────────────────────
# Done
# ──────────────────────────────────────────────────────────────────────────

step "Done"
ok "Vercel is configured for the dev environment."
echo
echo "${BOLD}Next steps:${RESET}"
echo "  1. Update DNS at your registrar (Vercel will tell you what to set)"
echo "     vercel domains inspect $DEV_DOMAIN"
echo "  2. Trigger a deploy:"
echo "     git checkout $DEV_GIT_BRANCH"
echo "     git commit --allow-empty -m 'chore: trigger dev deploy'"
echo "     git push"
echo "  3. After deploy, smoke-test:"
echo "     BASE_URL=https://$DEV_DOMAIN npm run e2e"

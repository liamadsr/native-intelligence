#!/usr/bin/env bash
# The container test: start the stack in compose.yaml with throwaway values, wait
# until every container is healthy, then check that each role answers.
#
#   docker compose -f deploy/app/compose.yaml build web   # first: the image
#   deploy/app/smoke.sh              start, check, stop and delete the volumes
#   NI_KEEP=1 deploy/app/smoke.sh    leave the stack running afterwards
#
# No secret is needed and none is used: every value below is made up for the run.
# With made-up values there is no database and no model, so this proves that the
# roles start and reach each other and that an agent's workflow engine runs, not
# that an agent can finish a turn.
#
# Prints one line per check, writes the same as Markdown to $GITHUB_STEP_SUMMARY when
# that is set, and exits non-zero if any check failed.
set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PORT="${NI_PORT:-8080}"
export NI_PORT="$PORT"
work="$(mktemp -d)"
export NI_ENV_FILE="$work/smoke.env"
compose() { docker compose -f "$HERE/compose.yaml" "$@"; }

random() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }
cron_secret="$(random)"
internal_secret="$(random)"
cat > "$NI_ENV_FILE" <<EOF
CRON_SECRET=$cron_secret
RUN_SKILL_INTERNAL_SECRET=$internal_secret
INNGEST_SIGNING_KEY=signkey-test-$(random)
INNGEST_EVENT_KEY=$(random)
SUPABASE_SERVICE_ROLE_KEY=$(random)
NEXT_PUBLIC_SUPABASE_URL=http://supabase.invalid
NEXT_PUBLIC_SUPABASE_ANON_KEY=build-placeholder
EOF

failed=0
rows=()
check() { # <ok|FAIL> <what> <detail>
  [ "$1" = ok ] || failed=1
  printf '%-4s %-46s %s\n' "$1" "$2" "$3"
  rows+=("| $([ "$1" = ok ] && echo pass || echo '**FAIL**') | $2 | $3 |")
}

finish() {
  local status=$?
  if [ "${NI_KEEP:-}" != 1 ]; then
    compose down --volumes --remove-orphans > /dev/null 2>&1
  fi
  rm -rf "$work"
  exit "$status"
}
trap finish EXIT

# One HTTP GET from inside a container (the image has node, not curl): prints
# "<status> <first 200 characters of the body>".
get_from() { # <service> <url> [authorization]
  compose exec -T -e URL="$2" -e AUTH="${3:-}" "$1" node -e '
    const headers = process.env.AUTH ? { authorization: process.env.AUTH } : {}
    fetch(process.env.URL, { headers, redirect: "manual", signal: AbortSignal.timeout(20000) })
      .then(async response => console.log(response.status, (await response.text()).replace(/\s+/g, " ").slice(0, 200)))
      .catch(error => console.log("000", error?.cause?.code ?? error.message))
  ' 2> /dev/null
}
# The same from this machine, through the proxy's published port.
get() { # <path>
  local body status
  body="$(curl -sS -m 20 -o - -w '\n%{http_code}' "http://127.0.0.1:$PORT$1" 2> /dev/null)"
  status="${body##*$'\n'}"
  printf '%s %s\n' "${status:-000}" "$(printf '%s' "${body%$'\n'*}" | tr -s '[:space:]' ' ' | cut -c1-200)"
}
expect() { # <what> <"status body"> <wanted status> [body must contain]
  local status="${2%% *}" body="${2#* }"
  if [ "$status" = "$3" ] && { [ -z "${4:-}" ] || [[ "$body" == *"$4"* ]]; }; then
    check ok "$1" "$status ${body:0:90}"
  else
    check FAIL "$1" "wanted $3${4:+ with $4}, got $status ${body:0:160}"
  fi
}

image="${NI_APP_IMAGE:-ni-app:local}"
docker image inspect "$image" > /dev/null 2>&1 || {
  echo "smoke: no image $image. Build it first: docker compose -f deploy/app/compose.yaml build web" >&2
  exit 2
}

echo "== start"
started=$SECONDS
if compose up -d --wait --wait-timeout "${NI_WAIT_SECONDS:-300}"; then
  check ok "every container healthy" "$(compose ps -q | wc -l | tr -d ' ') containers in $((SECONDS - started))s"
else
  # The checks below still run: they show which role is the one that is down.
  check FAIL "every container healthy" "docker compose up --wait failed"
fi

echo "== checks"
agents="$(compose run --rm --no-deps -T web agents 2> /dev/null)"
count="$(printf '%s\n' "$agents" | grep -c .)"
[ "$count" -eq 8 ] && check ok "agents in the image" "$count: $(echo $agents)" \
  || check FAIL "agents in the image" "wanted 8, found $count: $(echo $agents)"

# web: through the proxy, and the worker's /api/inngest (Inngest's own status reply,
# which says how many functions the server loaded).
expect "web /api/version" "$(get /api/version)" 200 '"buildId"'
expect "worker /api/inngest" "$(get /api/inngest)" 200 'function_count'
expect "worker /api/version (direct)" "$(get_from worker http://127.0.0.1:3000/api/version)" 200 '"buildId"'

for name in $agents; do
  # The agent's own health route, straight through the proxy.
  expect "agent $name health" "$(get "/eve/$name/v1/health")" 200 '"status":"ready"'
  # The same through Next's rewrite: web -> EVE_NEXT_PRODUCTION_ORIGIN -> the agent.
  expect "agent $name via web's rewrite" "$(get_from web "http://127.0.0.1:3000/eve/$name/v1/health")" 200 '"status":"ready"'
  # A protected route with no credentials: the agent's own auth must refuse it.
  expect "agent $name refuses anonymous" "$(get "/eve/$name/v1/info")" 401
  # The sandbox the build prepared, and what the running container offers: no Docker
  # and no /dev/kvm (so nothing but just-bash), the package beside the server, and a
  # folder for session files that the agent may write to.
  sandbox="$(compose exec -T -w "/app/web/agents/$name" "agent-$name" node -e '
    const fs = require("node:fs")
    const record = JSON.parse(fs.readFileSync(".output/.eve/compile/sandbox-prepared-artifacts.json", "utf8"))
    const providers = [...new Set(record.entries.map(entry => entry.providerName))].join(",")
    let docker = "no"
    try { require("node:child_process").execFileSync("docker", ["version"], { stdio: "ignore" }); docker = "yes" } catch {}
    const packaged = fs.existsSync(".output/server/node_modules/just-bash/package.json") ? "yes" : "no"
    let writable = "yes"
    try { fs.accessSync(".eve/sandbox-cache/just-bash/sessions", fs.constants.W_OK) } catch { writable = "no" }
    console.log(`built=${providers} docker=${docker} kvm=${fs.existsSync("/dev/kvm") ? "yes" : "no"} packaged=${packaged} sessions-writable=${writable}`)
  ' 2> /dev/null)"
  [ "$sandbox" = "built=just-bash docker=no kvm=no packaged=yes sessions-writable=yes" ] \
    && check ok "agent $name sandbox" "$sandbox" \
    || check FAIL "agent $name sandbox" "${sandbox:-no answer}"
done

# One real run of eve's workflow engine, on skill-runner: its route auth is the
# internal secret alone, and it keeps its runs (utility and web-research delete
# theirs when they end). With no database there is no skill to run, so the run fails
# at its first step, by the agent's own rule. What counts is that the session was
# accepted, a workflow step ran, and the events came back on the stream.
run_stream() { # <session id>: the stream's event types, in order
  curl -sS -m 30 -N -H "Authorization: Bearer $internal_secret" \
    "http://127.0.0.1:$PORT/eve/skill-runner/v1/session/$1/stream" 2> /dev/null \
    | grep -o '"type":"[a-z.]*"' | cut -d'"' -f4 | tr '\n' ' '
}
created="$(curl -sS -m 30 -X POST -H "Authorization: Bearer $internal_secret" -H 'Content-Type: application/json' \
  -d '{"message":"smoke test"}' "http://127.0.0.1:$PORT/eve/skill-runner/v1/session" 2> /dev/null)"
session="$(printf '%s' "$created" | grep -o '"sessionId":"[^"]*"' | cut -d'"' -f4)"
if [ -z "$session" ]; then
  check FAIL "skill-runner accepts a session" "${created:0:160}"
else
  check ok "skill-runner accepts a session" "$session"
  events="$(run_stream "$session")"
  case "$events" in
    session.started*session.failed* | session.started*session.completed*)
      check ok "skill-runner runs a workflow" "$events" ;;
    *) check FAIL "skill-runner runs a workflow" "events: ${events:-none}" ;;
  esac
  # The run is on the agent's volume, not in its container: a new container must
  # still have it.
  compose up -d --force-recreate --no-deps --wait agent-skill-runner > /dev/null 2>&1
  again="$(run_stream "$session")"
  [ -n "$events" ] && [ "$again" = "$events" ] \
    && check ok "the run survives a new container" "the same events, read from the volume" \
    || check FAIL "the run survives a new container" "before: ${events:-none}; after: ${again:-none}"
fi

# cron: the crontab parses, the cron container reaches web, and web accepts the
# secret (a wrong one is 401; the right one gets past auth to the route itself).
if compose exec -T cron supercronic -test /app/deploy/app/cron/crontab > "$work/crontab.log" 2>&1; then
  check ok "cron crontab parses" "$(grep -c call.mjs "$HERE/cron/crontab") jobs"
else
  check FAIL "cron crontab parses" "$(tail -n 2 "$work/crontab.log" | tr '\n' ' ')"
fi
expect "cron route refuses a wrong secret" "$(get_from cron http://web:3000/api/cron/approval-expiry 'Bearer wrong')" 401
accepted="$(get_from cron http://web:3000/api/cron/approval-expiry "Bearer $cron_secret")"
case "${accepted%% *}" in
  401 | 503 | 000) check FAIL "cron route accepts CRON_SECRET" "got $accepted" ;;
  *) check ok "cron route accepts CRON_SECRET" "past auth: ${accepted:0:90}" ;;
esac

if [ "$failed" -ne 0 ]; then
  echo "== logs (a check failed)"
  compose ps -a
  compose logs --no-color --tail 40
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Smoke test: $([ "$failed" -eq 0 ] && echo passed || echo FAILED)"
    echo
    echo "| | Check | Result |"
    echo "|---|---|---|"
    printf '%s\n' "${rows[@]}"
    echo
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "== $([ "$failed" -eq 0 ] && echo "smoke test passed" || echo "SMOKE TEST FAILED")"
exit "$failed"

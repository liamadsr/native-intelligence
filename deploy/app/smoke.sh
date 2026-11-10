#!/usr/bin/env bash
# The container test: start the stack in smoke/compose.yaml with throwaway values, wait
# until every container is healthy, then check that each role answers.
#
#   docker compose -f deploy/app/smoke/compose.yaml build web   # first: the image
#   deploy/app/smoke.sh              start, check, stop and delete the volumes
#   NI_KEEP=1 deploy/app/smoke.sh    leave the stack running afterwards
#
# No secret is needed and none is used: every value below is made up for the run.
# With made-up values there is no database and no model. So this shows that every
# role starts, that the proxy, web and the agents are wired to each other, and that
# an agent's workflow engine runs. It does not show an agent finishing a turn or
# calling the app back, nor a cron route doing its work.
#
# Prints one line per check, writes the same as Markdown to $GITHUB_STEP_SUMMARY when
# that is set, and exits non-zero if any check failed.
set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PORT="${NI_PORT:-8080}"
export NI_PORT="$PORT"
work="$(mktemp -d)"
export NI_ENV_FILE="$work/smoke.env"
compose() { docker compose -f "$HERE/smoke/compose.yaml" "$@"; }

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
  if [ "${NI_KEEP:-}" = 1 ]; then
    echo "== left running at http://127.0.0.1:$PORT. Its made-up values are in $NI_ENV_FILE; stop it with:"
    echo "   NI_ENV_FILE=$NI_ENV_FILE docker compose -f $HERE/smoke/compose.yaml down --volumes"
  else
    compose down --volumes --remove-orphans > /dev/null 2>&1
    rm -rf "$work"
  fi
  exit "$status"
}
trap finish EXIT

# One HTTP GET from this machine, through the proxy's published port. Prints
# "<status> [<the container that answered>] <first 200 characters of the body>":
# the proxy names the container in X-NI-Upstream.
get() { # <path>
  local status upstream
  status="$(curl -sS -m 20 -D "$work/headers" -o "$work/body" -w '%{http_code}' "http://127.0.0.1:$PORT$1" 2> /dev/null)"
  upstream="$(tr -d '\r' < "$work/headers" 2> /dev/null | awk 'tolower($1) == "x-ni-upstream:" { print $2 }')"
  printf '%s [%s] %s\n' "${status:-000}" "${upstream:--}" "$(tr -s '[:space:]' ' ' < "$work/body" 2> /dev/null | cut -c1-200)"
}
# The same from inside a container (the image has node, not curl).
get_from() { # <service> <url>
  compose exec -T -e URL="$2" "$1" node -e '
    fetch(process.env.URL, { redirect: "manual", signal: AbortSignal.timeout(20000) })
      .then(async response => console.log(
        response.status,
        `[${response.headers.get("x-ni-upstream") ?? "-"}]`,
        (await response.text()).replace(/\s+/g, " ").slice(0, 200),
      ))
      .catch(error => console.log("000 [-]", error?.cause?.code ?? error.message))
  ' 2> /dev/null
}
expect() { # <what> <"status rest"> <wanted status> [text the rest must contain]...
  local what="$1" status="${2%% *}" rest="${2#* }" wanted="$3" missing="" text
  shift 3
  for text in "$@"; do
    [[ "$rest" == *"$text"* ]] || missing="$missing $text"
  done
  if [ "$status" = "$wanted" ] && [ -z "$missing" ]; then
    check ok "$what" "$status ${rest:0:110}"
  else
    check FAIL "$what" "wanted $wanted${missing:+ with$missing}, got $status ${rest:0:160}"
  fi
}

image="${NI_APP_IMAGE:-ni-app:local}"
docker image inspect "$image" > /dev/null 2>&1 || {
  echo "smoke: no image $image. Build it first: docker compose -f deploy/app/smoke/compose.yaml build web" >&2
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

# web, and the worker's /api/inngest: Inngest's own status reply, which says how many
# functions the server loaded. The proxy must have sent each to the right container.
expect "web /api/version" "$(get /api/version)" 200 '[web:3000]' '"buildId"'
expect "worker /api/inngest" "$(get /api/inngest)" 200 '[worker:3000]' '"function_count"'

for name in $agents; do
  # The agent's own health route, straight from the proxy to the agent.
  expect "agent $name health" "$(get "/eve/$name/v1/health")" 200 "[agent-$name:3000]" '"status":"ready"'
  # The same through Next's rewrite: web -> EVE_NEXT_PRODUCTION_ORIGIN -> the agent.
  expect "agent $name via web's rewrite" "$(get_from web "http://127.0.0.1:3000/eve/$name/v1/health")" 200 "[agent-$name:3000]" '"status":"ready"'
  # A protected route with no credentials: the agent's own auth must refuse it.
  expect "agent $name refuses anonymous" "$(get "/eve/$name/v1/info")" 401 "[agent-$name:3000]"
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

# cron. The stack's scheduler is a dry run (smoke/compose.yaml says why), so the calls are
# made here, with the script the crontab runs. One route, chosen because it does
# nothing without a database: its 500 with "ok":false is the route itself answering,
# past the secret check.
cron_call() { # [NAME=value]...: one call from the cron container; prints its line
  local pair env=()
  for pair in "$@"; do env+=(-e "$pair"); done
  # ${env[@]+...}: bash before 4.4 (macOS's 3.2) calls an empty array unbound under set -u.
  compose exec -T ${env[@]+"${env[@]}"} cron node /app/deploy/app/cron/call.mjs /api/cron/approval-expiry 2>&1 | tr -s '[:space:]' ' '
}
contains() { # <what> <text> <wanted>...
  local what="$1" text="$2" missing="" wanted
  shift 2
  for wanted in "$@"; do
    [[ "$text" == *"$wanted"* ]] || missing="$missing $wanted"
  done
  [ -z "$missing" ] && check ok "$what" "${text:0:120}" || check FAIL "$what" "wanted$missing, got ${text:0:160}"
}
if compose exec -T cron supercronic -test /app/deploy/app/cron/crontab > "$work/crontab.log" 2>&1; then
  check ok "cron crontab parses" "$(grep -c call.mjs "$HERE/cron/crontab") jobs"
else
  check FAIL "cron crontab parses" "$(tail -n 2 "$work/crontab.log" | tr '\n' ' ')"
fi
contains "cron is a dry run in this stack" "$(cron_call)" 'skipped'
contains "cron call with a wrong secret is refused" "$(cron_call CRON_DRY_RUN= CRON_SECRET=wrong)" ': 401 '
contains "cron call with CRON_SECRET reaches the route" "$(cron_call CRON_DRY_RUN=)" ': 500 ' '"ok":false'

# Every role, idle, exits on SIGTERM by itself. smoke/compose.yaml gives each a long
# stop_grace_period for work in flight; one that ignored SIGTERM would hold every
# redeploy for all of it. Docker SIGKILLs what is still running after 30 s here,
# and a container it had to kill exits 137.
if [ "${NI_KEEP:-}" != 1 ]; then
  started=$SECONDS
  compose stop --timeout 30 > /dev/null 2>&1
  stopped="$(docker inspect -f '{{.Name}}={{.State.ExitCode}}' $(compose ps -aq) 2> /dev/null | sed 's#^/##' | tr '\n' ' ')"
  case " $stopped" in
    *=137\ *) check FAIL "every role stops on SIGTERM" "SIGKILLed after 30s (exit 137): $stopped" ;;
    *) check ok "every role stops on SIGTERM" "in $((SECONDS - started))s: $stopped" ;;
  esac
fi

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

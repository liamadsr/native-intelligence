#!/bin/sh
# The image's entrypoint: one image, four roles. The role is the command, or NI_ROLE
# (and NI_AGENT) when no command is given.
#
#   web            next start on $PORT. /eve/<name>/v1/* goes to EVE_NEXT_PRODUCTION_ORIGIN
#                  (agents run elsewhere; no agent starts in this container).
#   worker         the same server. Route only /api/inngest to it.
#   agent <name>   eve start for one agent on $PORT.
#   cron           supercronic with cron/crontab: calls CRON_TARGET_URL/api/cron/*
#                  (CRON_DRY_RUN=1: logs each job and calls nothing).
#   agents         print the agents built into this image, one per line.
#
# Anything else runs as a command (`docker run ... ni-app node --version`).
set -eu

WEB=/app/web
DEPLOY=/app/deploy/app
PORT="${PORT:-3000}"

die() {
  echo "entrypoint: $*" >&2
  exit 64
}

# Says which role this container runs, for healthcheck.mjs.
remember_role() {
  printf '%s\n' "$*" > /tmp/ni-role
}

if [ "$#" -eq 0 ]; then
  [ -n "${NI_ROLE:-}" ] || die "no role: pass web, worker, agent <name> or cron (or set NI_ROLE)"
  set -- "$NI_ROLE" ${NI_AGENT:+"$NI_AGENT"}
fi

role="$1"
case "$role" in
  web | worker)
    # `next build` wrote the agents' origin into its rewrites, and `next start` routes
    # by those: another value set here would change nothing. Refuse it, so nobody
    # believes this container talks to agents it does not.
    built="$(node "$DEPLOY/eve-origin.mjs")" || die "this image's next build has no origin for the agents"
    EVE_NEXT_PRODUCTION_ORIGIN="${EVE_NEXT_PRODUCTION_ORIGIN:-$built}"
    [ "$EVE_NEXT_PRODUCTION_ORIGIN" = "$built" ] \
      || die "EVE_NEXT_PRODUCTION_ORIGIN is $EVE_NEXT_PRODUCTION_ORIGIN, but this image was built for $built; rebuild with --build-arg EVE_NEXT_PRODUCTION_ORIGIN=$EVE_NEXT_PRODUCTION_ORIGIN"
    export EVE_NEXT_PRODUCTION_ORIGIN
    echo "entrypoint: $role on :$PORT, agents at $built"
    remember_role "$role"
    cd "$WEB"
    exec node node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port "$PORT"
    ;;

  agent)
    name="${2:-${NI_AGENT:-}}"
    [ -n "$name" ] || die "agent needs a name: one of $("$DEPLOY/build-agents.sh" --list | tr '\n' ' ')"
    "$DEPLOY/build-agents.sh" --list | grep -qx -- "$name" \
      || die "no agent named '$name' in this image: $("$DEPLOY/build-agents.sh" --list | tr '\n' ' ')"
    # The agent's public mount, as in the build: the callback URLs it makes use it.
    export EVE_PUBLIC_ROUTE_PREFIX="/eve/$name"
    remember_role "agent $name"
    cd "$WEB/agents/$name"
    exec node "$WEB/node_modules/eve/bin/eve.js" start --host 0.0.0.0 --port "$PORT"
    ;;

  cron)
    [ -n "${CRON_TARGET_URL:-}" ] || die "cron needs CRON_TARGET_URL (the web role's origin, e.g. http://web:3000)"
    [ -n "${CRON_SECRET:-}" ] || die "cron needs CRON_SECRET (the web role's)"
    remember_role cron
    [ "${CRON_DRY_RUN:-}" != 1 ] || echo "entrypoint: cron is a dry run (CRON_DRY_RUN=1): jobs are logged, nothing is called"
    # -passthrough-logs: each job's one line as call.mjs printed it.
    exec supercronic -passthrough-logs "$DEPLOY/cron/crontab"
    ;;

  agents)
    exec "$DEPLOY/build-agents.sh" --list
    ;;

  *)
    exec "$@"
    ;;
esac

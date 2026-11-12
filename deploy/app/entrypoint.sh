#!/bin/sh
# The image's entrypoint: one image, four roles. The role is the command, or NI_ROLE
# (and NI_AGENT) when no command is given.
#
#   web            next start on $PORT. /eve/<name>/v1/* goes to EVE_NEXT_PRODUCTION_ORIGIN
#                  (agents run elsewhere; no agent starts in this container).
#   worker         the same server. Route only /api/inngest to it.
#   agent <name>   one agent's built server on $PORT (what `eve start` runs; see below).
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

# Development mode switches off the checks that keep strangers out, and every role
# reads the same env file (web/.env.example has INNGEST_DEV=1), so no role starts
# with it on.
# - Inngest: in dev mode `serve()` runs any function for a request with no signature.
#   The SDK alone decides what counts: "1" and "true" do, and so does any other value
#   it can read as a URL ("yes", "no", "inngest:8288"); "0", "false" and empty do not.
#   INNGEST_DEV=0 is how this app is pointed at a self-hosted Inngest server.
# - eve: EVE_DEV=1 (exactly "1", as eve reads it) lets anyone in as the local-dev
#   user, and off Vercel the agents' localDevOffVercel() passes that through.
refuse_development_mode() {
  inngest_mode="$(cd "$WEB" && node -e "process.stdout.write(new (require('inngest').Inngest)({ id: 'entrypoint' }).mode)")" \
    || die "cannot ask the Inngest SDK whether INNGEST_DEV turns on development mode"
  [ "$inngest_mode" = cloud ] \
    || die "INNGEST_DEV='${INNGEST_DEV:-}' puts Inngest in development mode, which skips signature checks on /api/inngest. Unset it, or set INNGEST_DEV=0 with a signing key."
  [ "${EVE_DEV:-}" != 1 ] \
    || die "EVE_DEV=1 puts the agents in development mode, which lets anyone in without credentials. Unset it."
}

# NI_LIVE=1 says that this copy of the app is the live one. Anything else, and the
# copy acts only when asked: a second copy beside the live app, on the same database
# and the same Inngest server (a rehearsal), must not do production's work twice.
# - web, worker: the Inngest SDK registers the app's functions with
#   INNGEST_API_BASE_URL (before INNGEST_BASE_URL). Pointed at a closed port, a
#   request that asks this copy to register (a PUT to /api/inngest, which anyone can
#   send) fails, so Inngest's calls for production's functions never come here.
#   Events still reach the server at INNGEST_BASE_URL.
# - cron: every job is logged and nothing is called (CRON_DRY_RUN=1).
# Only this process and its children see these. `docker compose exec` does not, so a
# job can still be called by hand: `exec cron node /app/deploy/app/cron/call.mjs <path>`.
not_live() {
  [ "${NI_LIVE:-}" != 1 ]
}

# A rehearsal may run on stand-ins for secrets that production must have the real
# values of (pull-settings.sh writes them, starting with "rehearsal-"). The live copy
# never starts on one.
if ! not_live && env | grep -q '^[A-Za-z_][A-Za-z0-9_]*=rehearsal-'; then
  die "NI_LIVE=1, but $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=rehearsal-.*/\1/p' | tr '\n' ' ')still holds a rehearsal's stand-in. Put the real value in with set-secret.sh first."
fi

# The commit this image was built from (Dockerfile). The app reads it as
# VERCEL_GIT_COMMIT_SHA: the cloud browser's relay must report the same one, and
# /api/version gives it to open windows. Empty in an image built without it.
if [ -z "${VERCEL_GIT_COMMIT_SHA:-}" ] && [ -s /app/BUILD_ID ]; then
  VERCEL_GIT_COMMIT_SHA="$(cat /app/BUILD_ID)"
  export VERCEL_GIT_COMMIT_SHA
fi

if [ "$#" -eq 0 ]; then
  [ -n "${NI_ROLE:-}" ] || die "no role: pass web, worker, agent <name> or cron (or set NI_ROLE)"
  set -- "$NI_ROLE" ${NI_AGENT:+"$NI_AGENT"}
fi

role="$1"
case "$role" in
  web | worker | agent | cron) refuse_development_mode ;;
esac
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
    if not_live; then
      export INNGEST_API_BASE_URL=http://127.0.0.1:9
      echo "entrypoint: NI_LIVE is not 1: this $role cannot register the app with Inngest"
    fi
    # `next start` builds each request's URL from the address it listens on
    # (https://0.0.0.0:3000/...), and a route that redirects with
    # `new URL(path, request.url)` would send the browser there. With this, Next takes
    # the public host the proxy passes on instead (web/patches/next+16.1.1.patch).
    export NI_REQUEST_URL_FROM_HOST=1
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
    # The sandbox this agent's build prepared must be the one it opens now: the coding
    # agent opens the hosted sandbox service when SANDBOX_ACCESS_TOKEN, SANDBOX_TEAM_ID
    # and SANDBOX_PROJECT_ID are set, our own runtime when SANDBOX_RUNTIME_API_URL and
    # SANDBOX_RUNTIME_TRAFFIC_URL are (it reads SANDBOX_RUNTIME_KEY only when it
    # starts a sandbox), just-bash when none is. A build made with other
    # settings than these would start healthy and fail at its first run, so it does
    # not start (the message says which way, and what to do).
    "$DEPLOY/build-agents.sh" --check-sandbox "$name" || exit 64
    # The agent's public mount, as in the build: the callback URLs it makes use it.
    export EVE_PUBLIC_ROUTE_PREFIX="/eve/$name"
    remember_role "agent $name"
    cd "$WEB/agents/$name"
    # The built server, run as `eve start --host 0.0.0.0 --port $PORT` runs it, minus
    # that command's own process. In eve 0.79.1 (cli/run.js, cli/dev/environment.js,
    # internal/nitro/host/start-production-server.js) `eve start`:
    # - loads .env.development.local, .env.local, .env.development and .env from
    #   /app/web without overriding what is set (the image has none), and sets
    #   EVE_MODEL_CONNECTION, EVE_MODEL_KEY_SOURCE, EVE_MODEL_TEAM and
    #   EVE_MODEL_TEAM_NAME from agents/<name>/.eve/provider.json, or deletes them
    #   (the image has no such file): here, they are deleted and no file is read;
    # - spawns `node .output/server/index.mjs` in this folder, stdin closed, with
    #   HOST and NITRO_HOST set to the host, PORT and NITRO_PORT to the port: the same;
    # - keeps all of that server's stdout and stderr in a string it never clears,
    #   which grows with every log line for as long as the agent runs: not here;
    # - gives up and exits 1 if the server is not listening within 60 s: here, the
    #   health check's start period;
    # - on SIGTERM or SIGINT sends the server SIGTERM, SIGKILLs it after 20 s and
    #   exits 0: here the server gets the signal itself (srvx closes it, giving open
    #   requests 5 s) and exits on its own; compose.yaml's stop_grace_period is the
    #   SIGKILL. smoke.sh checks that every role stops without one.
    # Compare these steps with a new eve's before upgrading it.
    # Where another agent, or this one's own tools, call back into a session: eve
    # builds that address from its workflow store's (http://localhost:3000) or the
    # request's origin, plus /eve/<name>. From another container localhost is the
    # wrong place. On its earlier host eve uses the public production address; this
    # gives it the app's public address the same way (web/patches/eve+0.79.1.patch),
    # and the call comes back in through the proxy like any other.
    export EVE_CALLBACK_BASE_URL="${EVE_CALLBACK_BASE_URL:-${NEXT_PUBLIC_APP_URL:-}}"
    unset EVE_MODEL_CONNECTION EVE_MODEL_KEY_SOURCE EVE_MODEL_TEAM EVE_MODEL_TEAM_NAME
    export HOST=0.0.0.0 NITRO_HOST=0.0.0.0 PORT="$PORT" NITRO_PORT="$PORT"
    exec node .output/server/index.mjs < /dev/null
    ;;

  cron)
    [ -n "${CRON_TARGET_URL:-}" ] || die "cron needs CRON_TARGET_URL (the web role's origin, e.g. http://web:3000)"
    [ -n "${CRON_SECRET:-}" ] || die "cron needs CRON_SECRET (the web role's)"
    remember_role cron
    if not_live; then
      export CRON_DRY_RUN=1
      echo "entrypoint: NI_LIVE is not 1: cron is a dry run, jobs are logged, nothing is called"
    elif [ "${CRON_DRY_RUN:-}" = 1 ]; then
      echo "entrypoint: cron is a dry run (CRON_DRY_RUN=1): jobs are logged, nothing is called"
    fi
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

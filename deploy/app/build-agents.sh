#!/bin/sh
# Builds the eve agents for the image, and answers two questions about them.
#
#   build-agents.sh                          build every agent (the Dockerfile runs this)
#   build-agents.sh --list                   the agents' names, one per line
#   build-agents.sh --state-dirs             each agent's folders that hold state while it runs
#   build-agents.sh --sandbox-provider <name>  the sandbox that agent must be built with,
#                                            given the settings in this environment
#   build-agents.sh --check-sandbox <name>   exits 0 only if that agent was built with
#                                            it (entrypoint.sh runs this at start)
#
# The image keeps the repository's layout (/app/web, /app/deploy/app), so the paths
# below are the same in a checkout.
#
# The agents are the ones web/next.config.mjs mounts with withEve. Off Vercel each
# needs its own `eve build`, run from its folder (eve's self-hosting guide,
# "Run workspace members"): that writes a Node server to agents/<name>/.output and a
# sandbox template to agents/<name>/.eve/sandbox-cache.
#
# The coding agent is the one exception to just-bash: given SANDBOX_ACCESS_TOKEN,
# SANDBOX_TEAM_ID and SANDBOX_PROJECT_ID, its sandbox runs on the hosted sandbox
# service (web/agents/coding-agent/sandbox.ts), whose snapshot `eve build` prepares
# there. The Dockerfile hands the three to this script as BuildKit secrets, which
# exist only while it runs; only the coding agent's build sees them.
set -eu

HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
WEB="$(CDPATH= cd -- "$HERE/../../web" && pwd)"
# The sandbox provider a plain container can run: no Docker daemon, no /dev/kvm.
SANDBOX_PROVIDER="${NI_SANDBOX_PROVIDER:-just-bash}"
# The hosted sandbox service, as eve names its provider.
HOSTED_PROVIDER=vercel
CREDENTIALS="SANDBOX_ACCESS_TOKEN SANDBOX_TEAM_ID SANDBOX_PROJECT_ID"

# The sandbox <name> must be built with: the hosted one for the coding agent when
# all three settings are set, just-bash when none is, and an error (exit 1) when
# only some are, as the agent itself refuses them. Blank counts as unset.
sandbox_provider() {
  if [ "$1" != coding-agent ]; then
    echo "$SANDBOX_PROVIDER"
    return 0
  fi
  set_names="" missing=""
  for var in $CREDENTIALS; do
    eval "value=\${$var:-}"
    case "$value" in
      *[![:space:]]*) set_names="$set_names $var" ;;
      *) missing="$missing $var" ;;
    esac
  done
  if [ -z "$set_names" ]; then
    echo "$SANDBOX_PROVIDER"
  elif [ -z "$missing" ]; then
    echo "$HOSTED_PROVIDER"
  else
    echo "build-agents: the coding agent's sandbox needs all three of $CREDENTIALS, or none; missing:$missing" >&2
    return 1
  fi
}

# A value without its spaces and line breaks (the agent trims the settings too).
trimmed() {
  printf '%s' "$1" | tr -d '[:space:]'
}

# A build log, with the access token (if this environment has one) cut out.
redacted() {
  NI_REDACT="$(printf '%s' "${SANDBOX_ACCESS_TOKEN:-}" | tr -d '[:space:]')" awk '
    { t = ENVIRON["NI_REDACT"]; if (t != "") while ((i = index($0, t)) > 0) $0 = substr($0, 1, i - 1) "[redacted]" substr($0, i + length(t)); print }
  ' "$1"
}

# The providers <name>'s build prepared, as eve recorded them, one per line.
prepared_providers() {
  node -e '
    const { entries } = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    console.log([...new Set((entries ?? []).map(entry => entry.providerName))].join("\n"))
  ' "$WEB/agents/$1/.output/.eve/compile/sandbox-prepared-artifacts.json"
}

# The values of withEve's `agents` map: './agents/<name>'.
agents() {
  grep -oE "'\./agents/[a-z][a-z-]*'" "$WEB/next.config.mjs" | sed -E "s#'\./agents/(.*)'#\1#"
}

names="$(agents)"
[ -n "$names" ] || {
  echo "build-agents: found no './agents/<name>' entries in web/next.config.mjs" >&2
  exit 1
}

case "${1:-}" in
  --list)
    printf '%s\n' "$names"
    exit 0
    ;;
  --state-dirs)
    # Workflow runs, and the sandbox's per-session files. Everything else under
    # .eve is written by the build and belongs to the image.
    for name in $names; do
      printf '%s\n' \
        "$WEB/agents/$name/.eve/.workflow-data" \
        "$WEB/agents/$name/.eve/sandbox-cache/$SANDBOX_PROVIDER/sessions"
    done
    exit 0
    ;;
  --sandbox-provider | --check-sandbox)
    name="${2:-}"
    printf '%s\n' "$names" | grep -qx -- "$name" || {
      echo "build-agents: no agent named '$name'" >&2
      exit 64
    }
    want="$(sandbox_provider "$name")" || exit 1
    if [ "$1" = --sandbox-provider ]; then
      echo "$want"
      exit 0
    fi
    # A build and a start that disagree would start healthy and fail at the
    # agent's first sandbox ("belongs to provider ..."): refuse here instead.
    built="$(prepared_providers "$name")" || {
      echo "build-agents: cannot read the sandbox $name was built with" >&2
      exit 1
    }
    [ "$built" = "$want" ] && exit 0
    if [ "$want" = "$HOSTED_PROVIDER" ]; then
      echo "build-agents: $name was built with the $built sandbox, but $CREDENTIALS are set here, which call for the hosted sandbox service. Build the image again with them (sudo ./deploy.sh), or empty all three." >&2
    else
      echo "build-agents: $name was built with the $built sandbox, which needs $CREDENTIALS, and they are not set here. Set all three, or build the image again without them (sudo ./deploy.sh)." >&2
    fi
    exit 1
    ;;
  '') ;;
  *)
    echo "usage: build-agents.sh [--list | --state-dirs | --sandbox-provider <name> | --check-sandbox <name>]" >&2
    exit 64
    ;;
esac

# Every folder with an agent.ts must be mounted, and every mount must have one:
# an agent added to one place and not the other fails here, not in production.
for dir in "$WEB"/agents/*/; do
  name="$(basename "$dir")"
  [ -f "$dir/agent.ts" ] || continue
  printf '%s\n' "$names" | grep -qx -- "$name" || {
    echo "build-agents: agents/$name has an agent.ts but web/next.config.mjs does not mount it" >&2
    exit 1
  }
done

for name in $names; do
  dir="$WEB/agents/$name"
  [ -f "$dir/agent.ts" ] || {
    echo "build-agents: web/next.config.mjs mounts '$name' but agents/$name/agent.ts is missing" >&2
    exit 1
  }
  expected="$(sandbox_provider "$name")"
  # deploy.sh says which sandbox it meant the coding agent to get (compose.yaml,
  # NI_CODING_AGENT_SANDBOX: "vercel/<team id>/<project id>" when .env has the
  # access token). If the secrets did not arrive, or name another team or project,
  # stop here rather than build the wrong one.
  if [ "$name" = coding-agent ] && [ -n "${NI_CODING_AGENT_SANDBOX:-}" ]; then
    given="$expected"
    if [ "$expected" = "$HOSTED_PROVIDER" ]; then
      given="$HOSTED_PROVIDER/$(trimmed "$SANDBOX_TEAM_ID")/$(trimmed "$SANDBOX_PROJECT_ID")"
    fi
    if [ "$(trimmed "$NI_CODING_AGENT_SANDBOX")" != "$given" ]; then
      echo "build-agents: the build was meant to give coding-agent the $NI_CODING_AGENT_SANDBOX sandbox, but the secrets it was given call for $given. Did $CREDENTIALS reach the build as secrets (compose.yaml, deploy.sh)?" >&2
      exit 1
    fi
  fi
  # Only the coding agent's build sees the hosted sandbox's credentials.
  keep=""
  [ "$expected" = "$HOSTED_PROVIDER" ] && keep=1
  echo "== eve build: $name (sandbox: $expected)"
  started="$(date +%s)"
  # No VERCEL and no VERCEL_ENV: with either, eve writes Vercel Build Output and
  # prepares a Vercel Sandbox. EVE_PUBLIC_ROUTE_PREFIX is the agent's public mount,
  # as withEve sets it for the Vercel services.
  (
    cd "$dir"
    [ -n "$keep" ] || unset SANDBOX_ACCESS_TOKEN SANDBOX_TEAM_ID SANDBOX_PROJECT_ID
    env -u VERCEL -u VERCEL_ENV EVE_PUBLIC_ROUTE_PREFIX="/eve/$name" \
      node "$WEB/node_modules/eve/bin/eve.js" build > /tmp/eve-build.log 2>&1
  ) || {
    redacted /tmp/eve-build.log >&2
    echo "build-agents: eve build failed for $name" >&2
    exit 1
  }
  # The log is one line per output file; the last lines say what was built.
  redacted /tmp/eve-build.log | tail -n 3

  [ -f "$dir/.output/server/index.mjs" ] || {
    echo "build-agents: $name has no .output/server/index.mjs after eve build" >&2
    exit 1
  }
  # The build records the sandbox provider it prepared; the running agent uses that
  # record and never prepares one itself. Any provider but the expected one would
  # start here and then fail on the first sandbox use. A local provider's template
  # is a folder here; the hosted one's is a snapshot id there.
  node -e '
    const [file, cache, expected, name, hosted] = process.argv.slice(1)
    const { entries } = JSON.parse(require("node:fs").readFileSync(file, "utf8"))
    if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${name}: no prepared sandbox in ${file}`)
    for (const entry of entries) {
      if (entry.providerName !== expected) {
        throw new Error(`${name}: sandbox "${entry.nodeId}" was prepared with ${entry.providerName}, expected ${expected}`)
      }
      if (expected === hosted) {
        if (typeof entry.artifact?.snapshotId !== "string" || entry.artifact.snapshotId === "") throw new Error(`${name}: sandbox "${entry.nodeId}" has no snapshot`)
        continue
      }
      const template = `${cache}/${expected}/templates/${entry.artifact?.templateKey}`
      if (!require("node:fs").existsSync(template)) throw new Error(`${name}: sandbox template ${template} is missing`)
    }
    console.log(`   sandbox: ${entries.map(entry => `${entry.nodeId}=${entry.providerName}`).join(", ")}`)
  ' "$dir/.output/.eve/compile/sandbox-prepared-artifacts.json" "$dir/.eve/sandbox-cache" "$expected" "$name" "$HOSTED_PROVIDER"

  # The access token logs the app in to the hosted sandbox service; it must be in
  # nothing this build leaves in the image. (Only the token is a secret: the ids
  # are not.) grep's own exit status 2 (an error) fails the build too.
  if [ -n "$keep" ]; then
    token="$(trimmed "$SANDBOX_ACCESS_TOKEN")"
    status=0
    # The whole app, the build's scratch space and $HOME, where a tool could have
    # cached something. The dependencies' folders are searched too: the framework
    # keeps a build cache in one (node_modules/.cache), each agent's output has its
    # own, and all of them go into the image. A few seconds in a ten-minute build.
    grep -rqF -D skip -e "$token" "$WEB" /tmp "${HOME:-/root}" || status=$?
    [ "$status" = 1 ] || {
      echo "build-agents: SANDBOX_ACCESS_TOKEN turned up in a file after $name's build (or grep failed): refusing to put it in the image" >&2
      exit 1
    }
  fi

  # The build's scratch folders, left empty.
  rm -rf "$dir/.eve/builds" "$dir/.eve/locks"
  echo "   built in $(($(date +%s) - started))s: $(du -sh "$dir/.output" | cut -f1) .output, $(du -sh "$dir/.eve" | cut -f1) .eve"
done
rm -f /tmp/eve-build.log

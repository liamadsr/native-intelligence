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
#
# Or, the third way (built, not switched on): given SANDBOX_RUNTIME_API_URL and
# SANDBOX_RUNTIME_TRAFFIC_URL, its sandbox runs on our own runtime on the sandbox
# server (provider ni-runtime, web/agents/coding-agent/lib/runtime-sandbox.ts).
# Its build calls nothing there: it records the template's name
# (SANDBOX_RUNTIME_TEMPLATE, default ni-coding-agent), so the two addresses and the
# template are plain build arguments, and the runtime's key (SANDBOX_RUNTIME_KEY)
# is needed only when the agent runs, never here. The own runtime takes precedence:
# with both sets present the coding agent is built for it, and its build runs
# without the hosted three, which stay for the cloud browser (it reads the same
# names) until that moves too.
set -eu

HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
WEB="$(CDPATH= cd -- "$HERE/../../web" && pwd)"
# The sandbox provider a plain container can run: no Docker daemon, no /dev/kvm.
SANDBOX_PROVIDER="${NI_SANDBOX_PROVIDER:-just-bash}"
# The hosted sandbox service, as eve names its provider.
HOSTED_PROVIDER=vercel
CREDENTIALS="SANDBOX_ACCESS_TOKEN SANDBOX_TEAM_ID SANDBOX_PROJECT_ID"
# Our own runtime on the sandbox server, as the coding agent names its provider.
RUNTIME_PROVIDER=ni-runtime
RUNTIME_URLS="SANDBOX_RUNTIME_API_URL SANDBOX_RUNTIME_TRAFFIC_URL"
DEFAULT_RUNTIME_TEMPLATE=ni-coding-agent

# Which of the variables named in $1 are set (blank counts as unset): prints
# "none", "all", or "some:<the missing ones>".
which_set() {
  set_names="" missing=""
  for var in $1; do
    eval "value=\${$var:-}"
    case "$value" in
      *[![:space:]]*) set_names="$set_names $var" ;;
      *) missing="$missing $var" ;;
    esac
  done
  if [ -z "$set_names" ]; then
    echo none
  elif [ -z "$missing" ]; then
    echo all
  else
    echo "some:$missing"
  fi
}

# The sandbox <name> must be built with: for the coding agent, our own runtime when
# both of its addresses are set (whatever the hosted three say: those are then the
# cloud browser's alone), else the hosted one when all three of its settings are,
# else just-bash; an error (exit 1) when only one address is, or, without the own
# runtime, only some of the three, as the agent itself refuses them. Blank counts
# as unset.
sandbox_provider() {
  if [ "$1" != coding-agent ]; then
    echo "$SANDBOX_PROVIDER"
    return 0
  fi
  runtime="$(which_set "$RUNTIME_URLS")"
  case "$runtime" in
    all)
      echo "$RUNTIME_PROVIDER"
      return 0
      ;;
    some:*)
      echo "build-agents: the coding agent's own runtime needs both of $RUNTIME_URLS, or neither; missing:${runtime#some:}" >&2
      return 1
      ;;
  esac
  hosted="$(which_set "$CREDENTIALS")"
  case "$hosted" in
    all) echo "$HOSTED_PROVIDER" ;;
    none) echo "$SANDBOX_PROVIDER" ;;
    *)
      echo "build-agents: the coding agent's sandbox needs all three of $CREDENTIALS, or none; missing:${hosted#some:}" >&2
      return 1
      ;;
  esac
}

# The template the own runtime's sandboxes start from, as the agent reads it.
runtime_template() {
  template="$(trimmed "${SANDBOX_RUNTIME_TEMPLATE:-}")"
  echo "${template:-$DEFAULT_RUNTIME_TEMPLATE}"
}

# A value without its spaces and line breaks (the agent trims the settings too).
trimmed() {
  printf '%s' "$1" | tr -d '[:space:]'
}

# A build log, with the access token and the runtime's key (if this environment
# has them) cut out.
redacted() {
  NI_REDACT="$(printf '%s' "${SANDBOX_ACCESS_TOKEN:-}" | tr -d '[:space:]')" \
  NI_REDACT_KEY="$(printf '%s' "${SANDBOX_RUNTIME_KEY:-}" | tr -d '[:space:]')" awk '
    function cut(t) { if (t != "") while ((i = index($0, t)) > 0) $0 = substr($0, 1, i - 1) "[redacted]" substr($0, i + length(t)) }
    { cut(ENVIRON["NI_REDACT"]); cut(ENVIRON["NI_REDACT_KEY"]); print }
  ' "$1"
}

# Stops the build when a secret's value turns up in a file it wrote:
# refuse_if_found <name> <value>. The whole app, the build's scratch space and
# $HOME, where a tool could have cached something. The dependencies' folders are
# searched too: the framework keeps a build cache in one (node_modules/.cache), each
# agent's output has its own, and all of them go into the image. A few seconds in a
# ten-minute build. grep's own exit status 2 (an error) fails the build too.
refuse_if_found() {
  status=0
  grep -rqF -D skip -e "$2" "$WEB" /tmp "${HOME:-/root}" || status=$?
  [ "$status" = 1 ] || {
    echo "build-agents: $1 turned up in a file after the build (or grep failed): refusing to put it in the image" >&2
    exit 1
  }
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
    # .eve is written by the build and belongs to the image. The just-bash sessions
    # folder is listed for every agent, the coding agent included whatever its
    # sandbox: the hosted service and our own runtime keep a session's files on
    # their side and leave it empty, but compose.yaml's volume is mounted there
    # all the same, and a new volume takes its owner from this folder. So a switch
    # back to just-bash finds it already writable by the app's user.
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
    elif [ "$want" = "$RUNTIME_PROVIDER" ]; then
      echo "build-agents: $name was built with the $built sandbox, but $RUNTIME_URLS are set here, which call for our own runtime. Build the image again with them (sudo ./deploy.sh), or empty both." >&2
    elif [ "$built" = "$RUNTIME_PROVIDER" ]; then
      echo "build-agents: $name was built with the $built sandbox, which needs $RUNTIME_URLS, and they are not set here. Set both, or build the image again without them (sudo ./deploy.sh)." >&2
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
  # deploy.sh says which sandbox it meant the coding agent to get (compose.yaml):
  # NI_CODING_AGENT_RUNTIME, "runtime/<template>" when .env has the own runtime's
  # API address, and that wins; else NI_CODING_AGENT_SANDBOX, "vercel/<team
  # id>/<project id>" when .env has the access token. (Two arguments, because
  # Compose's substitution has no "else": with both sets in .env the second still
  # names the hosted ids, for the cloud browser's sake, and is not what is meant.)
  # If the secrets or arguments did not arrive, or name another team, project or
  # template, stop here rather than build the wrong one.
  meant="$(trimmed "${NI_CODING_AGENT_RUNTIME:-}")"
  [ -n "$meant" ] || meant="$(trimmed "${NI_CODING_AGENT_SANDBOX:-}")"
  if [ "$name" = coding-agent ] && [ -n "$meant" ]; then
    given="$expected"
    if [ "$expected" = "$HOSTED_PROVIDER" ]; then
      given="$HOSTED_PROVIDER/$(trimmed "$SANDBOX_TEAM_ID")/$(trimmed "$SANDBOX_PROJECT_ID")"
    elif [ "$expected" = "$RUNTIME_PROVIDER" ]; then
      given="runtime/$(runtime_template)"
    fi
    if [ "$meant" != "$given" ]; then
      echo "build-agents: the build was meant to give coding-agent the $meant sandbox, but the settings it was given call for $given. Did $CREDENTIALS reach the build as secrets, or $RUNTIME_URLS and SANDBOX_RUNTIME_TEMPLATE as arguments (compose.yaml, deploy.sh)?" >&2
      exit 1
    fi
  fi
  # Only the coding agent's build sees the hosted sandbox's credentials, or the
  # own runtime's addresses and template, whichever it is built with. Built for
  # the own runtime it never sees the hosted three, even when they are here (for
  # the cloud browser): it can never prepare a snapshot at the hosted service.
  keep="" keep_runtime=""
  [ "$expected" = "$HOSTED_PROVIDER" ] && keep=1
  [ "$expected" = "$RUNTIME_PROVIDER" ] && keep_runtime=1
  echo "== eve build: $name (sandbox: $expected)"
  started="$(date +%s)"
  # No VERCEL and no VERCEL_ENV: with either, eve writes Vercel Build Output and
  # prepares a Vercel Sandbox. EVE_PUBLIC_ROUTE_PREFIX is the agent's public mount,
  # as withEve sets it for the Vercel services. The runtime's key is never given to
  # a build: none needs it.
  (
    cd "$dir"
    [ -n "$keep" ] || unset SANDBOX_ACCESS_TOKEN SANDBOX_TEAM_ID SANDBOX_PROJECT_ID
    [ -n "$keep_runtime" ] || unset SANDBOX_RUNTIME_API_URL SANDBOX_RUNTIME_TRAFFIC_URL SANDBOX_RUNTIME_TEMPLATE
    unset SANDBOX_RUNTIME_KEY
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
  # is a folder here; the hosted one's is a snapshot id there; our own runtime's is
  # the name of a template the sandbox server built.
  node -e '
    const [file, cache, expected, name, hosted, runtime] = process.argv.slice(1)
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
      if (expected === runtime) {
        if (typeof entry.artifact?.template !== "string" || entry.artifact.template === "") throw new Error(`${name}: sandbox "${entry.nodeId}" names no template`)
        continue
      }
      const template = `${cache}/${expected}/templates/${entry.artifact?.templateKey}`
      if (!require("node:fs").existsSync(template)) throw new Error(`${name}: sandbox template ${template} is missing`)
    }
    console.log(`   sandbox: ${entries.map(entry => `${entry.nodeId}=${entry.providerName}`).join(", ")}`)
  ' "$dir/.output/.eve/compile/sandbox-prepared-artifacts.json" "$dir/.eve/sandbox-cache" "$expected" "$name" "$HOSTED_PROVIDER" "$RUNTIME_PROVIDER"

  # The access token logs the app in to the hosted sandbox service; it must be in
  # nothing this build leaves in the image. (Only the token is a secret: the ids
  # are not.) Looked for after the coding agent's build whenever it is in this
  # environment, also when that build was for the own runtime and never saw it.
  hosted_token="$(trimmed "${SANDBOX_ACCESS_TOKEN:-}")"
  if [ -n "$keep" ] || { [ "$name" = coding-agent ] && [ -n "$hosted_token" ]; }; then
    refuse_if_found SANDBOX_ACCESS_TOKEN "$hosted_token"
  fi
  # The runtime's key should not be in a build's environment at all (none needs
  # it, and no build is given it above); if it is, it must be in nothing either.
  runtime_key="$(trimmed "${SANDBOX_RUNTIME_KEY:-}")"
  if [ -n "$runtime_key" ]; then
    refuse_if_found SANDBOX_RUNTIME_KEY "$runtime_key"
  fi

  # The build's scratch folders, left empty.
  rm -rf "$dir/.eve/builds" "$dir/.eve/locks"
  echo "   built in $(($(date +%s) - started))s: $(du -sh "$dir/.output" | cut -f1) .output, $(du -sh "$dir/.eve" | cut -f1) .eve"
done
rm -f /tmp/eve-build.log

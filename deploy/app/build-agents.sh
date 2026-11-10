#!/bin/sh
# Builds the eve agents for the image, and answers two questions about them.
#
#   build-agents.sh               build every agent (the Dockerfile runs this)
#   build-agents.sh --list        the agents' names, one per line
#   build-agents.sh --state-dirs  each agent's folders that hold state while it runs
#
# The image keeps the repository's layout (/app/web, /app/deploy/app), so the paths
# below are the same in a checkout.
#
# The agents are the ones web/next.config.mjs mounts with withEve. Off Vercel each
# needs its own `eve build`, run from its folder (eve's self-hosting guide,
# "Run workspace members"): that writes a Node server to agents/<name>/.output and a
# sandbox template to agents/<name>/.eve/sandbox-cache.
set -eu

HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
WEB="$(CDPATH= cd -- "$HERE/../../web" && pwd)"
# The sandbox provider a plain container can run: no Docker daemon, no /dev/kvm.
SANDBOX_PROVIDER="${NI_SANDBOX_PROVIDER:-just-bash}"

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
  '') ;;
  *)
    echo "usage: build-agents.sh [--list | --state-dirs]" >&2
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
  echo "== eve build: $name"
  started="$(date +%s)"
  # No VERCEL and no VERCEL_ENV: with either, eve writes Vercel Build Output and
  # prepares a Vercel Sandbox. EVE_PUBLIC_ROUTE_PREFIX is the agent's public mount,
  # as withEve sets it for the Vercel services.
  (
    cd "$dir"
    env -u VERCEL -u VERCEL_ENV EVE_PUBLIC_ROUTE_PREFIX="/eve/$name" \
      node "$WEB/node_modules/eve/bin/eve.js" build > /tmp/eve-build.log 2>&1
  ) || {
    cat /tmp/eve-build.log >&2
    echo "build-agents: eve build failed for $name" >&2
    exit 1
  }
  # The log is one line per output file; the last lines say what was built.
  tail -n 3 /tmp/eve-build.log

  [ -f "$dir/.output/server/index.mjs" ] || {
    echo "build-agents: $name has no .output/server/index.mjs after eve build" >&2
    exit 1
  }
  # The build records the sandbox provider it prepared; the running agent uses that
  # record and never prepares one itself. Any provider but the expected one would
  # start here and then fail on the first sandbox use.
  node -e '
    const [file, cache, expected, name] = process.argv.slice(1)
    const { entries } = JSON.parse(require("node:fs").readFileSync(file, "utf8"))
    if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${name}: no prepared sandbox in ${file}`)
    for (const entry of entries) {
      if (entry.providerName !== expected) {
        throw new Error(`${name}: sandbox "${entry.nodeId}" was prepared with ${entry.providerName}, expected ${expected}`)
      }
      const template = `${cache}/${expected}/templates/${entry.artifact?.templateKey}`
      if (!require("node:fs").existsSync(template)) throw new Error(`${name}: sandbox template ${template} is missing`)
    }
    console.log(`   sandbox: ${entries.map(entry => `${entry.nodeId}=${entry.providerName}`).join(", ")}`)
  ' "$dir/.output/.eve/compile/sandbox-prepared-artifacts.json" "$dir/.eve/sandbox-cache" "$SANDBOX_PROVIDER" "$name"

  # The build's scratch folders, left empty.
  rm -rf "$dir/.eve/builds" "$dir/.eve/locks"
  echo "   built in $(($(date +%s) - started))s: $(du -sh "$dir/.output" | cut -f1) .output, $(du -sh "$dir/.eve" | cut -f1) .eve"
done
rm -f /tmp/eve-build.log

#!/usr/bin/env bash
# The Mac body (contract C2, docs/plans/teammate-agent.md): the one Native Intelligence agent,
# agents/chat-agent, built for the person's Mac. Sourced by build.sh (dev) and
# bundle.sh (the desktop's bundle); not run on its own.
#
#   stage_mac_body <repo> <stage>   copy what the build needs into <stage>
#   build_mac_body <repo> <stage> [eve build args]   → <stage>/agents/chat-agent/.output
#
# The copy is agents/chat-agent as it is, with the differences eve can only
# express as files, all decided here and nowhere else:
#   - LEFT OUT, cloud only:
#       - the quick helpers (tools/helpers.ts and the helper subagents under
#         subagents/): they run in the cloud body alone (C1's spec sends
#         helpersAllowed: false), and their sandbox templates would make the
#         build prepare eve's default provider on this machine;
#       - the usage meter (hooks/usage-meter.ts): the model relay meters the
#         Mac body's calls one by one, so a turn report would bill them twice,
#         and the meter's outbox writes the database directly.
#   - REPLACED:
#       - channels/eve.ts by the Mac host's channel
#         (agents/local-agent/channels/eve.ts: the launcher's per-launch
#         secret). The cloud's is the person's Supabase session and its ACL,
#         which must not ship to a Mac, and with the meter gone nothing in the
#         bundle carries a Supabase client;
#       - lib/mac-slots.ts, a stub that throws, by re-exports of the Mac host's
#         code (the model and its window, the token reader, the mode text). It is the chat
#         agent's only door into agents/local-agent, so none of that code (a
#         local model's provider included) reaches the cloud bundle.
#   - ADDED, the Mac host's own slots: sandbox.ts (the host-folder fence),
#     tools/finish.ts, tools/request_folder_access.ts and tools/studio_product.ts
#     (the Studio's product jobs; its runner is built apart, build_studio). The cloud build never
#     has them: eve has no "absent" export, and any authored sandbox.ts or tool
#     file changes the cloud's compiled manifest.
# Each swap or addition is a re-export written here, so the source stays
# where it is. Dot files (.DS_Store, editor files) never enter the copy. Everything else that differs between the bodies is a
# switch inside the shared files on NI_AGENT_HOST
# (agents/chat-agent/lib/host.ts), set here for `eve build` and again by the
# launcher for the running server.
#
# agents/local-agent comes along whole (minus tests): the chat agent imports
# its lib/ (model, auth, fence, mode text), its tools import
# launcher/prompts.ts, and the worker adapters (workers/, F-web's) are built
# from the copy too (build_workers). eve's build of the chat agent never
# sees agents/local-agent's own folders.
#
#   build_workers <stage> <out-dir>   the adapters into <out-dir>/workers/, when there are any

stage_mac_body() {
  local repo="$1" stage="$2"
  mkdir -p "$stage/agents/chat-agent" "$stage/agents/local-agent"
  rsync -a --exclude '.*' --exclude node_modules --exclude __tests__ \
    --exclude /subagents --exclude /tools/helpers.ts --exclude /hooks/usage-meter.ts \
    "$repo/agents/chat-agent/" "$stage/agents/chat-agent/"
  rsync -a --exclude '.*' --exclude node_modules --exclude __tests__ \
    "$repo/agents/local-agent/" "$stage/agents/local-agent/"
  local header='// Written by scripts/local-agent/mac-body.sh for the Mac body only (contract C2).'
  {
    printf '%s\n' "$header"
    printf '%s\n' "export { createLocalAgentModel, localAgentContextWindow, localAgentPlanStep, readModelToken, relayBaseUrl, resolveLocalAgentContextWindow } from '../../local-agent/lib/model.js'"
    printf '%s\n' "export { modeInstructions } from '../../local-agent/lib/mode-instructions.js'"
  } >"$stage/agents/chat-agent/lib/mac-slots.ts"
  printf '%s\nexport { default, environment } from %s\n' "$header" "'../local-agent/sandbox.js'" \
    >"$stage/agents/chat-agent/sandbox.ts"
  printf '%s\nexport { default } from %s\n' "$header" "'../../local-agent/channels/eve.js'" \
    >"$stage/agents/chat-agent/channels/eve.ts"
  local tool
  for tool in finish request_folder_access studio_product; do
    printf '%s\nexport { default } from %s\n' "$header" "'../../local-agent/tools/$tool.js'" \
      >"$stage/agents/chat-agent/tools/$tool.ts"
  done
  ln -s "$repo/node_modules" "$stage/node_modules"
  cp "$repo/package.json" "$stage/package.json"
}

# VERCEL is cleared so eve builds the Node server, not a Vercel deployment (and
# picks providers as on a laptop).
build_mac_body() {
  local repo="$1" stage="$2"
  shift 2
  (cd "$stage/agents/chat-agent" && NI_AGENT_HOST=mac VERCEL= "$repo/node_modules/.bin/eve" build "$@" >"$stage/eve-build.log" 2>&1) || {
    tail -40 "$stage/eve-build.log" >&2
    return 1
  }
  test -f "$stage/agents/chat-agent/.output/server/index.mjs"
  # The slot stubs must not ship: their error names this script.
  if grep -rq 'runs in the Mac body only' "$stage/agents/chat-agent/.output"; then
    echo "the Mac build still holds lib/mac-slots.ts's stubs" >&2
    return 1
  fi
  # The host marker the launcher checks before it starts the server: this is
  # the Mac body, and it can run a model on the Mac (lib/model.ts's local
  # route, F-web's L4). A bundle built from a tree before that route says
  # false, and the launcher refuses a local-model launch on it.
  printf '{"host":"mac","localModel":true}\n' >"$stage/agents/chat-agent/.output/dial8-host.json"
}

# The worker adapters (L4, F-web's agents/local-agent/workers/build.sh), run
# from the copy so the module comments name `node_modules/…`. Writes
# <out-dir>/workers/<worker>.mjs; nothing when the folder isn't there.
build_workers() {
  local stage="$1" out="$2"
  [ -x "$stage/agents/local-agent/workers/build.sh" ] || return 0
  (cd "$stage" && agents/local-agent/workers/build.sh "$out") >"$stage/workers-build.log" 2>&1 || {
    tail -40 "$stage/workers-build.log" >&2
    return 1
  }
}

# The Studio's product-component runner (agents/local-agent/studio/build.sh),
# built from the copy into <out-dir>: studio.tgz, which tools/studio_product.ts
# unpacks into a job's scratch dir and runs inside the job's fence. It finds the
# archive at .output/studio/studio.tgz beside the server.
build_studio() {
  local stage="$1" out="$2"
  [ -x "$stage/agents/local-agent/studio/build.sh" ] || return 0
  (cd "$stage" && agents/local-agent/studio/build.sh "$out") >"$stage/studio-build.log" 2>&1 || {
    tail -40 "$stage/studio-build.log" >&2
    return 1
  }
  test -f "$out/studio.tgz"
}

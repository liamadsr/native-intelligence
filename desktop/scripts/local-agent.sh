# Local agent bundle helpers — sourced by dev.sh, build.sh and release.sh.
#
# The local agent (dial8-website agents/local-agent; its docs/plans/
# local-agents.md, "Packaging") ships as JavaScript inside the signed app:
#
#   src-tauri/resources/local-agent/        vendored by scripts/local-agent-bundle.sh
#     → Dial8.app/Contents/Resources/local-agent/   (local_agent_stage)
#
# so the app's signature pins the code that runs on the Mac. Its Node is not
# in the app: Rust downloads it on first use, pinned in
# src-tauri/src/local_agent/runtime.json. Its third-party notices reach
# Contents/Resources/Licenses/ through licenses_stage, like every
# src-tauri/resources/<name>/licenses/.
#
# Requires TAURI_DIR to be set by the caller. bash 3.2 compatible.

LOCAL_AGENT_SRC="$TAURI_DIR/resources/local-agent"

# Copy the vendored bundle into an app bundle, replacing whatever an earlier
# run staged (a reused dev bundle must not keep files a newer bundle dropped).
# Callers run it after sidecars_stage and BEFORE licenses_stage and signing.
# $1 = path to Dial8.app.
local_agent_stage() {
    local app="$1"
    local dest="$app/Contents/Resources/local-agent"
    if [ ! -d "$app/Contents/MacOS" ]; then
        echo "[local-agent] ERROR: $app is not an app bundle" >&2
        return 1
    fi
    rm -rf "$dest"
    if [ ! -f "$LOCAL_AGENT_SRC/BUNDLE.json" ]; then
        echo "[local-agent] ERROR: no vendored bundle at $LOCAL_AGENT_SRC (run scripts/local-agent-bundle.sh)" >&2
        return 1
    fi
    mkdir -p "$app/Contents/Resources" || return 1
    cp -R "$LOCAL_AGENT_SRC" "$dest"
}

# Check a staged bundle against its BUNDLE.json: every file it lists is there
# with that SHA-256, nothing else is, and it was built from committed web
# source (webDirty false). Prints the web commit it came from.
# $1 = path to Dial8.app.
local_agent_verify() {
    local dest="$1/Contents/Resources/local-agent"
    /usr/bin/python3 - "$dest" <<'PY'
import hashlib, json, os, sys
root = sys.argv[1]
try:
    bundle = json.load(open(os.path.join(root, "BUNDLE.json")))
except Exception as e:
    sys.exit(f"[local-agent] ERROR: no readable BUNDLE.json in {root}: {e}")
want = bundle.get("files") or {}
have = set()
for d, _, files in os.walk(root):
    for f in files:
        rel = os.path.relpath(os.path.join(d, f), root)
        if rel != "BUNDLE.json":
            have.add(rel)
problems = []
for rel in sorted(set(want) - have):
    problems.append(f"missing {rel}")
for rel in sorted(have - set(want)):
    problems.append(f"not in BUNDLE.json: {rel}")
for rel in sorted(set(want) & have):
    with open(os.path.join(root, rel), "rb") as fh:
        if hashlib.sha256(fh.read()).hexdigest() != want[rel]:
            problems.append(f"hash differs: {rel}")
for rel in ("launcher/launcher.mjs", "launcher/server-guard.ts", ".output/server/index.mjs", "licenses/NOTICES.txt"):
    if rel not in want:
        problems.append(f"bundle lacks {rel}")
if bundle.get("webDirty") is not False:
    problems.append("built from uncommitted web source (webDirty): rebuild from a clean checkout")
if problems:
    sys.exit("[local-agent] ERROR: the staged bundle is not what BUNDLE.json says:\n  " + "\n  ".join(problems[:20]))
print(f"web {bundle.get('webCommit')}, eve {bundle.get('eveVersion')}, {len(want)} files")
PY
}

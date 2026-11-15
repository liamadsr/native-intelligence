# Studio runner helpers, sourced by dev.sh, build.sh and release.sh (and the
# Windows workflow, in Git Bash).
#
# The Studio's computer export (src-tauri/src/studio_local/) runs the local
# runner studio-worker builds (studio-worker/scripts/build-local-runner.ts:
# runner/runner.cjs, the packages it keeps, a prebuilt render bundle,
# NOTICES.md; about 47 MB). It ships inside the signed app:
#
#   studio-runner_build    studio-worker → src-tauri/target/studio-runner/
#                          (NOT committed: it is built from this checkout at
#                          build time, unlike the local agent's 12 MB bundle),
#                          plus STUDIO_RUNNER.json (every file's SHA-256, the
#                          commit and whether the tree was dirty) and
#                          licenses/NOTICES.txt (folded into the app's
#                          notices by licenses.sh)
#   studio_runner_stage    → Native Intelligence.app/Contents/Resources/studio-runner/
#   studio_runner_verify   the staged copy against its STUDIO_RUNNER.json
#
# Node, Chrome's headless shell and FFmpeg are not in it: the app downloads
# them on first use, pinned (src-tauri/src/local_agent/runtime.json,
# src-tauri/src/studio_local/components.json).
#
# Building needs Node 24 and `npm ci` done in studio-worker/ and web/ (the
# build runs the render version's test in web/ first). On Windows the Tauri
# config maps target/studio-runner/ into the installer's resources instead
# of studio_runner_stage (.github/workflows/windows.yml).
#
# Requires TAURI_DIR to be set by the caller. bash 3.2 compatible.

STUDIO_RUNNER_OUT="${STUDIO_RUNNER_OUT:-$TAURI_DIR/target/studio-runner}"
STUDIO_WORKER_DIR="${STUDIO_WORKER_DIR:-$TAURI_DIR/../../studio-worker}"

# Build the runner into $STUDIO_RUNNER_OUT, from scratch. $1 = release
# (refuses uncommitted studio-worker or web/src/lib/studio sources) | dev.
studio_runner_build() {
    local mode="${1:-dev}"
    local worker
    worker="$(cd "$STUDIO_WORKER_DIR" 2>/dev/null && pwd)" || {
        echo "[studio-runner] ERROR: no studio-worker at $STUDIO_WORKER_DIR" >&2
        return 1
    }
    if [ ! -d "$worker/node_modules" ] || [ ! -d "$worker/../web/node_modules" ]; then
        echo "[studio-runner] ERROR: run npm ci in studio-worker/ and web/ first" >&2
        return 1
    fi
    local dirty=false
    if [ -n "$(git -C "$worker/.." status --porcelain -- studio-worker/src studio-worker/scripts studio-worker/package-lock.json web/src/lib/studio 2>/dev/null)" ]; then
        dirty=true
        if [ "$mode" = "release" ]; then
            echo "[studio-runner] ERROR: studio-worker or web/src/lib/studio has uncommitted changes; a release builds from committed source" >&2
            return 1
        fi
    fi
    rm -rf "$STUDIO_RUNNER_OUT"
    mkdir -p "$(dirname "$STUDIO_RUNNER_OUT")"
    (cd "$worker" && node --import tsx scripts/build-local-runner.ts "$STUDIO_RUNNER_OUT") || {
        echo "[studio-runner] ERROR: the runner build failed" >&2
        rm -rf "$STUDIO_RUNNER_OUT"
        return 1
    }
    mkdir -p "$STUDIO_RUNNER_OUT/licenses"
    cp "$STUDIO_RUNNER_OUT/NOTICES.md" "$STUDIO_RUNNER_OUT/licenses/NOTICES.txt" || return 1
    local commit
    commit="$(git -C "$worker" rev-parse HEAD 2>/dev/null || echo unknown)"
    python3 - "$STUDIO_RUNNER_OUT" "$commit" "$dirty" <<'PY'
import hashlib, json, os, sys
root, commit, dirty = sys.argv[1], sys.argv[2], sys.argv[3] == "true"
files = {}
for d, _, names in os.walk(root):
    for n in names:
        p = os.path.join(d, n)
        rel = os.path.relpath(p, root).replace(os.sep, "/")
        if rel == "STUDIO_RUNNER.json":
            continue
        if os.path.islink(p):
            sys.exit(f"[studio-runner] ERROR: {rel} is a symbolic link")
        with open(p, "rb") as fh:
            files[rel] = hashlib.sha256(fh.read()).hexdigest()
manifest = json.load(open(os.path.join(root, "render-bundle", "studio-render.json")))
json.dump({"commit": commit, "dirty": dirty, "renderVersion": manifest.get("renderVersion"), "files": files},
          open(os.path.join(root, "STUDIO_RUNNER.json"), "w"), indent=1, sort_keys=True)
print(f"[studio-runner] built: render version {manifest.get('renderVersion')}, {len(files)} files, commit {commit[:12]}{' (DIRTY)' if dirty else ''}")
PY
}

# Copy the built runner into an app bundle, replacing what an earlier run
# staged. Callers run it after local_agent_stage and BEFORE licenses_stage and
# signing. $1 = path to Native Intelligence.app.
studio_runner_stage() {
    local app="$1"
    local dest="$app/Contents/Resources/studio-runner"
    if [ ! -d "$app/Contents/MacOS" ]; then
        echo "[studio-runner] ERROR: $app is not an app bundle" >&2
        return 1
    fi
    rm -rf "$dest"
    if [ ! -f "$STUDIO_RUNNER_OUT/STUDIO_RUNNER.json" ]; then
        echo "[studio-runner] ERROR: no built runner at $STUDIO_RUNNER_OUT (studio_runner_build)" >&2
        return 1
    fi
    mkdir -p "$app/Contents/Resources" || return 1
    cp -R "$STUDIO_RUNNER_OUT" "$dest"
}

# Check a staged runner against its STUDIO_RUNNER.json: every file listed is
# there with that SHA-256, nothing else is, and (release) it was built from
# committed source. Prints the render version. $1 = the staged folder
# (…/Contents/Resources/studio-runner), $2 = release | dev.
studio_runner_verify() {
    python3 - "$1" "${2:-dev}" <<'PY'
import hashlib, json, os, sys
root, mode = sys.argv[1], sys.argv[2]
try:
    m = json.load(open(os.path.join(root, "STUDIO_RUNNER.json")))
except Exception as e:
    sys.exit(f"[studio-runner] ERROR: no readable STUDIO_RUNNER.json in {root}: {e}")
want, have = m.get("files") or {}, set()
for d, _, names in os.walk(root):
    for n in names:
        rel = os.path.relpath(os.path.join(d, n), root).replace(os.sep, "/")
        if rel != "STUDIO_RUNNER.json":
            have.add(rel)
problems = [f"missing {r}" for r in sorted(set(want) - have)] + [f"not in STUDIO_RUNNER.json: {r}" for r in sorted(have - set(want))]
for r in sorted(set(want) & have):
    with open(os.path.join(root, r), "rb") as fh:
        if hashlib.sha256(fh.read()).hexdigest() != want[r]:
            problems.append(f"hash differs: {r}")
for r in ("runner/runner.cjs", "render-bundle/studio-render.json", "licenses/NOTICES.txt"):
    if r not in want:
        problems.append(f"lacks {r}")
if mode == "release" and m.get("dirty") is not False:
    problems.append("built from uncommitted source: rebuild from a clean checkout")
if problems:
    sys.exit("[studio-runner] ERROR: the staged runner is not what STUDIO_RUNNER.json says:\n  " + "\n  ".join(problems[:20]))
print(f"render version {m.get('renderVersion')}, commit {str(m.get('commit'))[:12]}, {len(want)} files")
PY
}

#!/bin/bash
# The Windows half of release.sh (sourced by it). This Mac can't build for
# Windows, so the Windows workflow (.github/workflows/windows.yml) builds the
# NSIS installer on a GitHub runner while the Mac build runs; this dispatches
# it, waits for it, downloads the installer, checks it arrived whole, and signs
# it for the updater with the key that never leaves this Mac.
#
#   windows_preflight            gh is signed in; the tree is clean and pushed
#   windows_dispatch <version>   start the build of HEAD at <version>
#   windows_collect <out dir>    wait, download, verify, sign
#
# They set WINDOWS_RUN_ID, WINDOWS_EXE and WINDOWS_SIG, and return non-zero
# (after saying why) when the Windows build can't be part of this release.
# Uses release.sh's log/ok/warn/err.

WINDOWS_WORKFLOW="windows.yml"
WINDOWS_ARTIFACT="dial8-windows-x64"

# Whether the Windows workflow signs release builds, from the repository
# variable docs/WINDOWS_SIGNING.md's setup ends with: prints `configured`,
# `unset` (GitHub says there's no such variable) or `unknown` (no gh, not
# signed in, offline: can't tell), so a release says which.
windows_signing_state() {
    if ! command -v gh &>/dev/null; then
        echo unknown
        return
    fi
    local out err ok=0
    err=$(mktemp)
    # The exit status decides: on an error gh prints the error body to stdout.
    out=$(cd "$SCRIPT_DIR" && gh api 'repos/{owner}/{repo}/actions/variables/ARTIFACT_SIGNING_ACCOUNT' --jq .value 2>"$err") || ok=1
    if [ "$ok" -eq 0 ] && [ -n "$out" ]; then
        echo configured
    elif grep -q "HTTP 404" "$err"; then
        echo unset
    else
        echo unknown
    fi
    rm -f "$err"
}

# The files release.sh's --version edits (and the build's lockfile refresh):
# the runner sets the version itself, so a change to one of these that is
# only version lines doesn't make the tree dirty. Any other change does.
WINDOWS_VERSION_FILES=(src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock)

# Lines other than `version` ones changed in the version files (none: empty).
windows_non_version_changes() {
    git -C "$SCRIPT_DIR" diff -U0 HEAD -- "${WINDOWS_VERSION_FILES[@]}" \
        | grep -E '^[+-]' | grep -vE '^(\+\+\+|---) ' \
        | grep -vE '^[+-][[:space:]]*"?version"?[[:space:]]*[:=][[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+",?[[:space:]]*$' \
        || true
}

# The runner builds what GitHub has, so this Mac must have nothing else: a
# clean tree (but for version bumps, which the runner makes itself) whose HEAD
# is its branch's tip on origin.
windows_preflight() {
    if ! command -v gh &>/dev/null; then
        err "gh not found (brew install gh): the Windows build runs on GitHub."
        return 1
    fi
    if ! gh auth status &>/dev/null; then
        err "gh isn't signed in (gh auth login): the Windows build runs on GitHub."
        return 1
    fi
    local changed
    changed=$(git -C "$SCRIPT_DIR" status --porcelain --untracked-files=no -- . \
        ":(exclude)src-tauri/tauri.conf.json" ":(exclude)src-tauri/Cargo.toml" ":(exclude)src-tauri/Cargo.lock")
    if [ -n "$changed" ] || [ -n "$(windows_non_version_changes)" ]; then
        err "Uncommitted changes: the Windows runner builds only what is pushed."
        git -C "$SCRIPT_DIR" status --short --untracked-files=no | sed 's/^/    /'
        echo "  Commit and push them, or release macOS alone with --skip-windows."
        return 1
    fi
    WINDOWS_BRANCH=$(git -C "$SCRIPT_DIR" rev-parse --abbrev-ref HEAD)
    if [ "$WINDOWS_BRANCH" = "HEAD" ]; then
        err "Detached HEAD: the Windows build is dispatched on a branch."
        return 1
    fi
    git -C "$SCRIPT_DIR" fetch -q origin "$WINDOWS_BRANCH" || {
        err "Couldn't fetch origin/$WINDOWS_BRANCH."
        return 1
    }
    WINDOWS_SHA=$(git -C "$SCRIPT_DIR" rev-parse HEAD)
    if [ "$WINDOWS_SHA" != "$(git -C "$SCRIPT_DIR" rev-parse "origin/$WINDOWS_BRANCH")" ]; then
        err "HEAD isn't origin/$WINDOWS_BRANCH: push (or pull) first, so both builds are the same code."
        return 1
    fi
    return 0
}

# Dispatch the build of $WINDOWS_BRANCH at <version>, and find its run: the
# newest dispatched run of this commit created after the dispatch.
windows_dispatch() {
    local version="$1"
    # Two minutes early, so a Mac clock that runs fast still finds the run
    # (it must also be this commit, and dispatched).
    local since
    since=$(date -u -v-2M +"%Y-%m-%dT%H:%M:%SZ")
    gh workflow run "$WINDOWS_WORKFLOW" --ref "$WINDOWS_BRANCH" -f version="$version" >/dev/null || {
        err "Couldn't dispatch the Windows build ($WINDOWS_WORKFLOW must be on the default branch)."
        return 1
    }
    local tries=0
    WINDOWS_RUN_ID=""
    while [ -z "$WINDOWS_RUN_ID" ] && [ $tries -lt 24 ]; do
        sleep 5
        tries=$((tries + 1))
        WINDOWS_RUN_ID=$(gh run list --workflow "$WINDOWS_WORKFLOW" --event workflow_dispatch \
            --branch "$WINDOWS_BRANCH" --limit 10 --json databaseId,headSha,createdAt 2>/dev/null \
            | python3 -c '
import json, sys
sha, since = sys.argv[1], sys.argv[2]
runs = [r for r in json.load(sys.stdin) if r["headSha"] == sha and r["createdAt"] >= since]
runs.sort(key=lambda r: r["createdAt"], reverse=True)
print(runs[0]["databaseId"] if runs else "")
' "$WINDOWS_SHA" "$since")
    done
    if [ -z "$WINDOWS_RUN_ID" ]; then
        err "Dispatched the Windows build but couldn't find its run."
        return 1
    fi
    ok "Windows build started: $(gh run view "$WINDOWS_RUN_ID" --json url -q .url)"
}

# Wait for the run, download the installer, check its checksum, and sign it
# for the updater. Sets WINDOWS_EXE and WINDOWS_SIG.
windows_collect() {
    local out="$1/windows"
    log "Waiting for the Windows build (run $WINDOWS_RUN_ID)..."
    if ! gh run watch "$WINDOWS_RUN_ID" --exit-status --interval 30 >"$1/windows-run.log" 2>&1; then
        err "The Windows build failed: $(gh run view "$WINDOWS_RUN_ID" --json url -q .url)"
        return 1
    fi
    rm -rf "$out"
    mkdir -p "$out"
    gh run download "$WINDOWS_RUN_ID" -n "$WINDOWS_ARTIFACT" -D "$out" || {
        err "Couldn't download the Windows installer."
        return 1
    }
    (cd "$out" && shasum -a 256 -c SHA256SUMS >/dev/null) || {
        err "The Windows installer's checksum doesn't match: not publishing it."
        return 1
    }
    WINDOWS_EXE="$out/Dial8_${VERSION}_x64-setup.exe"
    WINDOWS_SIG="$WINDOWS_EXE.sig"
    if [ ! -f "$WINDOWS_EXE" ]; then
        err "The Windows build has no Dial8_${VERSION}_x64-setup.exe."
        return 1
    fi
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$UPDATER_KEY_PATH")" \
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
    cargo tauri signer sign "$WINDOWS_EXE" >/dev/null 2>&1
    if [ ! -s "$WINDOWS_SIG" ]; then
        err "Couldn't sign the Windows installer for the updater."
        return 1
    fi
    ok "Windows installer ready: $WINDOWS_EXE"
}

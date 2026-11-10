#!/bin/bash
# Development launcher for Native Intelligence Desktop
#
# Instead of `cargo tauri dev` (which runs a bare binary that can't handle
# deep links), this script:
# 1. Builds the Rust binary
# 2. Syncs it into the .app bundle
# 3. Launches the bundle so dial8desktop:// deep links work
#
# Usage:
#   ./dev.sh          # Build, sync, and launch
#   ./dev.sh --watch  # Also watch for Rust changes and hot-reload

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_DIR="$SCRIPT_DIR/src-tauri"
BINARY="$TAURI_DIR/target/debug/dial8-desktop"
BUNDLE_APP="$TAURI_DIR/target/debug/bundle/macos/Native Intelligence.app"
BUNDLE_BIN="$BUNDLE_APP/Contents/MacOS/dial8-desktop"

# Sidecar build/stage/sign helpers (every folder in src-tauri/sidecars/).
source "$SCRIPT_DIR/scripts/sidecars.sh"
# Third-party license notices (Contents/Resources/Licenses/).
source "$SCRIPT_DIR/scripts/licenses.sh"
# The local agent bundle (Contents/Resources/local-agent).
source "$SCRIPT_DIR/scripts/local-agent.sh"

# ─── Code signing (dev bundles) ──────────────────────────────────────────────
#
# Debug bundles MUST be signed with our Developer ID, not left ad-hoc, or they
# poison the production app's microphone permission. macOS TCC keys the mic grant
# by (bundle ID, csreq); an ad-hoc build's csreq is a per-build cdhash that
# overwrites the shared ai.dial8.desktop row, so the production app then fails the
# csreq match and macOS re-prompts. Signing with the same Developer ID gives the
# debug build the stable designated requirement the production app uses, so they
# share the grant. See docs/PERMISSIONS.md.
#
# The same Developer ID release.sh signs with (same cert, same csreq): named in
# .env.release, see scripts/signing.sh.
source "$SCRIPT_DIR/scripts/signing.sh"
signing_load "$SCRIPT_DIR"
# Dev entitlements: include get-task-allow so lldb/debugging still attaches.
DEV_ENTITLEMENTS="$TAURI_DIR/entitlements.plist"

# Sign the debug .app bundle with the Developer ID so its main executable carries
# the stable ai.dial8.desktop designated requirement instead of an ad-hoc cdhash.
# No --deep (we sign inner-to-outer by hand), no --options runtime (the hardened
# runtime blocks get-task-allow / debugging), --timestamp=none (no notary needed
# for local dev). Non-fatal if the identity is missing — dev must keep working.
sign_debug_bundle() {
    if [ -z "$SIGNING_IDENTITY" ] || ! security find-identity -v -p codesigning | grep -qF "$SIGNING_IDENTITY"; then
        echo "[dev] WARNING: Developer ID '$SIGNING_IDENTITY' not set (NI_SIGNING_IDENTITY in .env.release) or not in keychain."
        echo "[dev] This debug build stays AD-HOC SIGNED and WILL poison the"
        echo "[dev] production app's microphone permission (macOS re-prompts on"
        echo "[dev] the next production launch). See docs/PERMISSIONS.md. Continuing."
        return 0
    fi

    echo "[dev] Signing debug bundle with Developer ID (prevents TCC poisoning)..."
    # Innermost first: the staged sidecars (and their dylibs).
    sidecars_sign_dev "$BUNDLE_APP" "$SIGNING_IDENTITY" "$DEV_ENTITLEMENTS"
    # Then the bundle, which signs the main executable and stamps the DR.
    codesign --force --sign "$SIGNING_IDENTITY" --timestamp=none \
        --entitlements "$DEV_ENTITLEMENTS" "$BUNDLE_APP"
    echo "[dev] Debug bundle signed (ai.dial8.desktop Developer ID DR)."
}

build_and_sync() {
    # Build the sidecars — meeting detection, system audio, and local
    # calendar are all dead without system-audio-capture, and that failure is
    # silent.
    echo "[dev] Building sidecars..."
    sidecars_build debug

    # Regenerate the whole .app bundle each run instead of cp-ing the fresh
    # binary into the existing one.
    #
    # Why: once Native Intelligence has been granted TCC permissions (microphone, screen
    # recording), macOS marks the bundle with a com.apple.macl xattr and
    # protects its contents. Writing *any* file into Native Intelligence.app/Contents/MacOS/
    # from a shell without Full Disk Access then fails with "Operation not
    # permitted" — which silently aborted this script before it could launch.
    # The bundle *directory* itself is not locked, so we delete it wholesale
    # and let `cargo tauri build` produce a fresh, unprotected bundle.
    #
    # --bundles app:                 skip the dmg/nsis installers we don't need
    #                                for local dev (faster).
    # createUpdaterArtifacts=false:  the committed config turns this on, which
    #                                makes Tauri sign an updater .tar.gz and
    #                                fail with "no private key" unless
    #                                TAURI_SIGNING_PRIVATE_KEY is set (it's only
    #                                set in release CI). Override it off here so
    #                                local builds don't abort on signing.
    echo "[dev] Rebuilding .app bundle..."
    rm -rf "$BUNDLE_APP"
    # TODO(rename-compat): remove once no checkout still has a Dial8.app build.
    # The bundle was Dial8.app before the rename: drop that stale build and its
    # LaunchServices registration (same bundle id and dial8desktop:// scheme).
    OLD_BUNDLE_APP="$TAURI_DIR/target/debug/bundle/macos/Dial8.app"
    if [ -d "$OLD_BUNDLE_APP" ]; then
        /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$OLD_BUNDLE_APP" 2>/dev/null || true
        rm -rf "$OLD_BUNDLE_APP"
    fi
    cd "$SCRIPT_DIR"
    cargo tauri build --debug --bundles app \
        --config '{"bundle":{"createUpdaterArtifacts":false}}' 2>&1

    # Stage the sidecars next to the main binary so the bundled-first sidecar
    # resolution matches production. tauri.conf.json does not declare them as
    # externalBin, so the bundle won't contain them otherwise.
    sidecars_stage "$BUNDLE_APP"

    # The local agent's JS, where a release build has it (scripts/local-agent.sh).
    # Without it the app runs and local agents report this build has none.
    local_agent_stage "$BUNDLE_APP" \
        || echo "[dev] WARNING: local agent bundle not staged — local agents are unavailable in this build" >&2

    # License notices (Help → Open Source Licenses), before signing so the
    # signature seals them. A dev bundle runs fine without them — the menu
    # item is just disabled — so a failure only warns (dev mode: a sidecar
    # without notices is left out with a warning; release.sh stops instead).
    licenses_stage "$BUNDLE_APP" dev \
        || echo "[dev] WARNING: license notices not staged — Help → Open Source Licenses is disabled in this build" >&2

    # Sign with the Developer ID so the main executable gets the stable
    # ai.dial8.desktop designated requirement. cargo tauri build --debug leaves
    # the bundle ad-hoc signed, and staging the sidecar in changes bundle
    # contents — sign last, before launch, so the first mic prompt writes the
    # stable DR and doesn't poison the production TCC row.
    sign_debug_bundle
    echo "[dev] Fresh bundle built with binary + sidecars."
}

launch_app() {
    # Kill any existing instances
    pkill -f "\.app/Contents/MacOS/dial8-desktop" 2>/dev/null || true
    pkill -f "target/debug/dial8-desktop" 2>/dev/null || true
    sleep 0.3

    # Re-register URL scheme
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -R -f "$BUNDLE_APP" 2>/dev/null

    echo "[dev] Launching Native Intelligence.app..."
    open "$BUNDLE_APP"
}

# Initial build + launch
build_and_sync
launch_app

echo ""
echo "  Native Intelligence is running from the .app bundle."
echo "  Deep links (dial8desktop://) will work."
echo "  Webview → http://localhost:3000"
echo ""

if [ "$1" = "--watch" ]; then
    echo "[dev] Watching src/ for changes... (Ctrl+C to stop)"
    # Use fswatch if available, otherwise just wait
    if command -v fswatch &>/dev/null; then
        fswatch -o "$TAURI_DIR/src" | while read -r; do
            echo ""
            echo "[dev] Change detected, rebuilding..."
            # A failed rebuild must not end the watcher (set -e): the subshell
            # stops at its first error, and the loop keeps watching.
            set +e
            ( set -e; build_and_sync; launch_app )
            [ $? -eq 0 ] || echo "[dev] Rebuild failed — fix it and save again"
            set -e
        done
    else
        echo "[dev] Install fswatch for auto-reload: brew install fswatch"
        echo "[dev] For now, re-run ./dev.sh after code changes."
        wait
    fi
else
    echo "  Re-run ./dev.sh after Rust code changes to rebuild."
    echo "  Use ./dev.sh --watch for auto-reload (requires fswatch)."
fi

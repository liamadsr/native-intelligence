#!/bin/bash
# Native Intelligence Desktop Build Script
#
# Usage:
#   ./build.sh dev          # Incremental build, launch, and watch for changes
#   ./build.sh dev clean    # Clean cache first, then full build + launch + watch
#   ./build.sh prod         # Incremental release build
#   ./build.sh prod clean   # Clean cache first, then full release build

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_DIR="$SCRIPT_DIR/src-tauri"
TARGET_DIR="$TAURI_DIR/target"

# Sidecar build/stage/sign helpers (every folder in src-tauri/sidecars/).
source "$SCRIPT_DIR/scripts/sidecars.sh"
# Third-party license notices (Contents/Resources/Licenses/).
source "$SCRIPT_DIR/scripts/licenses.sh"
# The local agent bundle (Contents/Resources/local-agent).
source "$SCRIPT_DIR/scripts/local-agent.sh"
# The Studio's local runner (Contents/Resources/studio-runner), built from studio-worker.
source "$SCRIPT_DIR/scripts/studio-runner.sh"

MODE="${1:-dev}"
shift 2>/dev/null || true

# Parse flags
CLEAN=false
for arg in "$@"; do
    case "$arg" in
        clean) CLEAN=true ;;
    esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[build]${NC} $1"; }
ok()   { echo -e "${GREEN}[build]${NC} $1"; }
warn() { echo -e "${YELLOW}[build]${NC} $1"; }
err()  { echo -e "${RED}[build]${NC} $1"; }

# ─── Code signing (dev bundles) ──────────────────────────────────────────────
#
# Debug bundles MUST be signed with our Developer ID, not left ad-hoc.
#
# Why: macOS TCC keys the microphone grant by (bundle ID, csreq) where csreq is
# the code-signing requirement captured from whichever binary last prompted. An
# ad-hoc debug build's csreq is a per-build cdhash, so recording from a dev build
# overwrites the shared ai.dial8.desktop mic row with that cdhash. The production
# app (/Applications/Native Intelligence.app) then fails the csreq match on its next mic access
# and macOS re-prompts the user. Signing debug bundles with the SAME Developer ID
# gives them the stable designated requirement the production app uses, so they
# share the grant instead of poisoning it. See docs/PERMISSIONS.md.
#
# The same Developer ID release.sh signs with (same cert, same csreq): named in
# .env.release, see scripts/signing.sh.
source "$SCRIPT_DIR/scripts/signing.sh"
signing_load "$SCRIPT_DIR"
# Dev entitlements: include get-task-allow so lldb/debugging still attaches.
DEV_ENTITLEMENTS="$TAURI_DIR/entitlements.plist"

# Sign a debug .app bundle with the Developer ID so its main executable carries
# the stable ai.dial8.desktop designated requirement instead of an ad-hoc cdhash.
# No --deep (we sign inner-to-outer by hand), no --options runtime (the hardened
# runtime blocks get-task-allow / debugging), --timestamp=none (no notary needed
# for local dev). Non-fatal if the identity is missing — dev must keep working.
sign_debug_bundle() {
    local bundle_app="$1"

    if [ -z "$SIGNING_IDENTITY" ] || ! security find-identity -v -p codesigning | grep -qF "$SIGNING_IDENTITY"; then
        warn "Developer ID '$SIGNING_IDENTITY' not set (NI_SIGNING_IDENTITY in .env.release) or not in keychain."
        warn "This debug build will stay AD-HOC SIGNED and WILL poison the"
        warn "production app's microphone permission (macOS re-prompts after the"
        warn "next production launch). See docs/PERMISSIONS.md. Continuing anyway."
        return 0
    fi

    log "Signing debug bundle with Developer ID (prevents TCC poisoning)..."
    # Innermost first: the staged sidecars (and their dylibs).
    sidecars_sign_dev "$bundle_app" "$SIGNING_IDENTITY" "$DEV_ENTITLEMENTS"
    # Then the bundle, which signs the main executable and stamps the DR.
    codesign --force --sign "$SIGNING_IDENTITY" --timestamp=none \
        --entitlements "$DEV_ENTITLEMENTS" "$bundle_app"
    ok "Debug bundle signed (ai.dial8.desktop Developer ID DR)"
}

kill_existing() {
    log "Killing existing Native Intelligence instances..."
    pkill -f "\.app/Contents/MacOS/dial8-desktop" 2>/dev/null || true
    pkill -f "target/debug/dial8-desktop" 2>/dev/null || true
    pkill -f "target/release/dial8-desktop" 2>/dev/null || true
    sleep 0.3
}

clean_cache() {
    log "Cleaning build cache..."
    cd "$TAURI_DIR"
    cargo clean 2>/dev/null || true
    rm -rf "$TARGET_DIR/debug/bundle" 2>/dev/null || true
    rm -rf "$TARGET_DIR/release/bundle" 2>/dev/null || true
    ok "Cache cleared"
}

register_url_scheme() {
    local app_path="$1"
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -R -f "$app_path" 2>/dev/null
}

# ─── DEV BUILD ───────────────────────────────────────────────────────────────

build_dev() {
    local BINARY="$TARGET_DIR/debug/dial8-desktop"
    local BUNDLE_APP="$TARGET_DIR/debug/bundle/macos/Native Intelligence.app"
    local BUNDLE_BIN="$BUNDLE_APP/Contents/MacOS/dial8-desktop"
    # TODO(rename-compat): remove once no checkout still has a Dial8.app build.
    # The bundle was Dial8.app before the rename: drop that stale build and its
    # LaunchServices registration (same bundle id and dial8desktop:// scheme).
    local OLD_BUNDLE_APP="$TARGET_DIR/debug/bundle/macos/Dial8.app"
    if [ -d "$OLD_BUNDLE_APP" ]; then
        /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$OLD_BUNDLE_APP" 2>/dev/null || true
        rm -rf "$OLD_BUNDLE_APP"
    fi

    # kill_existing  # Temporarily disabled — keep running app open

    if [ "$CLEAN" = true ]; then
        clean_cache
    fi

    log "Building debug binary..."
    cd "$TAURI_DIR"
    cargo build 2>&1

    # Build the sidecars — meeting detection, system audio, and local
    # calendar are all dead without system-audio-capture, and that failure is
    # silent.
    log "Building sidecars..."
    sidecars_build debug

    # Ensure bundle exists
    if [ ! -d "$BUNDLE_APP" ]; then
        log "Bundle not found, creating..."
        cd "$SCRIPT_DIR"
        cargo tauri build --debug 2>&1
    fi

    # Sync binary into bundle, with the sidecars staged next to it so the
    # bundled-first sidecar resolution matches production. The bundle is
    # reused across runs: sidecars_stage first removes what it staged last
    # time, so a sidecar that no longer builds doesn't linger in it.
    cp "$BINARY" "$BUNDLE_BIN"
    sidecars_stage "$BUNDLE_APP"

    # The local agent's JS, where a release build has it (scripts/local-agent.sh).
    local_agent_stage "$BUNDLE_APP" \
        || warn "Local agent bundle not staged — local agents are unavailable in this build"

    # The Studio's runner, when one was built (scripts/studio-runner.sh).
    studio_runner_stage "$BUNDLE_APP" \
        || warn "Studio runner not staged: exports on this computer are unavailable in this build"

    # License notices (Help → Open Source Licenses), before signing so the
    # signature seals them. A dev bundle runs fine without them — the menu
    # item is just disabled — so a failure only warns (dev mode: a sidecar
    # without notices is left out with a warning; release.sh stops instead).
    licenses_stage "$BUNDLE_APP" dev \
        || warn "License notices not staged — Help → Open Source Licenses is disabled in this build"

    # Re-sign with the Developer ID after copying binaries in — the cp above
    # replaces the bundled executables and strips whatever signature they had.
    # Must run before launch so the first mic prompt writes the stable DR.
    sign_debug_bundle "$BUNDLE_APP"

    # Register URL scheme
    register_url_scheme "$BUNDLE_APP"

    log "Launching Native Intelligence.app..."
    open "$BUNDLE_APP"

    echo ""
    ok "Dev build complete — Native Intelligence is running"
    echo ""
    echo "  Deep links (dial8desktop://) will work."
    echo "  Webview → http://localhost:3000"
    echo ""

    log "Watching src/ for changes... (Ctrl+C to stop)"
    if command -v fswatch &>/dev/null; then
        fswatch -o "$TAURI_DIR/src" | while read -r; do
            echo ""
            log "Change detected, rebuilding..."
            # A failed rebuild must not end the watcher (set -e): the subshell
            # stops at its first error, and the loop keeps watching.
            set +e
            (
            set -e
            cd "$TAURI_DIR"
            cargo build 2>&1
            cp "$BINARY" "$BUNDLE_BIN"
            # cp strips the signature from the main executable — re-sign so the
            # relaunched build keeps the stable DR and doesn't poison TCC.
            sign_debug_bundle "$BUNDLE_APP"
            ok "Binary synced"

            pkill -f "\.app/Contents/MacOS/dial8-desktop" 2>/dev/null || true
            sleep 0.3
            open "$BUNDLE_APP"
            ok "Relaunched"
            )
            [ $? -eq 0 ] || err "Rebuild failed — fix it and save again"
            set -e
        done
    else
        warn "Install fswatch for auto-reload: brew install fswatch"
        echo "  Re-run ./build.sh dev after Rust code changes."
    fi
}

# ─── PROD BUILD ──────────────────────────────────────────────────────────────

# This bundle is `cargo tauri build` alone: no sidecars (system audio, meeting
# detection, local transcription) and no third-party license notices, which
# release.sh stages and signs in. Staging them here would break the signature
# Tauri just applied, so say it loudly instead.
local_only_banner() {
    echo ""
    warn "════════════════════════════════════════════════════════════════════════"
    warn "  LOCAL TESTING ONLY — DO NOT DISTRIBUTE THIS .app OR .dmg"
    warn "  It has no sidecars (system audio, meeting detection, local"
    warn "  transcription) and no third-party license notices. Anything that"
    warn "  leaves this Mac must be built with ./release.sh."
    warn "════════════════════════════════════════════════════════════════════════"
}

build_prod() {
    kill_existing

    if [ "$CLEAN" = true ]; then
        clean_cache
    fi

    # No updater artifacts: they exist only to be distributed (and fail to sign
    # without TAURI_SIGNING_PRIVATE_KEY). The build can still fail after the
    # .app and .dmg are written, so the banner prints either way.
    log "Building release binary + bundle..."
    cd "$SCRIPT_DIR"
    local status=0
    cargo tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}' 2>&1 || status=$?
    if [ "$status" -ne 0 ]; then
        err "cargo tauri build failed (exit $status)"
        local_only_banner
        exit "$status"
    fi

    local BUNDLE_APP="$TARGET_DIR/release/bundle/macos/Native Intelligence.app"
    local DMG="$TARGET_DIR/release/bundle/dmg"

    echo ""
    ok "Production build complete!"
    echo ""

    if [ -d "$BUNDLE_APP" ]; then
        echo "  .app → $BUNDLE_APP"
    fi

    if [ -d "$DMG" ]; then
        echo "  .dmg → $DMG/"
        ls "$DMG"/*.dmg 2>/dev/null | while read -r f; do
            echo "         $(basename "$f")"
        done
    fi

    echo ""
    echo "  To test: open \"$BUNDLE_APP\""
    local_only_banner
}

# ─── MAIN ────────────────────────────────────────────────────────────────────

case "$MODE" in
    dev)
        build_dev
        ;;
    prod)
        build_prod
        ;;
    *)
        err "Unknown mode: $MODE"
        echo ""
        echo "Usage:"
        echo "  ./build.sh dev          # Build, launch, and watch for changes"
        echo "  ./build.sh dev clean    # Clean build, launch, and watch"
        echo "  ./build.sh prod         # Incremental release build"
        echo "  ./build.sh prod clean   # Clean release build"
        exit 1
        ;;
esac

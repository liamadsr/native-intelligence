#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# Native Intelligence Desktop — Production Release Script
#
# Builds, signs, notarizes, and packages Native Intelligence.app into a distributable DMG.
#
# Prerequisites:
#   - Apple Developer Program membership
#   - "Developer ID Application" certificate in Keychain, named in .env.release
#     (gitignored) as NI_SIGNING_IDENTITY: see scripts/signing.sh
#   - App-specific password for notarization (appleid.apple.com)
#   - Rust toolchain + cargo-tauri CLI
#   - Swift toolchain (for sidecar)
#
# Usage:
#   ./release.sh                  # Full release build (sign + notarize + DMG)
#   ./release.sh --skip-notarize  # Build + sign only (faster, for local testing)
#   ./release.sh --clean          # Clean build caches first
#
# ═══════════════════════════════════════════════════════════════════════════════

set -e

# ─── Load credentials from .env.release if present ──────────────────────────
# It also names the signing identity (SIGNING_IDENTITY, TEAM_ID): scripts/signing.sh.
SCRIPT_DIR_EARLY="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR_EARLY/scripts/signing.sh"
signing_load "$SCRIPT_DIR_EARLY"

# ─── Configuration ────────────────────────────────────────────────────────────

# TODO(rename-compat): each setting below is read under its NI_ name first and its
# older DIAL8_ name second, so an .env.release written before the rename still works.
# Drop the DIAL8_ halves once that file uses the new names.

# Notarization credentials — set these as environment variables or fill in here.
# Prefer env vars so you don't commit secrets:
#   export NI_APPLE_ID="your@email.com"
#   export NI_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"
APPLE_ID="${NI_APPLE_ID:-${DIAL8_APPLE_ID:-}}"
APP_PASSWORD="${NI_APP_PASSWORD:-${DIAL8_APP_PASSWORD:-}}"

# Updater signing key — set after SCRIPT_DIR is defined (see Paths section)

# Cloudflare R2 — for uploading updater bundle + DMG
#   export NI_R2_ACCOUNT_ID="your-account-id"
#   export NI_R2_ACCESS_KEY_ID="your-access-key"
#   export NI_R2_SECRET_ACCESS_KEY="your-secret-key"
#   export NI_R2_BUCKET="your-bucket-name"
#   export NI_R2_PUBLIC_URL="https://pub-<id>.r2.dev"   # the bucket's public URL
R2_ACCOUNT_ID="${NI_R2_ACCOUNT_ID:-${DIAL8_R2_ACCOUNT_ID:-}}"
R2_ACCESS_KEY_ID="${NI_R2_ACCESS_KEY_ID:-${DIAL8_R2_ACCESS_KEY_ID:-}}"
R2_SECRET_ACCESS_KEY="${NI_R2_SECRET_ACCESS_KEY:-${DIAL8_R2_SECRET_ACCESS_KEY:-}}"
R2_BUCKET="${NI_R2_BUCKET:-${DIAL8_R2_BUCKET:-}}"
R2_PUBLIC_URL="${NI_R2_PUBLIC_URL:-${DIAL8_R2_PUBLIC_URL:-}}"
R2_PUBLIC_URL="${R2_PUBLIC_URL%/}"   # no trailing slash: it's joined with "/<file>"

# Supabase — for publishing release metadata
#   export NI_SUPABASE_URL="https://xxx.supabase.co"
#   export NI_SUPABASE_SERVICE_KEY="your-service-role-key"
SUPABASE_URL="${NI_SUPABASE_URL:-${DIAL8_SUPABASE_URL:-}}"
SUPABASE_SERVICE_KEY="${NI_SUPABASE_SERVICE_KEY:-${DIAL8_SUPABASE_SERVICE_KEY:-}}"

# Production frontend URL — the WebView will load this instead of localhost.
# The same address as src-tauri/src/nav_guard.rs APP_URL (where the app calls
# its API) and tauri.conf.json's frontendDist, which the Windows build uses as
# committed: change all three together.
PRODUCTION_URL="https://nativeintelligence.dev"

# ─── Paths ────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_DIR="$SCRIPT_DIR/src-tauri"
TARGET_DIR="$TAURI_DIR/target"
RELEASE_DIR="$TARGET_DIR/release"
BUNDLE_DIR="$RELEASE_DIR/bundle/macos"
APP_PATH="$BUNDLE_DIR/Native Intelligence.app"
ENTITLEMENTS="$TAURI_DIR/entitlements.production.plist"
TAURI_CONF="$TAURI_DIR/tauri.conf.json"
OUTPUT_DIR="$SCRIPT_DIR/dist"
UPDATER_KEY_PATH="$TAURI_DIR/keys/dial8.key"

# Sidecar build/stage/sign helpers (every folder in src-tauri/sidecars/).
source "$SCRIPT_DIR/scripts/sidecars.sh"
# Third-party license notices (Contents/Resources/Licenses/).
source "$SCRIPT_DIR/scripts/licenses.sh"
# The local agent bundle (Contents/Resources/local-agent).
source "$SCRIPT_DIR/scripts/local-agent.sh"
# Preflight and retries for codesign's secure timestamp (Apple's timestamp
# server, over the network).
source "$SCRIPT_DIR/scripts/timestamp.sh"
# The Windows installer, built on a GitHub runner (scripts/windows-release.sh).
source "$SCRIPT_DIR/scripts/windows-release.sh"

# ─── Colors ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${CYAN}[release]${NC} $1"; }
ok()   { echo -e "${GREEN}[release]${NC} $1"; }
warn() { echo -e "${YELLOW}[release]${NC} $1"; }
err()  { echo -e "${RED}[release]${NC} $1"; }
step() { echo -e "\n${BOLD}═══ $1 ═══${NC}\n"; }

# ─── Parse flags ──────────────────────────────────────────────────────────────

SKIP_NOTARIZE=false
SKIP_PUBLISH=false
SKIP_WINDOWS=false
WINDOWS=auto
CLEAN=false
VERSION_OVERRIDE=""
RELEASE_NOTES=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-notarize) SKIP_NOTARIZE=true; shift ;;
        --skip-publish) SKIP_PUBLISH=true; shift ;;
        --skip-windows) SKIP_WINDOWS=true; WINDOWS=no; shift ;;
        --windows) WINDOWS=yes; shift ;;
        --clean) CLEAN=true; shift ;;
        --version)
            VERSION_OVERRIDE="$2"
            shift 2
            ;;
        --notes)
            RELEASE_NOTES="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: ./release.sh [--version X.Y.Z] [--notes \"...\"] [--skip-notarize] [--skip-publish] [--windows | --skip-windows] [--clean]"
            echo ""
            echo "  --version X.Y.Z    Set the release version (updates tauri.conf.json)"
            echo "  --notes \"...\"      Release notes for the update"
            echo "  --skip-notarize    Build and sign but skip Apple notarization (faster)"
            echo "  --skip-publish     Skip uploading to R2 and publishing to Supabase (and the Windows build)"
            echo "  --windows          Build and publish Windows too, even before its signing is set up"
            echo "  --skip-windows     Release macOS alone: Windows users stay on their version"
            echo "                     (default: Windows goes out once Artifact Signing is configured,"
            echo "                     docs/WINDOWS_SIGNING.md)"
            echo "  --clean            Clean all build caches before building"
            exit 0
            ;;
        # A typo'd safety flag (--skip-publis) must not run a full publish.
        *) err "Unknown option: $1 (see --help)"; exit 2 ;;
    esac
done

# ─── Preflight checks ────────────────────────────────────────────────────────

step "Preflight Checks"

# Check signing identity exists
if [ -z "$SIGNING_IDENTITY" ]; then
    err "No signing identity set."
    echo "  Put your Developer ID in .env.release (gitignored):"
    echo "    NI_SIGNING_IDENTITY=\"<SHA-1 from: security find-identity -v -p codesigning>\""
    exit 1
fi
if ! security find-identity -v -p codesigning | grep -qF "$SIGNING_IDENTITY"; then
    err "Signing identity not found: $SIGNING_IDENTITY"
    echo "  Run: security find-identity -v -p codesigning"
    echo "  to see available identities."
    exit 1
fi
if [ -z "$TEAM_ID" ]; then
    err "Couldn't read the team ID from the name of $SIGNING_IDENTITY"
    exit 1
fi
ok "Signing identity found (team $TEAM_ID)"

# Check notarization credentials (unless skipping)
if [ "$SKIP_NOTARIZE" = false ]; then
    if [ -z "$APPLE_ID" ] || [ -z "$APP_PASSWORD" ]; then
        err "Notarization credentials not set."
        echo ""
        echo "  Set these environment variables:"
        echo "    export NI_APPLE_ID=\"your@email.com\""
        echo "    export NI_APP_PASSWORD=\"xxxx-xxxx-xxxx-xxxx\""
        echo ""
        echo "  Or run with --skip-notarize to skip notarization."
        exit 1
    fi
    ok "Notarization credentials set"
fi

# The bucket's public URL goes into the update manifest: check it now, not after the build.
if [ "$SKIP_PUBLISH" = false ] && [ -z "$R2_PUBLIC_URL" ]; then
    err "NI_R2_PUBLIC_URL not set (the R2 bucket's public URL, in .env.release)."
    echo "  Or run with --skip-publish."
    exit 1
fi

# The address this build loads must already serve the app: a build released
# before it does opens a blank window, and nothing in the app falls back to
# another address. The update route answers 204 (nothing newer) or 200 with
# JSON; a domain that is parked, or not pointed at the app yet, answers neither.
# Checked only for a build that will be published.
address_serves_the_app() {
    local answer
    answer="$(curl -sS -o /dev/null -m 20 -w '%{http_code} %{content_type}' "$PRODUCTION_URL/api/desktop/update/darwin/aarch64/0.0.0" 2>/dev/null || true)"
    case "$answer" in
        204*|"200 application/json"*) return 0 ;;
    esac
    err "$PRODUCTION_URL does not serve the app yet (its update route answered: ${answer:-nothing})."
    echo "  A build released now would open a blank window. Release once that address serves the app."
    return 1
}
if [ "$SKIP_PUBLISH" = false ]; then
    address_serves_the_app || exit 1
    ok "$PRODUCTION_URL serves the app"
fi

# Check updater signing key exists
if [ ! -f "$UPDATER_KEY_PATH" ]; then
    err "Updater signing key not found at $UPDATER_KEY_PATH"
    echo "  Generate with: cargo tauri signer generate -w src-tauri/keys/dial8.key"
    exit 1
fi
ok "Updater signing key found"

# The Windows installer is built on GitHub from the pushed commit, for a
# published release only (a test build: gh workflow run windows.yml). It goes
# out with a release once its Authenticode signing is set up (the repository
# variable docs/WINDOWS_SIGNING.md adds); --windows sends it before that,
# unsigned. Until then a release is macOS alone, exactly as before Windows.
if [ "$SKIP_PUBLISH" = true ]; then
    SKIP_WINDOWS=true
fi
if [ "$SKIP_WINDOWS" = false ] && [ "$WINDOWS" = auto ]; then
    case "$(windows_signing_state)" in
        configured)
            ok "Windows: Artifact Signing is set up, so this release ships the signed Windows installer too" ;;
        unset)
            warn "Windows: not in this release: its signing isn't set up yet (docs/WINDOWS_SIGNING.md; --windows sends it unsigned)"
            SKIP_WINDOWS=true ;;
        *)
            warn "Windows: NOT IN THIS RELEASE: couldn't ask GitHub whether its signing is set up (gh missing, signed out or offline)."
            warn "         Windows users stay on their version; fix gh (gh auth login) and re-run, or pass --windows."
            SKIP_WINDOWS=true ;;
    esac
fi
if [ "$SKIP_WINDOWS" = false ]; then
    windows_preflight || exit 1
    ok "Windows build can run (origin/$WINDOWS_BRANCH at ${WINDOWS_SHA:0:9})"
fi

# Check cargo-tauri is installed
if ! command -v cargo-tauri &>/dev/null && ! cargo tauri --version &>/dev/null 2>&1; then
    err "cargo-tauri not found. Install with: cargo install tauri-cli"
    exit 1
fi
ok "cargo-tauri available"

# Check entitlements file
if [ ! -f "$ENTITLEMENTS" ]; then
    err "Production entitlements not found at $ENTITLEMENTS"
    exit 1
fi
ok "Production entitlements found"

# Check Apple's timestamp server answers: every signing step below needs it,
# and a DNS or Wi-Fi stall fails codesign with "A timestamp was expected but
# was not found" (scripts/timestamp.sh). A short stall is waited out here.
log "Checking Apple's timestamp server (codesign --timestamp)..."
if ! timestamp_preflight "$SIGNING_IDENTITY"; then
    err "Couldn't sign a test binary with a secure timestamp."
    echo "  If codesign says the timestamp is missing or the service isn't available,"
    echo "  this Mac can't reach timestamp.apple.com (usually DNS or Wi-Fi). Check with:"
    echo "    curl -sS -o /dev/null -w '%{http_code} %{time_total}s\n' --max-time 10 http://timestamp.apple.com/ts01"
    echo "  and re-run once it answers, or switch networks (a phone hotspot works)."
    exit 1
fi
ok "Apple's timestamp server answers"

# Read or set version
if [ -n "$VERSION_OVERRIDE" ]; then
    # Update tauri.conf.json with the new version
    python3 -c "
import json
with open('$TAURI_CONF', 'r') as f:
    conf = json.load(f)
conf['version'] = '$VERSION_OVERRIDE'
with open('$TAURI_CONF', 'w') as f:
    json.dump(conf, f, indent=2)
    f.write('\n')
"
    # Update Cargo.toml version to stay in sync
    CARGO_TOML="$TAURI_DIR/Cargo.toml"
    sed -i '' "s/^version = \".*\"/version = \"$VERSION_OVERRIDE\"/" "$CARGO_TOML"

    VERSION="$VERSION_OVERRIDE"
    ok "Version set to $VERSION in tauri.conf.json and Cargo.toml"
else
    VERSION=$(python3 -c "import json; print(json.load(open('$TAURI_CONF'))['version'])")
fi
log "Building Native Intelligence v${VERSION}"

# Start the Windows build now, so it runs while this Mac builds.
WINDOWS_OK=false
if [ "$SKIP_WINDOWS" = false ]; then
    windows_dispatch "$VERSION" || exit 1
fi

# ─── Clean (optional) ────────────────────────────────────────────────────────

if [ "$CLEAN" = true ]; then
    step "Cleaning Build Caches"
    cd "$TAURI_DIR"
    cargo clean 2>/dev/null || true
    rm -rf "$TAURI_DIR"/sidecars/*/.build "$TAURI_DIR"/sidecars/*/.out 2>/dev/null || true
    ok "Caches cleared"
fi

# ─── Step 1: Build sidecar (release) ─────────────────────────────────────────

step "Step 1/7 — Build Sidecars"

log "Building every sidecar in src-tauri/sidecars/ in release mode..."
if ! sidecars_build release; then
    err "Sidecar build failed"
    exit 1
fi
ok "Sidecars built"

# ─── Step 2: Patch frontendDist for production ───────────────────────────────

step "Step 2/7 — Configure Production Frontend"

# Back up the original config
cp "$TAURI_CONF" "$TAURI_CONF.bak"

# Patch frontendDist to production URL
python3 -c "
import json
with open('$TAURI_CONF', 'r') as f:
    conf = json.load(f)
conf['build']['frontendDist'] = '$PRODUCTION_URL'
with open('$TAURI_CONF', 'w') as f:
    json.dump(conf, f, indent=2)
    f.write('\n')
"
ok "frontendDist set to $PRODUCTION_URL"

# Ensure config gets restored on exit (even on error)
restore_config() {
    if [ -f "$TAURI_CONF.bak" ]; then
        mv "$TAURI_CONF.bak" "$TAURI_CONF"
        log "Restored original tauri.conf.json"
    fi
}
trap restore_config EXIT

# ─── Step 3: Build Tauri app (release) ───────────────────────────────────────

step "Step 3/7 — Build Tauri App (Release)"

cd "$SCRIPT_DIR"
log "Running cargo tauri build (this may take a few minutes)..."

# Set updater signing key so Tauri generates .sig files for auto-update
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$UPDATER_KEY_PATH")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

# Build only the app here: Step 7 makes the distributable DMG from the final
# signed, notarized app. Tauri's preliminary DMG is unused and its Finder
# layout automation can fail before that final app is ready.
# Let Tauri build and do initial signing with our identity. If Tauri's codesign
# can't get a timestamp, timestamp_retry runs the build again (the Rust build is
# cached by then, so a retry only bundles and signs).
timestamp_retry env APPLE_SIGNING_IDENTITY="$SIGNING_IDENTITY" cargo tauri build --bundles app

if [ ! -d "$APP_PATH" ]; then
    err "App bundle not found at $APP_PATH"
    exit 1
fi
ok "App bundle created: $APP_PATH"

# ─── Step 3b: Inject privacy keys into Info.plist ─────────────────────────────
#
# Tauri v2 generates its own Info.plist but doesn't support inline plist entries.
# We inject macOS TCC (Transparency, Consent, Control) privacy keys so the OS
# knows to show permission dialogs for mic, calendar, screen recording, etc.
# Without these keys, macOS silently denies all permission requests and the app
# won't even appear in System Settings > Privacy.

step "Step 3b — Inject Info.plist Privacy Keys"

BUNDLE_PLIST="$APP_PATH/Contents/Info.plist"
SOURCE_PLIST="$TAURI_DIR/Info.plist"

if [ ! -f "$SOURCE_PLIST" ]; then
    err "Source Info.plist not found at $SOURCE_PLIST"
    exit 1
fi

# Merge each key from our custom Info.plist into the bundle's generated plist
PLIST_KEYS=(
    "NSMicrophoneUsageDescription"
    "NSCameraUsageDescription"
    "NSAudioCaptureUsageDescription"
    "NSSpeechRecognitionUsageDescription"
    "NSCalendarsUsageDescription"
    "NSCalendarsFullAccessUsageDescription"
)

for KEY in "${PLIST_KEYS[@]}"; do
    VALUE=$(/usr/libexec/PlistBuddy -c "Print :$KEY" "$SOURCE_PLIST" 2>/dev/null)
    if [ -n "$VALUE" ]; then
        # plutil takes the value as one argument: PlistBuddy's quoted form
        # failed on an apostrophe ("you're") while still exiting 0.
        plutil -replace "$KEY" -string "$VALUE" "$BUNDLE_PLIST"
        log "  Added $KEY"
    fi
done

# Verify all required keys are present
REQUIRED_KEYS=(
    "NSMicrophoneUsageDescription"
    "NSCameraUsageDescription"
    "NSSpeechRecognitionUsageDescription"
    "NSCalendarsFullAccessUsageDescription"
    "NSCalendarsUsageDescription"
)
PLIST_OK=true
for KEY in "${REQUIRED_KEYS[@]}"; do
    if ! /usr/libexec/PlistBuddy -c "Print :$KEY" "$BUNDLE_PLIST" &>/dev/null; then
        err "MISSING plist key after injection: $KEY"
        PLIST_OK=false
    fi
done
if [ "$PLIST_OK" = false ]; then
    err "Info.plist is still missing required privacy keys."
    exit 1
fi
ok "All privacy keys injected and verified"

# ─── Step 4: Bundle sidecar into .app ────────────────────────────────────────

step "Step 4/7 — Bundle Sidecars"

MACOS_DIR="$APP_PATH/Contents/MacOS"
sidecars_stage "$APP_PATH"
while IFS= read -r staged; do
    ok "Sidecar staged: $staged"
done < <(sidecars_staged_executables "$APP_PATH")
# Belt and braces: the app is broken without these, whatever the loop saw.
for required in system-audio-capture dial8-local-stt dial8-local-tts; do
    if [ ! -x "$MACOS_DIR/$required" ]; then
        err "Required sidecar missing from the bundle: $required"
        exit 1
    fi
done

# The local agent's JavaScript (scripts/local-agent.sh): exactly the vendored
# bundle, built from committed web source, checked file by file against its
# BUNDLE.json. Its Node is downloaded on first use (runtime.json), not shipped.
if ! local_agent_stage "$APP_PATH"; then
    err "Local agent bundle missing (scripts/local-agent-bundle.sh, then commit it)"
    exit 1
fi
if ! LOCAL_AGENT_FROM="$(local_agent_verify "$APP_PATH")"; then
    err "Local agent bundle failed its check"
    exit 1
fi
ok "Local agent staged: $LOCAL_AGENT_FROM"

# Third-party notices: the app's Rust crates, the Rust standard library and
# every staged sidecar's own (each sidecar's build.sh writes them; one without
# stops the release), folded into
# Contents/Resources/Licenses/THIRD_PARTY_NOTICES.txt (Help → Open Source
# Licenses). Staged here, before Step 5, so the signature seals them. A
# release never ships without them.
log "Staging third-party license notices..."
if ! licenses_stage "$APP_PATH" release; then
    err "License notices could not be generated"
    exit 1
fi
if ! licenses_verify "$APP_PATH" dial8-desktop rust-std vad local-agent local-stt local-tts; then
    err "License notices are incomplete"
    exit 1
fi
ok "License notices staged: Contents/Resources/Licenses/THIRD_PARTY_NOTICES.txt"

# ─── Step 5: Code sign everything ────────────────────────────────────────────

step "Step 5/7 — Code Sign"

# Every codesign --timestamp in this step (and the DMG's in Step 7) runs
# through timestamp_retry, which signs again after a timestamp-server stall
# (scripts/timestamp.sh).

# Clear extended attributes
xattr -cr "$APP_PATH"

# Sign the sidecars first (innermost → outermost).
#
# The later `codesign --force --deep` pass (below) re-signs each sidecar and
# sets its Identifier to the executable name (verified on the shipped
# system-audio-capture). The sidecars never call a TCC-gated API: the main
# process creates the Core Audio process tap (AudioHardwareCreateProcessTap in
# tap_helper.m) and opens the mic (cpal build_input_stream), so it is the
# process that prompts and holds the grant. system-audio-capture only reads PCM
# from the resulting aggregate device, which is attributed to the responsible
# parent app, and local-module sidecars only read the PCM we pipe to them.
log "Signing sidecar binaries..."
if ! timestamp_retry sidecars_sign_release "$APP_PATH" "$SIGNING_IDENTITY" "$ENTITLEMENTS"; then
    err "Sidecar signing failed"
    exit 1
fi

# Sign any embedded frameworks and dylibs (innermost first)
log "Signing embedded frameworks..."
if [ -d "$APP_PATH/Contents/Frameworks" ]; then
    # Sign dylibs (files)
    find "$APP_PATH/Contents/Frameworks" -type f -name "*.dylib" | while read -r fw; do
        timestamp_retry codesign --force --options runtime \
            --sign "$SIGNING_IDENTITY" \
            --timestamp \
            "$fw" >/dev/null || true
    done
    # Sign framework bundles (directories)
    find "$APP_PATH/Contents/Frameworks" -type d -name "*.framework" | while read -r fw; do
        timestamp_retry codesign --force --options runtime \
            --sign "$SIGNING_IDENTITY" \
            --timestamp \
            "$fw" >/dev/null || true
    done
fi

# Sign the main executable explicitly with entitlements.
# This ensures entitlements are embedded in the binary's code signature,
# which is required for macOS TCC dialogs (calendar, microphone, etc.).
log "Signing main executable with entitlements..."
timestamp_retry codesign --force --options runtime \
    --sign "$SIGNING_IDENTITY" \
    --timestamp \
    --entitlements "$ENTITLEMENTS" \
    "$MACOS_DIR/dial8-desktop"

# Sign the app bundle with --deep as a safety net to catch anything missed,
# then re-sign the main executable to ensure entitlements aren't stripped.
log "Signing Native Intelligence.app bundle..."
timestamp_retry codesign --force --deep --options runtime \
    --sign "$SIGNING_IDENTITY" \
    --timestamp \
    --entitlements "$ENTITLEMENTS" \
    "$APP_PATH"

# Re-sign main executable AFTER --deep to guarantee entitlements are embedded
# (--deep re-signs inner binaries without --entitlements, which can strip them)
timestamp_retry codesign --force --options runtime \
    --sign "$SIGNING_IDENTITY" \
    --timestamp \
    --entitlements "$ENTITLEMENTS" \
    "$MACOS_DIR/dial8-desktop"

# Verify signing
log "Verifying code signature..."
if ! codesign -vv --deep --strict "$APP_PATH"; then
    err "Code signing verification FAILED"
    exit 1
fi
ok "Code signature verified"

# ─── Post-sign assertions (fail the release on identity/DR/entitlement drift) ─
#
# All four assertions are TRUE on the current pipeline — they exist to catch a
# FUTURE regression that would re-break the permission flow (e.g. an ad-hoc DR,
# a lost audio-input entitlement, or a team-ID change). If any fail, the signing
# recipe above regressed; do NOT ship. See docs/PERMISSIONS.md for the rationale.
log "Asserting post-sign invariants..."

MAIN_EXEC="$MACOS_DIR/dial8-desktop"

# (a) Main executable Identifier + TeamIdentifier.
MAIN_DV="$(codesign -dv "$MAIN_EXEC" 2>&1)"
if ! grep -q "^Identifier=ai.dial8.desktop$" <<< "$MAIN_DV"; then
    err "ASSERT FAILED: main executable Identifier is not ai.dial8.desktop"
    echo "$MAIN_DV" | grep "^Identifier=" || true
    exit 1
fi
if ! grep -q "^TeamIdentifier=$TEAM_ID$" <<< "$MAIN_DV"; then
    err "ASSERT FAILED: main executable TeamIdentifier is not $TEAM_ID"
    echo "$MAIN_DV" | grep "^TeamIdentifier=" || true
    exit 1
fi

# (b) Main executable designated requirement = stable Developer ID form
#     (must reference the bundle id and the team OU, NOT an ad-hoc cdhash).
MAIN_DR="$(codesign -d -r- "$MAIN_EXEC" 2>&1)"
if ! grep -q 'identifier "ai.dial8.desktop"' <<< "$MAIN_DR"; then
    err "ASSERT FAILED: main DR missing 'identifier \"ai.dial8.desktop\"' (ad-hoc DR?)"
    echo "$MAIN_DR"
    exit 1
fi
if ! grep -q "$TEAM_ID" <<< "$MAIN_DR"; then
    err "ASSERT FAILED: main DR missing team $TEAM_ID"
    echo "$MAIN_DR"
    exit 1
fi

# (c) Main executable carries the microphone entitlement (else TCC won't prompt).
if ! codesign -d --entitlements - "$MAIN_EXEC" 2>&1 | grep -q "com.apple.security.device.audio-input"; then
    err "ASSERT FAILED: main executable missing com.apple.security.device.audio-input"
    exit 1
fi

# (d) Every sidecar executable and sidecar dylib is signed by our team
#     (Identifier intentionally NOT asserted — the --deep pass rewrites it to
#     the executable name, which is known/harmless). Hardened-runtime library
#     validation refuses to load a dylib signed by another team, so a dylib
#     that slipped through unsigned would crash its sidecar on launch.
while IFS= read -r SIDECAR_CODE; do
    if ! codesign -dv "$SIDECAR_CODE" 2>&1 | grep -q "^TeamIdentifier=$TEAM_ID$"; then
        err "ASSERT FAILED: $(basename "$SIDECAR_CODE") TeamIdentifier is not $TEAM_ID"
        codesign -dv "$SIDECAR_CODE" 2>&1 | grep "^TeamIdentifier=" || true
        exit 1
    fi
done < <(sidecars_staged_executables "$APP_PATH"; sidecars_staged_dylibs "$APP_PATH")

# (e) Library validation is ON: the main executable doesn't carry
#     disable-library-validation (security review 2026-10-31: with it, a
#     same-user process could load its own dylib into the process holding the
#     mic, screen and accessibility grants). So every dylib in Frameworks must be
#     ours, or the app can't load it (ONNX Runtime, ggml, nemo).
if codesign -d --entitlements - "$MAIN_EXEC" 2>&1 | grep -q "disable-library-validation"; then
    err "ASSERT FAILED: main executable carries com.apple.security.cs.disable-library-validation"
    exit 1
fi
if [ -d "$APP_PATH/Contents/Frameworks" ]; then
    while IFS= read -r FW_DYLIB; do
        if ! codesign -dv "$FW_DYLIB" 2>&1 | grep -q "^TeamIdentifier=$TEAM_ID$"; then
            err "ASSERT FAILED: Frameworks/$(basename "$FW_DYLIB") TeamIdentifier is not $TEAM_ID"
            codesign -dv "$FW_DYLIB" 2>&1 | grep "^TeamIdentifier=" || true
            exit 1
        fi
    done < <(find "$APP_PATH/Contents/Frameworks" -type f -name "*.dylib")
fi

ok "Post-sign invariants hold (identity, DR, entitlements, sidecar and Frameworks team, library validation on)"

# ─── Step 6: Notarize ────────────────────────────────────────────────────────

if [ "$SKIP_NOTARIZE" = true ]; then
    step "Step 6/7 — Notarization (SKIPPED)"
    warn "Skipping notarization. The app will trigger Gatekeeper warnings on other machines."
else
    step "Step 6/7 — Notarize with Apple"

    # Create a zip for notarization submission
    NOTARIZE_ZIP="$RELEASE_DIR/NativeIntelligence-notarize.zip"
    log "Creating zip for notarization..."
    ditto -c -k --keepParent "$APP_PATH" "$NOTARIZE_ZIP"

    # Submit for notarization
    log "Submitting to Apple for notarization (this may take 5-15 minutes)..."
    # `|| NOTARIZE_EXIT=$?`: under set -e a bare failure would exit before
    # the guidance below.
    NOTARIZE_EXIT=0
    xcrun notarytool submit "$NOTARIZE_ZIP" \
        --apple-id "$APPLE_ID" \
        --password "$APP_PASSWORD" \
        --team-id "$TEAM_ID" \
        --wait || NOTARIZE_EXIT=$?
    rm -f "$NOTARIZE_ZIP"

    if [ $NOTARIZE_EXIT -ne 0 ]; then
        err "Notarization FAILED"
        echo "  Run with --skip-notarize to build without notarization"
        echo "  Check the notarization log for details:"
        echo "    xcrun notarytool log <submission-id> --apple-id $APPLE_ID --password \$NI_APP_PASSWORD --team-id $TEAM_ID"
        exit 1
    fi
    ok "Notarization succeeded"

    # Staple the notarization ticket
    log "Stapling notarization ticket..."
    xcrun stapler staple "$APP_PATH"

    if ! xcrun stapler validate "$APP_PATH"; then
        err "Stapling validation FAILED"
        exit 1
    fi
    ok "Notarization ticket stapled"

    # Verify Gatekeeper acceptance
    log "Verifying Gatekeeper acceptance..."
    if spctl --assess -vv "$APP_PATH" 2>&1; then
        ok "Gatekeeper accepted"
    else
        warn "Gatekeeper assessment returned a warning (may be OK for non-sandboxed apps)"
    fi
fi

# ─── Step 7: Create DMG ──────────────────────────────────────────────────────

step "Step 7/7 — Create DMG"

mkdir -p "$OUTPUT_DIR"
DMG_NAME="Dial8_${VERSION}_aarch64.dmg"
DMG_PATH="$OUTPUT_DIR/$DMG_NAME"

# Remove existing DMG
rm -f "$DMG_PATH"

# Create a temp directory for DMG contents
TMP_DMG_DIR=$(mktemp -d)

# Copy app (ditto preserves extended attributes including the notarization staple)
ditto "$APP_PATH" "$TMP_DMG_DIR/Native Intelligence.app"

# Create Applications symlink
ln -s /Applications "$TMP_DMG_DIR/Applications"

# Create the DMG
log "Creating DMG..."
hdiutil create \
    -volname "Native Intelligence" \
    -srcfolder "$TMP_DMG_DIR" \
    -ov \
    -format UDZO \
    "$DMG_PATH"

# Clean up temp dir
rm -rf "$TMP_DMG_DIR"

# Sign the DMG itself
log "Signing DMG..."
timestamp_retry codesign --force \
    --sign "$SIGNING_IDENTITY" \
    --timestamp \
    "$DMG_PATH"

# Verify DMG
if ! hdiutil verify "$DMG_PATH" > /dev/null 2>&1; then
    warn "DMG verification returned a warning (usually safe to ignore for signed DMGs)"
fi

ok "DMG created: $DMG_PATH"

# ─── Rebuild updater bundle from the final signed+notarized app ──────────────
#
# cargo tauri build creates its own "Native Intelligence.app.tar.gz" BEFORE the release script re-signs
# with entitlements, injects plist keys, and notarizes. The auto-updater would
# deliver the pre-re-signed version without entitlements. Rebuild it now.

UPDATER_BUNDLE="$OUTPUT_DIR/Dial8.app.tar.gz"
UPDATER_SIG="$OUTPUT_DIR/Dial8.app.tar.gz.sig"

log "Rebuilding updater bundle from final signed app..."
rm -f "$UPDATER_BUNDLE" "$UPDATER_SIG"

# Create tar.gz from the final app (same format Tauri uses)
# COPYFILE_DISABLE=1 prevents macOS resource fork ._* files from being included,
# which the Tauri updater can't unpack.
COPYFILE_DISABLE=1 tar -czf "$UPDATER_BUNDLE" -C "$BUNDLE_DIR" "Native Intelligence.app"

# Re-sign the updater bundle with the Tauri updater key
if [ -f "$UPDATER_KEY_PATH" ]; then
    log "Signing updater bundle..."
    # Find the Tauri CLI signer
    TAURI_SIGNER=$(which cargo-tauri 2>/dev/null || echo "")
    if [ -n "$TAURI_SIGNER" ]; then
        TAURI_SIGNING_PRIVATE_KEY="$(cat "$UPDATER_KEY_PATH")" \
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
        cargo tauri signer sign "$UPDATER_BUNDLE" 2>&1
        ok "Updater bundle signed"
    else
        err "cargo-tauri not found — cannot sign updater bundle"
    fi
else
    err "Updater key not found — updater signature will be missing"
fi

# ─── Windows installer ───────────────────────────────────────────────────

if [ "$SKIP_WINDOWS" = false ]; then
    step "Windows Installer"
    mkdir -p "$OUTPUT_DIR"
    if windows_collect "$OUTPUT_DIR"; then
        WINDOWS_OK=true
    else
        warn "PUBLISHING macOS ONLY: Windows users stay on their current version."
    fi
fi

# ─── Step 8: Publish Update ──────────────────────────────────────────────

PUBLISH_OK=true

if [ "$SKIP_PUBLISH" = true ]; then
    step "Step 8/8 — Publish Update (SKIPPED)"
    warn "Skipping publish. Upload to R2 and insert into Supabase manually."
    PUBLISH_OK=false
else
    step "Step 8/8 — Publish Update"

    # Check required credentials
    if [ -z "$R2_ACCOUNT_ID" ] || [ -z "$R2_ACCESS_KEY_ID" ] || [ -z "$R2_SECRET_ACCESS_KEY" ] || [ -z "$R2_BUCKET" ] || [ -z "$R2_PUBLIC_URL" ]; then
        warn "R2 credentials not set — skipping upload."
        warn "Set NI_R2_ACCOUNT_ID, NI_R2_ACCESS_KEY_ID, NI_R2_SECRET_ACCESS_KEY, NI_R2_BUCKET, NI_R2_PUBLIC_URL"  # gitleaks:allow (env var names)
        PUBLISH_OK=false
    fi
    if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_KEY" ]; then
        warn "Supabase credentials not set — skipping release publish."
        warn "Set NI_SUPABASE_URL, NI_SUPABASE_SERVICE_KEY"
        PUBLISH_OK=false
    fi

    if [ "$PUBLISH_OK" = true ] && ! command -v aws &>/dev/null; then
        err "aws CLI not found. Install with: brew install awscli"
        warn "Skipping upload."
        PUBLISH_OK=false
    fi

    # Every client rejects an update without its signature: publish nothing.
    if [ "$PUBLISH_OK" = true ] && [ ! -s "$OUTPUT_DIR/Dial8.app.tar.gz.sig" ]; then
        err "Updater signature missing ($OUTPUT_DIR/Dial8.app.tar.gz.sig) — skipping upload and publish."
        PUBLISH_OK=false
    fi

    if [ "$PUBLISH_OK" = true ]; then
        R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
        UPDATER_R2_KEY="Dial8_${VERSION}.app.tar.gz"
        DMG_R2_KEY="Dial8.dmg"

        # Upload updater bundle (.tar.gz)
        log "Uploading updater bundle to R2..."
        AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
        AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
        aws s3 cp "$OUTPUT_DIR/Dial8.app.tar.gz" \
            "s3://${R2_BUCKET}/${UPDATER_R2_KEY}" \
            --endpoint-url "$R2_ENDPOINT" \
            --region auto \
            2>&1
        ok "Updater bundle uploaded: ${UPDATER_R2_KEY}"

        # Upload DMG (overwrite latest)
        log "Uploading DMG to R2..."
        AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
        AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
        aws s3 cp "$DMG_PATH" \
            "s3://${R2_BUCKET}/${DMG_R2_KEY}" \
            --endpoint-url "$R2_ENDPOINT" \
            --region auto \
            2>&1
        ok "DMG uploaded: ${DMG_R2_KEY}"

        # Upload the Windows installer: once under its version for the
        # updater, and over Dial8-setup.exe, the website's download.
        WINDOWS_UPDATER_URL=""
        WINDOWS_SIG_CONTENT=""
        if [ "$WINDOWS_OK" = true ]; then
            WINDOWS_UPDATER_R2_KEY="Dial8_${VERSION}_x64-setup.exe"
            log "Uploading Windows installer to R2..."
            if AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
                AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
                aws s3 cp "$WINDOWS_EXE" "s3://${R2_BUCKET}/${WINDOWS_UPDATER_R2_KEY}" \
                    --endpoint-url "$R2_ENDPOINT" --region auto 2>&1 \
               && AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
                AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
                aws s3 cp "$WINDOWS_EXE" "s3://${R2_BUCKET}/Dial8-setup.exe" \
                    --endpoint-url "$R2_ENDPOINT" --region auto 2>&1; then
                WINDOWS_UPDATER_URL="${R2_PUBLIC_URL}/${WINDOWS_UPDATER_R2_KEY}"
                WINDOWS_SIG_CONTENT=$(cat "$WINDOWS_SIG")
                ok "Windows installer uploaded: ${WINDOWS_UPDATER_R2_KEY}, Dial8-setup.exe"
            else
                err "Windows installer upload failed: PUBLISHING macOS ONLY."
                WINDOWS_OK=false
            fi
        fi

        # Read signature
        SIG_CONTENT=""
        if [ -f "$OUTPUT_DIR/Dial8.app.tar.gz.sig" ]; then
            SIG_CONTENT=$(cat "$OUTPUT_DIR/Dial8.app.tar.gz.sig")
        else
            err "Signature file not found — update will fail verification"
        fi

        # Publish release to Supabase
        UPDATER_URL="${R2_PUBLIC_URL}/${UPDATER_R2_KEY}"
        PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

        log "Publishing release v${VERSION} to Supabase..."

        # Build JSON payload via python for safe escaping of all values
        python3 - "$VERSION" "${RELEASE_NOTES:-Release v${VERSION}}" "$PUB_DATE" "$UPDATER_URL" "$SIG_CONTENT" "$WINDOWS_UPDATER_URL" "$WINDOWS_SIG_CONTENT" << 'PYEOF' > /tmp/ni-release-payload.json
import json, sys
version, notes, pub_date, url, signature, win_url, win_signature = sys.argv[1:8]
platforms = {
    "darwin-aarch64": {
        "url": url,
        "signature": signature
    }
}
if win_url and win_signature:
    platforms["windows-x86_64"] = {"url": win_url, "signature": win_signature}
payload = {
    "version": version,
    "notes": notes,
    "pub_date": pub_date,
    "published": True,
    "platforms": platforms
}
print(json.dumps(payload))
PYEOF

        # Delete any existing row for this version (in case of re-release).
        # Older versions are deleted only AFTER the new row is in, so a failed
        # insert never leaves the updater with no release at all.
        curl -s -o /dev/null \
            -X DELETE "${SUPABASE_URL}/rest/v1/desktop_releases?version=eq.${VERSION}" \
            -H "apikey: ${SUPABASE_SERVICE_KEY}" \
            -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}"

        HTTP_STATUS=$(curl -s -o /tmp/ni-release-response.json -w "%{http_code}" \
            -X POST "${SUPABASE_URL}/rest/v1/desktop_releases" \
            -H "apikey: ${SUPABASE_SERVICE_KEY}" \
            -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
            -H "Content-Type: application/json" \
            -H "Prefer: return=minimal" \
            -d @/tmp/ni-release-payload.json)

        if [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 300 ]; then
            ok "Release v${VERSION} published to database"

            # Now delete all previous releases — only keep the latest
            DELETE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
                -X DELETE "${SUPABASE_URL}/rest/v1/desktop_releases?version=neq.${VERSION}" \
                -H "apikey: ${SUPABASE_SERVICE_KEY}" \
                -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}") || true
            if [ "$DELETE_STATUS" -lt 200 ] || [ "$DELETE_STATUS" -ge 300 ]; then
                warn "Could not delete older releases (HTTP $DELETE_STATUS) — remove them manually"
            fi
        else
            err "Failed to publish release (HTTP $HTTP_STATUS)"
            cat /tmp/ni-release-response.json 2>/dev/null
            echo ""
            PUBLISH_OK=false
        fi
        rm -f /tmp/ni-release-response.json
    fi
fi

# ─── Summary ─────────────────────────────────────────────────────────────

step "Release Complete"

DMG_SIZE=$(du -h "$DMG_PATH" | cut -f1)

echo -e "  ${BOLD}App:${NC}        $APP_PATH"
echo -e "  ${BOLD}DMG:${NC}        $DMG_PATH"
if [ -f "$OUTPUT_DIR/Dial8.app.tar.gz" ]; then
    echo -e "  ${BOLD}Updater:${NC}    $OUTPUT_DIR/Dial8.app.tar.gz"
    echo -e "  ${BOLD}Signature:${NC}  $OUTPUT_DIR/Dial8.app.tar.gz.sig"
fi
if [ "$WINDOWS_OK" = true ]; then
    echo -e "  ${BOLD}Windows:${NC}    $WINDOWS_EXE"
elif [ "$SKIP_WINDOWS" = true ]; then
    echo -e "  ${BOLD}Windows:${NC}    ${YELLOW}Skipped${NC}"
else
    echo -e "  ${BOLD}Windows:${NC}    ${YELLOW}Not built (see above)${NC}"
fi
echo -e "  ${BOLD}Version:${NC}    $VERSION"
echo -e "  ${BOLD}Size:${NC}       $DMG_SIZE"
echo -e "  ${BOLD}Signed:${NC}     $SIGNING_IDENTITY"
if [ "$SKIP_NOTARIZE" = true ]; then
    echo -e "  ${BOLD}Notarized:${NC}  ${YELLOW}No (--skip-notarize)${NC}"
else
    echo -e "  ${BOLD}Notarized:${NC}  ${GREEN}Yes${NC}"
fi
if [ "$SKIP_PUBLISH" = false ] && [ "$PUBLISH_OK" = true ]; then
    echo -e "  ${BOLD}Published:${NC}  ${GREEN}Yes (v${VERSION})${NC}"
else
    echo -e "  ${BOLD}Published:${NC}  ${YELLOW}No${NC}"
fi

echo ""
echo "  To test locally:  open \"$APP_PATH\""
echo ""

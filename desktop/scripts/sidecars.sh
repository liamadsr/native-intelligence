#!/bin/bash
# Shared sidecar helpers — sourced by dev.sh, build.sh and release.sh.
#
# Convention (see dial8-website/docs/plans/local-modules.md §1.3): every folder
# under src-tauri/sidecars/ that has a build.sh (which must be executable) is a
# sidecar.
# `build.sh <debug|release>` must leave:
#
#   .out/bin/<executable>   → staged into Dial8.app/Contents/MacOS/
#   .out/lib/*.dylib        → staged into Dial8.app/Contents/Frameworks/ (optional)
#   .out/licenses/NOTICES.txt (required) and the license texts it cites (paths
#                           relative to it) → staged into
#                           Dial8.app/Contents/Resources/Licenses/<folder>/ by
#                           licenses_stage (scripts/licenses.sh). NOTICES.txt
#                           names the sidecar's third-party components; a
#                           sidecar with none writes one that says so. Nothing
#                           writes it for the sidecar: release.sh stops on a
#                           staged sidecar without it.
#
# Adding a sidecar = adding a folder. These scripts never name a sidecar.
#
# Requires TAURI_DIR to be set by the caller. bash 3.2 compatible.

SIDECARS_ROOT="$TAURI_DIR/sidecars"
# What sidecars_stage copied into a bundle last time, one path per line
# relative to Contents/ (MacOS/<executable>, Frameworks/<dylib>).
SIDECARS_MANIFEST="Resources/sidecars-manifest.txt"

# Build every sidecar. $1 = debug | release.
#
# release: any failure is fatal — a release must never ship without a sidecar.
# debug:   a failing sidecar is reported and skipped so the rest of the app
#          still builds (e.g. local-stt needs cmake + ninja; the app runs
#          without it and shows the module as unavailable).
sidecars_build() {
    local config="$1"
    local dir name failed=""
    for dir in "$SIDECARS_ROOT"/*/; do
        dir="${dir%/}"
        [ -e "$dir/build.sh" ] || continue
        name="$(basename "$dir")"
        if [ ! -x "$dir/build.sh" ]; then
            echo "[sidecars] ERROR: $name/build.sh is not executable (git update-index --chmod=+x)" >&2
            return 1
        fi
        echo "[sidecars] building $name ($config)..."
        rm -rf "$dir/.out/bin" "$dir/.out/lib" "$dir/.out/licenses"
        if ! (cd "$dir" && ./build.sh "$config") || ! ls "$dir/.out/bin/"* >/dev/null 2>&1; then
            rm -rf "$dir/.out/bin" "$dir/.out/lib" "$dir/.out/licenses"
            if [ "$config" = "release" ]; then
                echo "[sidecars] ERROR: $name failed to build" >&2
                return 1
            fi
            echo "[sidecars] WARNING: $name failed to build — continuing without it (debug)" >&2
            failed="$failed $name"
        fi
    done
    [ -z "$failed" ] || echo "[sidecars] WARNING: built without:$failed" >&2
    return 0
}

# Copy every built sidecar into an app bundle. $1 = path to Dial8.app.
# (Their license notices are staged by licenses_stage, scripts/licenses.sh.)
#
# First removes whatever the previous run staged (the manifest), so a bundle
# that is reused (build.sh dev) never keeps a sidecar that has since failed to
# build: its binary would linger while its notices, which follow .out/, would
# not. Each file goes into the manifest before it is copied, so an interrupted
# run is cleaned up by the next one.
sidecars_stage() {
    local app="$1"
    local contents="$app/Contents"
    local manifest="$contents/$SIDECARS_MANIFEST"
    local dir file rel
    if [ ! -d "$contents/MacOS" ]; then
        echo "[sidecars] ERROR: $app is not an app bundle" >&2
        return 1
    fi

    if [ -f "$manifest" ]; then
        while IFS= read -r rel; do
            # Only a file directly in MacOS/ or Frameworks/ — never anything
            # else, whatever the manifest says.
            case "$rel" in
                */*/*|*..*|*/.) continue ;;
                MacOS/?*|Frameworks/?*) rm -f "$contents/$rel" ;;
            esac
        done < "$manifest"
    fi
    mkdir -p "$(dirname "$manifest")" || return 1
    : > "$manifest" || return 1

    for dir in "$SIDECARS_ROOT"/*/; do
        dir="${dir%/}"
        [ -e "$dir/build.sh" ] || continue
        # A sidecar is staged when its .out/bin has something in it (the rule
        # licenses_stage uses to pick whose notices go in): never its dylibs
        # alone.
        ls "$dir/.out/bin/"* >/dev/null 2>&1 || continue
        for file in "$dir/.out/bin/"*; do
            [ -f "$file" ] || continue
            echo "MacOS/$(basename "$file")" >> "$manifest"
            cp "$file" "$contents/MacOS/" || return 1
        done
        for file in "$dir/.out/lib/"*.dylib; do
            [ -f "$file" ] || continue
            mkdir -p "$contents/Frameworks" || return 1
            echo "Frameworks/$(basename "$file")" >> "$manifest"
            cp "$file" "$contents/Frameworks/" || return 1
        done
    done
}

# Print the staged path of every sidecar executable, one per line.
# $1 = path to Dial8.app.
sidecars_staged_executables() {
    local app="$1"
    local dir bin
    for dir in "$SIDECARS_ROOT"/*/; do
        dir="${dir%/}"
        [ -e "$dir/build.sh" ] || continue
        for bin in "$dir/.out/bin/"*; do
            [ -f "$bin" ] || continue
            echo "$app/Contents/MacOS/$(basename "$bin")"
        done
    done
}

# Print the staged path of every sidecar dylib, one per line.
# $1 = path to Dial8.app.
sidecars_staged_dylibs() {
    local app="$1"
    local dir lib
    for dir in "$SIDECARS_ROOT"/*/; do
        dir="${dir%/}"
        [ -e "$dir/build.sh" ] || continue
        ls "$dir/.out/bin/"* >/dev/null 2>&1 || continue  # not staged (sidecars_stage)
        for lib in "$dir/.out/lib/"*.dylib; do
            [ -f "$lib" ] || continue
            echo "$app/Contents/Frameworks/$(basename "$lib")"
        done
    done
}

# Sign staged sidecars for a local dev bundle, innermost first (dylibs, then
# executables). Same flags dev bundles use for the main app: no hardened
# runtime (debuggers must attach), no timestamp.
# $1 = Dial8.app, $2 = signing identity, $3 = entitlements plist.
sidecars_sign_dev() {
    local app="$1" identity="$2" entitlements="$3"
    local path
    while IFS= read -r path; do
        [ -f "$path" ] || continue
        codesign --force --sign "$identity" --timestamp=none "$path"
    done < <(sidecars_staged_dylibs "$app")
    while IFS= read -r path; do
        [ -f "$path" ] || continue
        codesign --force --sign "$identity" --timestamp=none \
            --entitlements "$entitlements" "$path"
    done < <(sidecars_staged_executables "$app")
}

# Sign staged sidecar executables for release: hardened runtime, secure
# timestamp, production entitlements. Dylibs in Contents/Frameworks are signed
# by release.sh's existing Frameworks pass.
# $1 = Dial8.app, $2 = signing identity, $3 = entitlements plist.
sidecars_sign_release() {
    local app="$1" identity="$2" entitlements="$3"
    local path
    while IFS= read -r path; do
        [ -f "$path" ] || continue
        echo "[sidecars] signing $(basename "$path")..."
        codesign --force --options runtime \
            --sign "$identity" \
            --timestamp \
            --entitlements "$entitlements" \
            "$path" || return 1
    done < <(sidecars_staged_executables "$app")
}

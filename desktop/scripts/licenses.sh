#!/bin/bash
# Third-party license notices — sourced by dev.sh, build.sh and release.sh.
#
# licenses_stage builds Native Intelligence.app/Contents/Resources/Licenses/ from scratch:
#
#   dial8-desktop/          the Rust crates linked into the main executable
#                           (scripts/licenses/rust_crates.py, from Cargo's build
#                           graph: cargo tree)
#   rust-std/               the Rust standard library the main executable
#                           links (scripts/licenses/rust_std.py, from the
#                           toolchain's COPYRIGHT-library and license texts)
#   <resource>/             src-tauri/resources/<resource>/licenses/: notices
#                           for what the app ships that isn't a Rust crate or
#                           a sidecar (the Silero VAD model, built into the
#                           main executable; the local agent's JavaScript, in
#                           Contents/Resources/local-agent/), one folder with
#                           a NOTICES.txt each
#   <sidecar>/              each staged sidecar's .out/licenses/ (sidecars.sh):
#                           every sidecar's build.sh writes a NOTICES.txt, even
#                           one with no third-party code — nothing here writes
#                           a sidecar's notices for it
#   THIRD_PARTY_NOTICES.txt all of the above in one self-contained file
#                           (scripts/licenses/third_party_notices.py), which
#                           Help → Open Source Licenses opens
#
# Callers run it after sidecars_stage and BEFORE signing, so the bundle's
# signature seals the notices like everything else in Contents/.
#
# Requires TAURI_DIR to be set by the caller; sidecars are read from
# SIDECARS_ROOT (sidecars.sh) when set, else $TAURI_DIR/sidecars. The Rust
# target is LICENSES_RUST_TARGET when set, else the host's (what
# `cargo tauri build` builds for). Needs no network: cargo runs --offline.
# bash 3.2 compatible.

LICENSES_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/licenses"

# $1 = Native Intelligence.app, $2 = release (default) | dev.
# Returns non-zero (and leaves no Licenses/ folder) on any failure: a crate,
# the standard library or a sidecar whose notices can't be produced is never
# skipped. The one exception is dev: a staged sidecar whose build wrote no
# NOTICES.txt is left out with a warning, so a dev bundle still gets the rest.
licenses_stage() {
    local app="$1" mode="${2:-release}"
    if [ ! -d "$app/Contents" ]; then
        echo "[licenses] ERROR: $app is not an app bundle" >&2
        return 1
    fi
    licenses_stage_into "$app/Contents/Resources/Licenses" "$mode"
}

# The same notices into any folder: $1 = the Licenses folder to (re)build,
# $2 = release (default) | dev. The Windows workflow stages them here and
# bundles THIRD_PARTY_NOTICES.txt into the installer (LICENSES_RUST_TARGET or
# the host: the runner's own, x86_64-pc-windows-msvc).
licenses_stage_into() {
    local licenses="$1" mode="${2:-release}"
    local dir name target parts="dial8-desktop rust-std"
    local sidecars_root="${SIDECARS_ROOT:-$TAURI_DIR/sidecars}"

    case "$mode" in
        release|dev) ;;
        *) echo "[licenses] ERROR: licenses_stage mode must be release or dev, not '$mode'" >&2; return 1 ;;
    esac
    target="${LICENSES_RUST_TARGET:-$(cd "$TAURI_DIR" && rustc -vV 2>/dev/null | sed -n 's/^host: //p')}"
    if [ -z "$target" ]; then
        echo "[licenses] ERROR: can't tell the Rust target (rustc -vV); set LICENSES_RUST_TARGET" >&2
        return 1
    fi
    rm -rf "$licenses"
    mkdir -p "$licenses" || return 1

    # -B: no __pycache__ in the repo.
    echo "[licenses] Rust crates of the main executable ($target)..."
    if ! python3 -B "$LICENSES_SCRIPTS/rust_crates.py" \
            --manifest-dir "$TAURI_DIR" --package dial8-desktop \
            --target "$target" "$licenses"; then
        rm -rf "$licenses"
        return 1
    fi
    echo "[licenses] Rust standard library ($target)..."
    if ! python3 -B "$LICENSES_SCRIPTS/rust_std.py" \
            --manifest-dir "$TAURI_DIR" --target "$target" "$licenses"; then
        rm -rf "$licenses"
        return 1
    fi

    # Files embedded in the main executable (include_bytes!) that carry their
    # own notices. They are always built in, so a missing NOTICES.txt fails.
    for dir in "$TAURI_DIR"/resources/*/licenses/; do
        [ -d "$dir" ] || continue
        dir="${dir%/}"
        name="$(basename "$(dirname "$dir")")"
        if [ ! -s "$dir/NOTICES.txt" ]; then
            echo "[licenses] ERROR: resources/$name/licenses/ has no NOTICES.txt" >&2
            rm -rf "$licenses"
            return 1
        fi
        cp -RL "$dir" "$licenses/$name" || { rm -rf "$licenses"; return 1; }
        parts="$parts $name"
        echo "[licenses] $name: resources/$name/licenses/"
    done

    # Same rule as sidecars_stage: a sidecar is in the bundle when its
    # .out/bin has something in it. Its notices travel with it.
    for dir in "$sidecars_root"/*/; do
        dir="${dir%/}"
        [ -e "$dir/build.sh" ] || continue
        ls "$dir/.out/bin/"* >/dev/null 2>&1 || continue
        name="$(basename "$dir")"
        if [ ! -s "$dir/.out/licenses/NOTICES.txt" ]; then
            if [ "$mode" = "release" ]; then
                echo "[licenses] ERROR: $name is staged but its build.sh wrote no .out/licenses/NOTICES.txt" >&2
                echo "[licenses]        (every sidecar declares its notices — even 'no third-party code')" >&2
                rm -rf "$licenses"
                return 1
            fi
            echo "[licenses] WARNING: $name is staged but its build.sh wrote no .out/licenses/NOTICES.txt —" >&2
            echo "[licenses]          its notices are missing from this dev build; release.sh would stop here" >&2
            continue
        fi
        # -L: copy what symlinks point at; the bundle gets plain files.
        cp -RL "$dir/.out/licenses" "$licenses/$name" || { rm -rf "$licenses"; return 1; }
        parts="$parts $name"
    done

    # shellcheck disable=SC2086  # $parts is a list of folder names
    if ! python3 -B "$LICENSES_SCRIPTS/third_party_notices.py" "$licenses" $parts; then
        rm -rf "$licenses"
        return 1
    fi
}

# Fail unless the staged notices hold every expected part.
# $1 = Native Intelligence.app, $2... = parts that must be there, each with license texts
# (e.g. dial8-desktop rust-std vad local-stt).
licenses_verify() {
    local app="$1"
    shift
    local licenses="$app/Contents/Resources/Licenses"
    local notices="$licenses/THIRD_PARTY_NOTICES.txt"
    local part ok=0
    if [ ! -s "$notices" ]; then
        echo "[licenses] ERROR: $notices is missing or empty" >&2
        return 1
    fi
    for part in "$@"; do
        if [ ! -s "$licenses/$part/NOTICES.txt" ]; then
            echo "[licenses] ERROR: Licenses/$part/NOTICES.txt is missing or empty" >&2
            ok=1
            continue
        fi
        if [ -z "$(find "$licenses/$part" -type f -size +0 ! -path "$licenses/$part/NOTICES.txt" | head -1)" ]; then
            echo "[licenses] ERROR: Licenses/$part/ has no license texts" >&2
            ok=1
        fi
        # The section heading and at least one Part 2 text heading.
        if ! grep -qxF "$part  (Licenses/$part/)" "$notices" \
                || ! grep -q "^$part/" "$notices"; then
            echo "[licenses] ERROR: THIRD_PARTY_NOTICES.txt has no $part section" >&2
            ok=1
        fi
    done
    return $ok
}

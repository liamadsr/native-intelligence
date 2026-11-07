#!/usr/bin/env bash
# Which Developer ID signs the app: sourced by release.sh, build.sh and dev.sh.
#
# Your own values go in .env.release beside those scripts (gitignored, never
# committed) or in the environment:
#   DIAL8_SIGNING_IDENTITY="<SHA-1 of your Developer ID Application certificate>"
#                         (security find-identity -v -p codesigning lists them)
# The team ID is read from that certificate's name in the keychain. A worktree has
# no .env.release of its own, so the main checkout's is read.
#
# signing_load <scripts folder> sources .env.release, then sets SIGNING_IDENTITY
# (empty when none is set) and TEAM_ID (empty when the certificate isn't in the
# keychain).

signing_load() {
    local dir=$1 common prefix
    if [ -f "$dir/.env.release" ]; then
        source "$dir/.env.release"
    elif common=$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) &&
        prefix=$(git -C "$dir" rev-parse --show-prefix 2>/dev/null) &&
        [ -f "$common/../$prefix.env.release" ]; then
        source "$common/../$prefix.env.release"
    fi
    SIGNING_IDENTITY=${DIAL8_SIGNING_IDENTITY:-}
    TEAM_ID=""
    if [ -n "$SIGNING_IDENTITY" ]; then
        TEAM_ID=$(security find-identity -v -p codesigning 2>/dev/null | grep -F "$SIGNING_IDENTITY" |
            sed -n 's/.*(\([A-Z0-9]\{10\}\))".*/\1/p' | head -1 || true)
    fi
}

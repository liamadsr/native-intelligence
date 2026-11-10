#!/bin/bash
# Secure-timestamp preflight and retries for codesign — sourced by release.sh.
#
# A release signs with `codesign --timestamp`, which has Apple's timestamp
# server (timestamp.apple.com) countersign each signature, so every signing
# step needs the network: Tauri's own signing inside `cargo tauri build`, the
# sidecars, the app and the DMG. When the Mac's DNS or Wi-Fi stalls, the
# request times out after 15 s and codesign fails with "A timestamp was
# expected but was not found." Nothing is wrong with the build or the
# certificate: the same step succeeds once the network answers again (0.2.52
# failed this way twice on 2026-09-28, while DNS stalled on and off for ten
# minutes).
#
#   timestamp_preflight  signs a throwaway binary before anything is built, so
#                        a network problem stops the release at the start
#   timestamp_retry      runs a signing step again after such a failure, and
#                        only after one: a compile error or a bad identity
#                        fails at once
#
# TIMESTAMP_RETRY_WAITS is the seconds to wait before each retry. The default
# "15 30 60 120" makes five attempts over about four minutes.
# bash 3.2 compatible.

TIMESTAMP_RETRY_WAITS="${TIMESTAMP_RETRY_WAITS:-15 30 60 120}"

# What codesign says when the timestamp server didn't answer (Security
# framework errors -67882, -67885, -67889, -67893 and -67896; see
# `security error -67882`). A timestamp that came back rejected or untrusted
# isn't here: waiting won't fix that.
TIMESTAMP_UNAVAILABLE='A timestamp was expected but was not found|The timestamp service is not available|The time source for the Timestamp Authority is not available|The timestamp request cannot be handled due to system failure|A timestamp transaction is waiting'

# Run "$@", showing its output (stderr folded into stdout) as it goes. When it
# fails because the timestamp server didn't answer, wait and run it again;
# any other failure returns at once. Returns the last run's exit status.
# Retry notices go to stderr.
timestamp_retry() {
    local waits=($TIMESTAMP_RETRY_WAITS)
    local attempts=$((${#waits[@]} + 1)) attempt=1 status log
    log="$(mktemp -t ni-timestamp)" || return 1
    while :; do
        # PIPESTATUS[0] is the command's status (the pipeline's is tee's). The
        # || list keeps a failed run from tripping the caller's set -e, even
        # with pipefail.
        { "$@" 2>&1 | tee "$log"; status=${PIPESTATUS[0]}; } || :
        if [ "$status" -eq 0 ] || ! grep -Eq "$TIMESTAMP_UNAVAILABLE" "$log"; then
            break
        fi
        if [ "$attempt" -ge "$attempts" ]; then
            echo "[timestamp] Apple's timestamp server still didn't answer after $attempts attempts." >&2
            echo "[timestamp] This Mac can't reach timestamp.apple.com (usually DNS or Wi-Fi): re-run once it can." >&2
            break
        fi
        echo "[timestamp] Apple's timestamp server didn't answer (attempt $attempt of $attempts). Trying again in ${waits[$((attempt - 1))]}s..." >&2
        sleep "${waits[$((attempt - 1))]}"
        attempt=$((attempt + 1))
    done
    rm -f "$log"
    return "$status"
}

# Sign a throwaway copy of /usr/bin/true the way the release signs Native Intelligence.app
# ($1 = signing identity; hardened runtime, secure timestamp), retrying like
# timestamp_retry, and check the signature got its timestamp. On failure,
# prints codesign's output to stderr and returns non-zero.
timestamp_preflight() {
    local identity="$1" dir status=1
    dir="$(mktemp -d -t ni-timestamp)" || return 1
    if cp /usr/bin/true "$dir/probe" \
        && timestamp_retry codesign --force --options runtime --timestamp \
            --sign "$identity" "$dir/probe" > "$dir/codesign.log" \
        && codesign -dv "$dir/probe" 2>&1 | grep -q '^Timestamp='; then
        status=0
    elif [ -s "$dir/codesign.log" ]; then
        sed 's/^/  codesign: /' "$dir/codesign.log" >&2
    fi
    rm -rf "$dir"
    return "$status"
}

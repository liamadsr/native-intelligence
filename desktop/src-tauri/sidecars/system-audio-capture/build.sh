#!/bin/bash
# Build the system-audio-capture Swift sidecar into .out/bin/ and write its
# notices to .out/licenses/ (sidecar convention: see scripts/sidecars.sh).
# $1 = debug | release.
set -euo pipefail
cd "$(dirname "$0")"

CONFIG="${1:-debug}"

# The notices below say this sidecar contains no third-party code. That holds
# while Package.swift pulls in no packages (Native Intelligence's own Swift and Objective-C,
# linked against macOS's frameworks and Swift runtime only). The moment it
# gains a package or binary dependency, stop: write that dependency's notices
# and license texts into .out/licenses/ here, then update this check.
if grep -Eq '\.(package|binaryTarget)[[:space:]]*\(' Package.swift; then
    echo "[system-audio-capture] ERROR: Package.swift now depends on a package — its notices must be written before it ships:" >&2
    grep -En '\.(package|binaryTarget)[[:space:]]*\(' Package.swift >&2
    echo "[system-audio-capture] Add its NOTICES entry and license texts in build.sh, then update this check." >&2
    exit 1
fi

swift build -c "$CONFIG" 2>&1
BIN_DIR="$(swift build -c "$CONFIG" --show-bin-path)"

mkdir -p .out/bin
cp "$BIN_DIR/system-audio-capture" .out/bin/system-audio-capture

rm -rf .out/licenses
mkdir -p .out/licenses
cat > .out/licenses/NOTICES.txt <<'EOF'
System audio capture (system-audio-capture): no third-party code

Ships as:
  Contents/MacOS/system-audio-capture

This helper program is Native Intelligence's own code (Swift and Objective-C). It includes
no third-party open-source code: it links only macOS's own frameworks and the
Swift runtime that is part of macOS, none of which it copies into the app. So
it has no notices or license texts of its own.
EOF

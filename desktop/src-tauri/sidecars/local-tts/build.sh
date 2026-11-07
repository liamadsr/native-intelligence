#!/bin/bash
# Build the local-tts sidecar (dial8-local-tts) into .out/ — sidecar
# convention: see scripts/sidecars.sh. $1 = debug | release (both build the
# engine optimized: an unoptimized speech model is unusably slow).
#
#   upstream/   VolgaGerm/PocketTTS.cpp git submodule — the commit the
#               superproject records for it IS the pin (release fails on drift)
#   patches/    *.patch applied in order to a copy of upstream (.out/src); the
#               submodule itself stays clean
#   voices/     voices.json + <id>.emb, compiled into the binary
#   .out/deps   pinned, SHA-256-verified dependencies: ONNX Runtime (arm64
#               release archive), SentencePiece (static, macOS 13 target),
#               dr_libs, and Kyutai's pocket-tts licence text
#   .out/src    upstream + patches        .out/gen  the voices as C++ source
#   .out/build  CMake build
#   .out/bin    dial8-local-tts           → Contents/MacOS/
#   .out/lib    libonnxruntime.<v>.dylib  → Contents/Frameworks/
#   .out/tools  dial8-tts-make-voice      (voices/make-voice.sh; never shipped)
#   .out/licenses  NOTICES.txt + license texts → Contents/Resources/Licenses/local-tts/
#
# Dependencies are rebuilt only when a pin or their recipe in this file
# changes (.out/deps/.stamp), the patched source only when upstream's commit
# or patches/ change (.out/src/.stamp), the voices source only when voices/
# changes. Nothing shipped may need a newer macOS than module.json's
# "minMacos" (step 5).
set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"
OUT="$HERE/.out"
DEPS="$OUT/deps"
SRC="$OUT/src"
MIN_MACOS="13.0"
# Our code and SentencePiece target MIN_MACOS. Microsoft's ONNX Runtime build
# targets 13.4 (its LC_BUILD_VERSION minos), so the module needs 13.4+:
# module.json says so ("minMacos"), and step 5 enforces it.
export MACOSX_DEPLOYMENT_TARGET="$MIN_MACOS"

case "${1:-}" in
    debug|release) ;;
    *) echo "usage: $0 <debug|release>" >&2; exit 2 ;;
esac

# ---- pins (UPSTREAM.md) — each verified by SHA-256 ---------------------------
ORT_VERSION="1.23.2"
ORT_URL="https://github.com/microsoft/onnxruntime/releases/download/v$ORT_VERSION/onnxruntime-osx-arm64-$ORT_VERSION.tgz"
ORT_SHA256="b4d513ab2b26f088c66891dbbc1408166708773d7cc4163de7bdca0e9bbb7856"
SPM_COMMIT="31646a467d2051eb904e0b45de3a73e91fe1c1e3"        # v0.2.1
SPM_TREE_SHA256="db38fe54d8223ead365303651c9653b249d5ffbc4b1d2ac8879a9d8a50f69b97"
DRLIBS_COMMIT="dfe8377631000664666519fdb83da193fd8037f4"     # master, 2026-09-01
DRLIBS_TREE_SHA256="330c3a60bb7a3e55faee306c166927ec5704c815039b2777f401a676727c7bbf"
# Kyutai's pocket-tts (MIT; v3.3.0): PocketTTS.cpp ports parts of its Python.
KYUTAI_COMMIT="d299fb6588f0243d29e10d479135d3ef30ccfec3"
KYUTAI_LICENSE_SHA256="23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3"

# Upstream has no Git LFS content we need; never let a missing or broken
# git-lfs fail a checkout.
export GIT_LFS_SKIP_SMUDGE=1
export GIT_CONFIG_COUNT=4
export GIT_CONFIG_KEY_0=filter.lfs.process GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=filter.lfs.smudge  GIT_CONFIG_VALUE_1=cat
export GIT_CONFIG_KEY_2=filter.lfs.clean   GIT_CONFIG_VALUE_2=cat
export GIT_CONFIG_KEY_3=filter.lfs.required GIT_CONFIG_VALUE_3=false

for tool in cmake ninja python3 curl; do
    command -v "$tool" >/dev/null || { echo "[local-tts] missing $tool — brew install cmake ninja (python3 and curl come with macOS)" >&2; exit 1; }
done

fail() {
    echo "[local-tts] ERROR: $*" >&2
    exit 1
}

sha256_of() {
    shasum -a 256 "$1" | cut -c1-64
}

# SHA-256 over every file git tracks in checkout $1 (paths sorted, nested
# submodules skipped): pins a git dependency's content with SHA-256, not
# just its SHA-1 commit id.
tree_sha256() {
    (cd "$1" && git ls-files -s | awk -F'\t' '{ split($1, m, " "); if (m[1] != "160000") print $2 }' \
        | LC_ALL=C sort | while IFS= read -r f; do shasum -a 256 "$f"; done) | shasum -a 256 | cut -c1-64
}

# Shallow checkout of commit $2 of repo $1 into $3, verified against tree
# hash $4.
git_pinned() {
    rm -rf "$3"
    git init -q "$3"
    git -C "$3" fetch -q --depth 1 "$1" "$2"
    git -C "$3" checkout -q FETCH_HEAD
    local got
    got="$(tree_sha256 "$3")"
    [ "$got" = "$4" ] || fail "$1 @ ${2:0:9}: tree SHA-256 $got, expected $4"
}

# ---- 1. upstream submodule -----------------------------------------------------
if [ ! -f upstream/pocket_tts.cpp ]; then
    git -C "$HERE/../../.." submodule update --init src-tauri/sidecars/local-tts/upstream
fi
UPSTREAM_SHA="$(git -C upstream rev-parse HEAD)"
# The pin is the gitlink the superproject has committed; a checkout that has
# drifted from it (a stray checkout in upstream/) must not ship. A bump
# builds before committing: SIDECAR_ALLOW_UNPINNED=1 makes this a warning.
PINNED_SHA="$(git -C "$HERE/../../.." ls-tree HEAD src-tauri/sidecars/local-tts/upstream | awk '$2 == "commit" { print $3 }')"
if [ "$UPSTREAM_SHA" != "$PINNED_SHA" ]; then
    DRIFT="upstream/ is at ${UPSTREAM_SHA:0:9}, but the committed pin is ${PINNED_SHA:-missing} — run git submodule update src-tauri/sidecars/local-tts/upstream, or commit the bump"
    if [ "$1" = release ] && [ "${SIDECAR_ALLOW_UNPINNED:-}" != 1 ]; then
        fail "$DRIFT"
    fi
    echo "[local-tts] WARNING: $DRIFT" >&2
fi
PATCH_HASH="$( (cat patches/*.patch 2>/dev/null || true) | shasum -a 256 | cut -c1-16)"

# ---- 2. dependencies (.out/deps) ------------------------------------------------
# The recipe (the helpers above and this step) is part of the stamp, so a
# changed build flag here rebuilds the dependencies, not just a changed pin.
DEPS_RECIPE="$(sed -n -e '/^sha256_of()/,/^# ---- 1\./p' -e '/^# ---- 2\./,/^# ---- 3\./p' "$HERE/build.sh" | shasum -a 256 | cut -c1-16)"
DEPS_STAMP="$ORT_SHA256-$SPM_COMMIT-$SPM_TREE_SHA256-$DRLIBS_COMMIT-$DRLIBS_TREE_SHA256-$KYUTAI_LICENSE_SHA256-$MIN_MACOS-$DEPS_RECIPE"
if [ "$(cat "$DEPS/.stamp" 2>/dev/null || true)" != "$DEPS_STAMP" ]; then
    echo "[local-tts] fetching and building pinned dependencies..."
    rm -rf "$DEPS"
    mkdir -p "$DEPS" "$OUT/downloads"

    # ONNX Runtime: Microsoft's arm64 release archive (the download is kept
    # in .out/downloads across rebuilds).
    ORT_TGZ="$OUT/downloads/$(basename "$ORT_URL")"
    if [ ! -f "$ORT_TGZ" ] || [ "$(sha256_of "$ORT_TGZ")" != "$ORT_SHA256" ]; then
        curl -fL --retry 3 -o "$ORT_TGZ.part" "$ORT_URL"
        mv "$ORT_TGZ.part" "$ORT_TGZ"
    fi
    [ "$(sha256_of "$ORT_TGZ")" = "$ORT_SHA256" ] || fail "$ORT_TGZ: SHA-256 $(sha256_of "$ORT_TGZ"), expected $ORT_SHA256"
    tar -xzf "$ORT_TGZ" -C "$DEPS"
    mv "$DEPS/onnxruntime-osx-arm64-$ORT_VERSION" "$DEPS/onnxruntime"
    [ -f "$DEPS/onnxruntime/lib/libonnxruntime.$ORT_VERSION.dylib" ] || fail "no libonnxruntime.$ORT_VERSION.dylib in $ORT_URL"

    # SentencePiece as a static archive with its bundled protobuf-lite and
    # abseil subset (SPM_*_PROVIDER=internal), so nothing from Homebrew ships.
    SPM_SRC="$DEPS/sentencepiece-src"
    echo "[local-tts] building static SentencePiece @ ${SPM_COMMIT:0:9}..."
    git_pinned https://github.com/google/sentencepiece.git "$SPM_COMMIT" "$SPM_SRC" "$SPM_TREE_SHA256"
    cmake -G Ninja -S "$SPM_SRC" -B "$DEPS/sentencepiece-build" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_OSX_ARCHITECTURES=arm64 \
        -DSPM_BUILD_TEST=OFF \
        -DSPM_ENABLE_SHARED=OFF \
        -DSPM_ENABLE_TCMALLOC=OFF \
        -DSPM_PROTOBUF_PROVIDER=internal \
        -DSPM_ABSL_PROVIDER=internal \
        -Wno-dev >/dev/null
    cmake --build "$DEPS/sentencepiece-build" --target sentencepiece-static
    mkdir -p "$DEPS/sentencepiece/lib" "$DEPS/sentencepiece/include"
    cp "$DEPS/sentencepiece-build/src/libsentencepiece.a" "$DEPS/sentencepiece/lib/"
    cp "$SPM_SRC/src/sentencepiece_processor.h" "$DEPS/sentencepiece/include/"

    # dr_libs (header-only: dr_wav, dr_mp3, dr_flac).
    git_pinned https://github.com/mackron/dr_libs.git "$DRLIBS_COMMIT" "$DEPS/dr_libs" "$DRLIBS_TREE_SHA256"

    # Kyutai's pocket-tts licence text (their repo is Python + weights; we
    # need only this file).
    curl -fsSL --retry 3 -o "$DEPS/pocket-tts-LICENSE" \
        "https://raw.githubusercontent.com/kyutai-labs/pocket-tts/$KYUTAI_COMMIT/LICENSE"
    [ "$(sha256_of "$DEPS/pocket-tts-LICENSE")" = "$KYUTAI_LICENSE_SHA256" ] || fail "kyutai-labs/pocket-tts LICENSE changed"

    echo "$DEPS_STAMP" > "$DEPS/.stamp"
fi

# ---- 3. upstream + patches (.out/src) ----------------------------------------
SRC_STAMP="$UPSTREAM_SHA-$PATCH_HASH"
if [ "$(cat "$SRC/.stamp" 2>/dev/null || true)" != "$SRC_STAMP" ]; then
    echo "[local-tts] PocketTTS.cpp @ ${UPSTREAM_SHA:0:9} + patches..."
    rm -rf "$SRC"
    mkdir -p "$SRC"
    # The committed files at the pin, whatever the submodule's working tree
    # holds; a throwaway repo so `git apply` is strict (no fuzz).
    git -C upstream archive HEAD pocket_tts.cpp LICENSE | tar -x -C "$SRC"
    git -C "$SRC" init -q
    # Each patch must apply cleanly to upstream + the patches before it. One
    # that applies in reverse is already upstream (drop it); one that does
    # neither needs refreshing after the bump.
    for p in patches/*.patch; do
        [ -f "$p" ] || continue
        if git -C "$SRC" apply --whitespace=nowarn --check "$HERE/$p" 2>/dev/null; then
            git -C "$SRC" apply --whitespace=nowarn "$HERE/$p"
            echo "[local-tts] applied $p"
        elif git -C "$SRC" apply --whitespace=nowarn --reverse --check "$HERE/$p" 2>/dev/null; then
            fail "$p is already in upstream @ ${UPSTREAM_SHA:0:9} — drop it (and note it in UPSTREAM.md)"
        else
            fail "$p no longer applies to upstream @ ${UPSTREAM_SHA:0:9} — refresh it (or drop it if upstream merged the change)"
        fi
    done
    echo "$SRC_STAMP" > "$SRC/.stamp"
fi

# ---- 4. build: the dev tool first (voices/make-voice.sh needs it to make the
#         voices the sidecar embeds), then the voices source, then the sidecar -
cmake -S . -B "$OUT/build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$MIN_MACOS" \
    -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DPTT_SOURCE_DIR="$SRC" \
    -DORT_ROOT="$DEPS/onnxruntime" \
    -DORT_VERSION="$ORT_VERSION" \
    -DSPM_ROOT="$DEPS/sentencepiece" \
    -DDR_LIBS_DIR="$DEPS/dr_libs" \
    -DVOICES_SOURCE="$OUT/gen/voices_data.cpp" \
    -DPTT_UPSTREAM_SHA="${UPSTREAM_SHA:0:7}" >/dev/null
# ld warns that libonnxruntime targets macOS 13.4, newer than our 13.0: known,
# and bounded by the minMacos check in step 5.
build() {
    cmake --build "$OUT/build" "$@" || fail "build failed"
}
build --target dial8-tts-make-voice
rm -rf "$OUT/tools"
mkdir -p "$OUT/tools"
cp "$OUT/build/dial8-tts-make-voice" "$OUT/tools/"

mkdir -p "$OUT/gen"
python3 -B voices/catalogue.py check voices
python3 -B voices/catalogue.py embed voices "$OUT/gen/voices_data.cpp"
build

# ---- 5. stage: the binary plus exactly the dylibs it loads -------------------------
# (walked with otool, so a change in ONNX Runtime's layout needs no edit here)
rm -rf "$OUT/bin" "$OUT/lib"
mkdir -p "$OUT/bin" "$OUT/lib"
cp "$OUT/build/dial8-local-tts" "$OUT/bin/"

queue=("$OUT/bin/dial8-local-tts")
while [ ${#queue[@]} -gt 0 ]; do
    image="${queue[0]}"
    queue=("${queue[@]:1}")
    while IFS= read -r dep; do
        case "$dep" in
            @rpath/*)
                name="${dep#@rpath/}"
                [ -f "$OUT/lib/$name" ] && continue
                src="$DEPS/onnxruntime/lib/$name"
                [ -e "$src" ] || fail "$name (needed by $(basename "$image")) not in $DEPS/onnxruntime/lib"
                cp -L "$src" "$OUT/lib/$name"
                chmod u+w "$OUT/lib/$name"
                queue+=("$OUT/lib/$name")
                ;;
            /usr/lib/*|/System/*) ;;
            *) fail "$(basename "$image") links $dep — only system libraries and our own dylibs may ship" ;;
        esac
    done < <(otool -L "$image" | tail -n +2 | awk '{print $1}' | grep -v "^@rpath/$(basename "$image")\$" || true)
done
# Build-tree rpaths would leak build-machine paths; the dylibs resolve @rpath
# through the executable's (Frameworks/ or lib/). ONNX Runtime ships only
# @loader_path, which is harmless, so its (Microsoft) signature stays intact.
for lib in "$OUT/lib/"*.dylib; do
    for rp in $(otool -l "$lib" | awk '/LC_RPATH/{getline; getline; print $2}'); do
        case "$rp" in
            @loader_path*|@executable_path*) ;;
            *) install_name_tool -delete_rpath "$rp" "$lib" 2>/dev/null && codesign --force --sign - "$lib" 2>/dev/null || true ;;
        esac
    done
done
[ "$(ls "$OUT/lib" | wc -l | tr -d ' ')" = 1 ] || fail "expected exactly libonnxruntime in .out/lib, got: $(ls "$OUT/lib" | tr '\n' ' ')"

# Minimum macOS: nothing shipped may need a newer macOS than module.json's
# "minMacos" (the app shows the module as unavailable below it), and our own
# code stays at MIN_MACOS.
MODULE_MIN_MACOS="$(python3 -c 'import json; print(json.load(open("module.json")).get("minMacos", ""))')"
[[ "$MODULE_MIN_MACOS" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || fail "module.json has no valid \"minMacos\" (got '$MODULE_MIN_MACOS')"
# The macOS a Mach-O needs (LC_BUILD_VERSION minos, or the older
# LC_VERSION_MIN_MACOSX).
minos_of() {
    otool -l "$1" | awk '/cmd LC_BUILD_VERSION/ { b = 1 } b && $1 == "minos" { print $2; exit }
                         /cmd LC_VERSION_MIN_MACOSX/ { v = 1 } v && $1 == "version" { print $2; exit }'
}
# Succeeds when version $1 is newer than version $2.
version_newer() {
    awk -v a="$1" -v b="$2" 'BEGIN { split(a, x, "."); split(b, y, ".")
        for (i = 1; i <= 3; i++) if (x[i] + 0 != y[i] + 0) exit !(x[i] + 0 > y[i] + 0)
        exit 1 }'
}
for image in "$OUT/bin/"* "$OUT/lib/"*.dylib; do
    minos="$(minos_of "$image")"
    [ -n "$minos" ] || fail "$(basename "$image") names no minimum macOS"
    if version_newer "$minos" "$MODULE_MIN_MACOS"; then
        fail "$(basename "$image") needs macOS $minos, newer than module.json's minMacos $MODULE_MIN_MACOS"
    fi
done
[ "$(minos_of "$OUT/bin/dial8-local-tts")" = "$MIN_MACOS" ] || fail "dial8-local-tts targets macOS $(minos_of "$OUT/bin/dial8-local-tts"), not $MIN_MACOS"

# ---- 6. third-party notices → .out/licenses/ (scripts/sidecars.sh) ----------------
# NOTICES.txt names every third-party component compiled into .out/bin +
# .out/lib (and the voices compiled in) and points at its full license text,
# copied here from the pinned sources this build used. A missing text or
# attribution fails the build, like the otool guard above. The component list
# is the build graph at the pinned commits — recheck it on a bump (UPSTREAM.md).
LIC="$OUT/licenses"
ORT="$DEPS/onnxruntime"
SPM_SRC="$DEPS/sentencepiece-src"
rm -rf "$LIC"
mkdir -p "$LIC"

# Copy license text $1 to .out/licenses/$2.
license_copy() {
    [ -s "$1" ] || fail "license text missing: ${1#"$HERE"/}"
    mkdir -p "$(dirname "$LIC/$2")"
    cp "$1" "$LIC/$2"
}

# First match of extended regex $2 in $1 (a file or folder). Nothing found
# means an attribution moved or changed upstream, so the notices need a look.
# Call as VAR="$(notice_line ...)" so a failure stops the build (set -e).
notice_line() {
    local line
    line="$( (grep -rhoE "$2" "$1" 2>/dev/null || true) | awk 'NR == 1')"
    [ -n "$line" ] || fail "no '$2' in ${1#"$HERE"/} — recheck the notices in build.sh step 6"
    echo "$line"
}

# What SentencePiece's static archive actually holds: its own objects plus
# protobuf-lite (sources) and abseil's flag.cc; darts-clone is a header its
# sources include. If that changes, so must the list below.
SPM_MEMBERS="$(ar -t "$DEPS/sentencepiece/lib/libsentencepiece.a")"
for member in sentencepiece_processor.cc.o arena.cc.o message_lite.cc.o flag.cc.o; do
    echo "$SPM_MEMBERS" | grep -qx "$member" || fail "libsentencepiece.a has no $member — recheck its bundled components"
done
[ "$(echo "$SPM_MEMBERS" | grep -c 'esaxx\|trainer')" = 0 ] || fail "libsentencepiece.a now has trainer code — recheck its bundled components"
grep -q 'third_party/darts_clone/darts.h' "$SPM_SRC/src/normalizer.h" || fail "SentencePiece no longer includes darts-clone — recheck its notice"

license_copy "$SRC/LICENSE"                                   PocketTTS.cpp/LICENSE
license_copy "$DEPS/pocket-tts-LICENSE"                       pocket-tts/LICENSE
license_copy "$ORT/LICENSE"                                   onnxruntime/LICENSE
license_copy "$ORT/ThirdPartyNotices.txt"                     onnxruntime/ThirdPartyNotices.txt
license_copy "$SPM_SRC/LICENSE"                               sentencepiece/LICENSE
license_copy "$SPM_SRC/third_party/absl/LICENSE"              abseil/LICENSE
license_copy "$SPM_SRC/third_party/protobuf-lite/LICENSE"     protobuf-lite/LICENSE
license_copy "$SPM_SRC/third_party/darts_clone/LICENSE"       darts-clone/LICENSE
license_copy "$DEPS/dr_libs/LICENSE"                          dr_libs/LICENSE

PTT_COPYRIGHT="$(notice_line "$SRC/LICENSE" '^Copyright .*')"
ORT_COPYRIGHT="$(notice_line "$ORT/LICENSE" '^Copyright .*')"
SPM_COPYRIGHT="$(notice_line "$SPM_SRC/src/sentencepiece_processor.h" 'Copyright [0-9]+ Google Inc\.')"
ABSL_COPYRIGHT="$(notice_line "$SPM_SRC/third_party/absl" 'Copyright [0-9]+ The Abseil Authors\.')"
ABSL_GOOGLE_COPYRIGHT="$(notice_line "$SPM_SRC/third_party/absl/flags/flag.cc" 'Copyright [0-9]+ Google Inc\.')"
PROTOBUF_COPYRIGHT="$(notice_line "$SPM_SRC/third_party/protobuf-lite/LICENSE" '^Copyright .*')"
DARTS_COPYRIGHT="$(notice_line "$SPM_SRC/third_party/darts_clone/LICENSE" '^Copyright .*')"
DRLIBS_COPYRIGHT="$(notice_line "$DEPS/dr_libs/LICENSE" '^Copyright .*')"
# dr_mp3 is based on minimp3, which its header says is CC0.
notice_line "$DEPS/dr_libs/dr_mp3.h" 'Based on minimp3' >/dev/null
notice_line "$DEPS/dr_libs/dr_mp3.h" 'creativecommons.org/publicdomain/zero/1.0' >/dev/null
# Kyutai's text is MIT without a copyright line; make sure it is still MIT.
notice_line "$DEPS/pocket-tts-LICENSE" '^Permission is hereby granted, free of charge' >/dev/null

# Versions are informational: a blank one never fails the build.
ORT_COMMIT="$(cat "$ORT/GIT_COMMIT_ID" 2>/dev/null || true)"
SPM_VERSION="$(cat "$SPM_SRC/VERSION.txt" 2>/dev/null || true)"
PROTOBUF_VERSION="$( (sed -nE 's/^#define GOOGLE_PROTOBUF_VERSION ([0-9]+).*/\1/p' "$SPM_SRC/third_party/protobuf-lite/google/protobuf/stubs/common.h" \
    | awk '{ printf "%d.%d.%d", $1 / 1000000, ($1 / 1000) % 1000, $1 % 1000 }') 2>/dev/null || true)"
DARTS_VERSION="$(sed -nE 's/^#define DARTS_VERSION "(.*)"/\1/p' "$SPM_SRC/third_party/darts_clone/darts.h" 2>/dev/null || true)"
DRLIBS_VERSIONS="$(for h in dr_wav dr_mp3 dr_flac; do sed -nE "s/^($h) - (v[0-9.]+).*/\1 \2/p" "$DEPS/dr_libs/$h.h" | head -1; done | paste -sd, - | sed 's/,/, /g')"

SHIPS="$(
    for f in "$OUT/bin/"*; do echo "  Contents/MacOS/$(basename "$f")"; done
    for f in "$OUT/lib/"*.dylib; do echo "  Contents/Frameworks/$(basename "$f")"; done
)"
PATCHED=""
for p in patches/*.patch; do
    [ -f "$p" ] || continue
    PATCHED="$PATCHED
    $(basename "$p")"
done

# The models are not part of the app: when read-aloud is turned on, the app
# downloads them from Hugging Face at the pinned URLs in module.json, so Dial8
# does not redistribute them. The notice still names each with its license.
# Every "url" in module.json must be a file in a Hugging Face repo that has an
# entry here, or the build fails.
model_notice() {
    case "$1" in
        KevinAHM/pocket-tts-onnx)
            echo "  Pocket TTS, ONNX export (text-to-speech; english_2026-04 bundle)"
            echo "    https://huggingface.co/$1"
            echo "    Exported to ONNX by KevinAHM from Kyutai's Pocket TTS weights"
            echo "    License: Creative Commons Attribution 4.0 International (CC BY 4.0)"
            echo "    https://creativecommons.org/licenses/by/4.0/"
            echo
            echo "  Pocket TTS (the model weights the export is made from)"
            echo "    https://huggingface.co/kyutai/pocket-tts"
            echo "    By Kyutai"
            echo "    License: Creative Commons Attribution 4.0 International (CC BY 4.0)"
            echo "    https://creativecommons.org/licenses/by/4.0/"
            ;;
        *)
            return 1
            ;;
    esac
}
# Every "url" value, one per line; a count that doesn't match the "url" keys
# means module.json's layout changed and this read can't be trusted.
MODEL_URLS="$(sed -nE 's/.*"url"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' module.json)"
URL_KEYS="$(grep -o '"url"' module.json | wc -l | tr -d ' ')"
URL_VALUES="$(echo "$MODEL_URLS" | grep -c . || true)"
if [ "$URL_KEYS" = 0 ] || [ "$URL_KEYS" != "$URL_VALUES" ]; then
    fail "read $URL_VALUES of $URL_KEYS \"url\" values in module.json — keep one \"url\": \"https://...\" per line"
fi
MODEL_REPOS=""
while IFS= read -r url; do
    repo="$(echo "$url" | sed -nE 's|^https://huggingface\.co/([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)/resolve/[0-9a-f]{40}/.+$|\1|p')"
    [ -n "$repo" ] || fail "module.json downloads $url, which is not a file in a Hugging Face repo at a pinned commit"
    model_notice "$repo" >/dev/null || fail "module.json downloads from $repo, which has no license entry in build.sh's model_notice"
    case " $MODEL_REPOS " in
        *" $repo "*) ;;
        *) MODEL_REPOS="$MODEL_REPOS $repo" ;;
    esac
done <<< "$MODEL_URLS"
MODELS="$(for repo in $MODEL_REPOS; do echo; model_notice "$repo"; done)"
VOICES="$(python3 -B voices/catalogue.py notices voices)"

cat > "$LIC/NOTICES.txt" <<EOF
Local text-to-speech (local-tts)

Ships as:
$SHIPS

These files contain the open-source components below. License paths are
relative to this module's license folder.

PocketTTS.cpp, commit ${UPSTREAM_SHA:0:12}
  https://github.com/VolgaGerm/PocketTTS.cpp
  $PTT_COPYRIGHT
  License: MIT (PocketTTS.cpp/LICENSE)
  In dial8-local-tts, with Dial8's changes (patches):$PATCHED

Pocket TTS by Kyutai (the Python implementation PocketTTS.cpp ports), v3.3.0,
commit ${KYUTAI_COMMIT:0:12}
  https://github.com/kyutai-labs/pocket-tts
  License: MIT (pocket-tts/LICENSE)

ONNX Runtime $ORT_VERSION, commit ${ORT_COMMIT:0:12}
  https://github.com/microsoft/onnxruntime
  $ORT_COPYRIGHT
  License: MIT (onnxruntime/LICENSE)
  libonnxruntime, Microsoft's macOS arm64 release build. Its third-party
  notices are included verbatim (onnxruntime/ThirdPartyNotices.txt).

SentencePiece ${SPM_VERSION}, commit ${SPM_COMMIT:0:12}
  https://github.com/google/sentencepiece
  $SPM_COPYRIGHT
  License: Apache License 2.0 (sentencepiece/LICENSE)
  Statically linked into dial8-local-tts, with the three components below
  that SentencePiece bundles.

Abseil (the subset bundled with SentencePiece)
  https://github.com/abseil/abseil-cpp
  $ABSL_COPYRIGHT
  $ABSL_GOOGLE_COPYRIGHT
  License: Apache License 2.0 (abseil/LICENSE)

Protocol Buffers ${PROTOBUF_VERSION} (protobuf-lite, bundled with SentencePiece)
  https://github.com/protocolbuffers/protobuf
  $PROTOBUF_COPYRIGHT
  License: BSD 3-Clause (protobuf-lite/LICENSE)

Darts-clone ${DARTS_VERSION} (bundled with SentencePiece)
  https://github.com/s-yata/darts-clone
  $DARTS_COPYRIGHT
  License: BSD 3-Clause (darts-clone/LICENSE)

dr_libs (${DRLIBS_VERSIONS}), commit ${DRLIBS_COMMIT:0:12}
  https://github.com/mackron/dr_libs
  $DRLIBS_COPYRIGHT
  License: public domain (Unlicense) or MIT No Attribution, at your choice
  (dr_libs/LICENSE). dr_mp3 is based on minimp3 by lieff
  (https://github.com/lieff/minimp3), dedicated to the public domain under
  CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/).

Voices (compiled into dial8-local-tts)
$VOICES

Speech models (downloaded from Hugging Face, not redistributed by Dial8)

  The speech models are not part of this app, and Dial8 does not
  redistribute them. When read-aloud is turned on, the app downloads them
  directly from Hugging Face onto this Mac. Their own licenses, linked
  below, govern them.
$MODELS
EOF

echo "[local-tts] built $(du -sh "$OUT/bin" "$OUT/lib" | awk '{print $1}' | paste -sd+ -) → .out/bin, .out/lib, .out/licenses"

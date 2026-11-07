#!/bin/bash
# Build the local-stt sidecar (dial8-local-stt) into .out/ — sidecar
# convention: see scripts/sidecars.sh. $1 = debug | release (both build the
# upstream engine optimized: an unoptimized speech model is unusably slow).
#
#   upstream/   NVIDIA/NeMo-Speech.cpp git submodule — its commit IS the pin
#   patches/    optional *.patch applied to upstream before building
#   .out/deps   static SentencePiece (upstream's pinned commit, macOS 13 target)
#   .out/sdk    upstream installed as an SDK (headers, dylibs, CMake package)
#   .out/build  our wrapper's CMake build
#   .out/bin    dial8-local-stt           → Contents/MacOS/
#   .out/lib    the dylibs it loads       → Contents/Frameworks/
#   .out/licenses  NOTICES.txt + license texts → Contents/Resources/Licenses/local-stt/
#
# Upstream is rebuilt only when its commit or patches change (.out/sdk/.stamp).
set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"
OUT="$HERE/.out"
SDK="$OUT/sdk"
MIN_MACOS="13.0"
# Every CMake project below (and the SentencePiece build) targets MIN_MACOS.
export MACOSX_DEPLOYMENT_TARGET="$MIN_MACOS"
# CPU baseline = every Apple Silicon Mac (M1 has dotprod + fp16, no i8mm). The
# default "native" would tune for the build machine and can SIGILL on an M1.
# GPU (Metal) kernels are compiled at runtime per machine, so they're portable.
CPU_ARCH="armv8.2-a+dotprod+fp16"
DEPS="$OUT/deps"

# Upstream keeps Mandarin TTS data in Git LFS, which we never build. Skip LFS
# entirely (a missing or broken git-lfs must not fail the checkout).
export GIT_LFS_SKIP_SMUDGE=1
export GIT_CONFIG_COUNT=4
export GIT_CONFIG_KEY_0=filter.lfs.process GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=filter.lfs.smudge  GIT_CONFIG_VALUE_1=cat
export GIT_CONFIG_KEY_2=filter.lfs.clean   GIT_CONFIG_VALUE_2=cat
export GIT_CONFIG_KEY_3=filter.lfs.required GIT_CONFIG_VALUE_3=false

for tool in cmake ninja; do
    command -v "$tool" >/dev/null || { echo "[local-stt] missing $tool — brew install cmake ninja sentencepiece abseil" >&2; exit 1; }
done

# 1. Submodules: upstream, then the two of its own the ASR build needs.
if [ ! -f upstream/CMakeLists.txt ]; then
    git -C "$HERE/../../.." submodule update --init src-tauri/sidecars/local-stt/upstream
fi
if [ ! -f upstream/ggml/CMakeLists.txt ] || [ ! -f upstream/llama.cpp/vendor/nlohmann/json.hpp ]; then
    git -C upstream submodule update --init --depth 1 ggml llama.cpp
fi

UPSTREAM_SHA="$(git -C upstream rev-parse HEAD)"
PATCH_HASH="$( (cat patches/*.patch 2>/dev/null || true) | shasum -a 256 | cut -c1-16)"
# Upstream pins the SentencePiece commit in its own static-build script.
SPM_COMMIT="$(sed -n 's/^COMMIT=\([0-9a-f]*\).*/\1/p' upstream/scripts/build_sentencepiece_static.sh)"
[ -n "$SPM_COMMIT" ] || { echo "[local-stt] could not read the SentencePiece pin from upstream" >&2; exit 1; }
STAMP="$UPSTREAM_SHA-$PATCH_HASH-$SPM_COMMIT-$MIN_MACOS-$CPU_ARCH"

# 2a. SentencePiece as a static archive with its bundled abseil/protobuf-lite,
#     so libnemo_speech_asr depends on nothing outside the app. (Linking the
#     Homebrew copy would ship /opt/homebrew paths and ~40 abseil dylibs built
#     for the build machine's macOS.)
if [ "$(cat "$DEPS/.stamp" 2>/dev/null || true)" != "$SPM_COMMIT-$MIN_MACOS" ]; then
    echo "[local-stt] building static SentencePiece @ ${SPM_COMMIT:0:9}..."
    rm -rf "$DEPS"
    SPM_SRC="$DEPS/sentencepiece-src"
    git init -q "$SPM_SRC"
    git -C "$SPM_SRC" fetch -q --depth 1 https://github.com/google/sentencepiece.git "$SPM_COMMIT"
    git -C "$SPM_SRC" checkout -q FETCH_HEAD
    cmake -G Ninja -S "$SPM_SRC" -B "$DEPS/sentencepiece-build" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_OSX_ARCHITECTURES=arm64 \
        -DSPM_BUILD_TEST=OFF \
        -DSPM_ENABLE_SHARED=OFF \
        -DSPM_ENABLE_TCMALLOC=OFF >/dev/null
    cmake --build "$DEPS/sentencepiece-build" --target sentencepiece-static
    mkdir -p "$DEPS/sentencepiece/lib" "$DEPS/sentencepiece/include" "$DEPS/sentencepiece/licenses"
    cp "$DEPS/sentencepiece-build/src/libsentencepiece.a" "$DEPS/sentencepiece/lib/"
    cp "$SPM_SRC/src/sentencepiece_processor.h" "$DEPS/sentencepiece/include/"
    cp "$SPM_SRC/LICENSE" "$DEPS/sentencepiece/licenses/sentencepiece-LICENSE"
    echo "$SPM_COMMIT-$MIN_MACOS" > "$DEPS/.stamp"
fi

# 2b. Upstream → .out/sdk (skipped when the stamp matches).
if [ "$(cat "$SDK/.stamp" 2>/dev/null || true)" != "$STAMP" ]; then
    echo "[local-stt] building NeMo-Speech.cpp @ ${UPSTREAM_SHA:0:9} (a few minutes the first time)..."
    # Each patch must apply cleanly or already be applied — a patch that no
    # longer fits after an upstream bump fails the build instead of silently
    # shipping without it.
    for p in patches/*.patch; do
        [ -f "$p" ] || continue
        if git -C upstream apply --check "$HERE/$p" 2>/dev/null; then
            git -C upstream apply "$HERE/$p"
            echo "[local-stt] applied $p"
        elif git -C upstream apply --reverse --check "$HERE/$p" 2>/dev/null; then
            echo "[local-stt] $p already applied"
        else
            echo "[local-stt] ERROR: $p no longer applies to upstream @ ${UPSTREAM_SHA:0:9} — refresh it (or drop it if upstream merged the change)" >&2
            exit 1
        fi
    done
    rm -rf "$SDK"
    (
        cd upstream
        scripts/configure.sh metal-asr \
            -DNEMO_SPEECH_BUILD_CLI=OFF \
            -DNEMO_SPEECH_BUILD_MIC_CAPTURE=OFF \
            -DCMAKE_OSX_DEPLOYMENT_TARGET="$MIN_MACOS" \
            -DCMAKE_OSX_ARCHITECTURES=arm64 \
            -DGGML_NATIVE=OFF \
            -DGGML_CPU_ARM_ARCH="$CPU_ARCH" \
            -DSENTENCEPIECE_LIB="$DEPS/sentencepiece/lib/libsentencepiece.a" \
            -DSENTENCEPIECE_INCLUDE_DIR="$DEPS/sentencepiece/include" \
            -DCMAKE_DISABLE_FIND_PACKAGE_unofficial-sentencepiece=ON \
            -DCMAKE_DISABLE_FIND_PACKAGE_absl=ON
        cmake --build --preset metal-asr
        cmake --install build/metal-asr --prefix "$SDK"
    )
    echo "$STAMP" > "$SDK/.stamp"
fi

# 3. Our wrapper.
cmake -S . -B "$OUT/build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_PREFIX_PATH="$SDK" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$MIN_MACOS" \
    -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DNEMO_UPSTREAM_SHA="${UPSTREAM_SHA:0:9}" >/dev/null
cmake --build "$OUT/build"

# 4. Stage the binary plus exactly the dylibs it loads (walked with otool, so
#    an upstream change in library layout needs no edit here).
rm -rf "$OUT/bin" "$OUT/lib"
mkdir -p "$OUT/bin" "$OUT/lib"
cp "$OUT/build/dial8-local-stt" "$OUT/bin/"

queue=("$OUT/bin/dial8-local-stt")
while [ ${#queue[@]} -gt 0 ]; do
    image="${queue[0]}"
    queue=("${queue[@]:1}")
    while IFS= read -r dep; do
        case "$dep" in
            @rpath/*)
                name="${dep#@rpath/}"
                [ -f "$OUT/lib/$name" ] && continue
                src="$SDK/lib/$name"
                if [ ! -e "$src" ]; then
                    echo "[local-stt] ERROR: $name (needed by $(basename "$image")) not in $SDK/lib" >&2
                    exit 1
                fi
                cp -L "$src" "$OUT/lib/$name"
                chmod u+w "$OUT/lib/$name"
                queue+=("$OUT/lib/$name")
                ;;
            /usr/lib/*|/System/*) ;;
            *)
                echo "[local-stt] ERROR: $(basename "$image") links $dep — only system libraries and our own dylibs may ship" >&2
                exit 1
                ;;
        esac
    done < <(otool -L "$image" | tail -n +2 | awk '{print $1}' | grep -v "^$(basename "$image")\$" || true)
done

# The dylibs carry rpaths from the upstream build tree; they resolve @rpath
# through the executable's run-path stack (Frameworks/ or lib/) instead.
for lib in "$OUT/lib/"*.dylib; do
    for rp in $(otool -l "$lib" | awk '/LC_RPATH/{getline; getline; print $2}'); do
        install_name_tool -delete_rpath "$rp" "$lib" 2>/dev/null || true
    done
done

# 5. Third-party notices → .out/licenses/ (sidecar convention, see
#    scripts/sidecars.sh): NOTICES.txt names every third-party component
#    compiled into .out/bin + .out/lib and points at its full license text,
#    copied here from the checkouts this build compiled. A missing text or
#    attribution fails the build, like the otool guard above. The component
#    list is the build graph at the pinned commits (metal-asr, ASR only, no
#    CLI/HTTP/gRPC/TTS/NMT) — recheck it on a bump (UPSTREAM.md).
LIC="$OUT/licenses"
SDK_LICENSES="$SDK/share/licenses/nemo-speech"
SPM_SRC="$DEPS/sentencepiece-src"
JSON_HPP="upstream/llama.cpp/vendor/nlohmann/json.hpp"
rm -rf "$LIC"
mkdir -p "$LIC"

# Copy license text $1 to .out/licenses/$2.
license_copy() {
    if [ ! -s "$1" ]; then
        echo "[local-stt] ERROR: license text missing: ${1#"$HERE"/}" >&2
        exit 1
    fi
    mkdir -p "$(dirname "$LIC/$2")"
    cp "$1" "$LIC/$2"
}

# Derived code whose license has no file of its own on disk (it arrives as a
# header comment inside ggml / NeMo-Speech.cpp sources): ggml's LICENSE, the
# stock MIT text, with ggml's copyright line swapped for the component's.
# $1 = destination under .out/licenses, $2... = copyright lines.
license_mit() {
    local out="$1" template="$LIC/ggml/LICENSE"
    shift
    if [ "$(head -n 1 "$template")" != "MIT License" ] || [ "$(grep -c '^Copyright ' "$template")" != "1" ]; then
        echo "[local-stt] ERROR: ggml/LICENSE is no longer the stock MIT text — fix license_mit in build.sh" >&2
        exit 1
    fi
    mkdir -p "$(dirname "$LIC/$out")"
    COPYRIGHT="$(printf '%s\n' "$@")" \
        awk '/^Copyright /{ print ENVIRON["COPYRIGHT"]; next } { print }' "$template" > "$LIC/$out"
}

# First match of extended regex $2 in $1 (a file or folder). Nothing found
# means an attribution moved or changed upstream, so the notices need a look.
# Call as VAR="$(notice_line ...)" so a failure stops the build (set -e).
notice_line() {
    local line
    line="$( (grep -rhoE "$2" "$1" 2>/dev/null || true) | awk 'NR == 1')"
    if [ -z "$line" ]; then
        echo "[local-stt] ERROR: no '$2' in ${1#"$HERE"/} — recheck the notices in build.sh step 5" >&2
        exit 1
    fi
    echo "$line"
}

license_copy "$SDK_LICENSES/LICENSE"                        NeMo-Speech.cpp/LICENSE
license_copy "$SDK_LICENSES/NOTICE"                         NeMo-Speech.cpp/NOTICE
license_copy "$SDK_LICENSES/THIRD_PARTY_NOTICES.md"         NeMo-Speech.cpp/THIRD_PARTY_NOTICES.md
license_copy "$SDK_LICENSES/third_party/ggml/LICENSE"       ggml/LICENSE
license_copy "$SPM_SRC/LICENSE"                             sentencepiece/LICENSE
license_copy "$SPM_SRC/third_party/absl/LICENSE"            abseil/LICENSE
license_copy "$SPM_SRC/third_party/protobuf-lite/LICENSE"   protobuf-lite/LICENSE
license_copy "$SPM_SRC/third_party/darts_clone/LICENSE"     darts-clone/LICENSE
license_copy upstream/llama.cpp/licenses/LICENSE-jsonhpp    nlohmann-json/LICENSE

NEMO_COPYRIGHT="$(notice_line "$SDK_LICENSES/LICENSE" '^Copyright .*')"
GGML_COPYRIGHT="$(notice_line "$LIC/ggml/LICENSE" '^Copyright .*')"
PARAKEET_COPYRIGHT="$(notice_line upstream/src/runtime/ggml 'Copyright \(c\) [0-9 -]+ Jason Ni')"
YARN_COPYRIGHT="$(notice_line upstream/ggml/src/ggml-cpu/ops.cpp 'Copyright \(c\) [0-9 -]+ Jeffrey Quesnelle and Bowen Peng')"
SPM_COPYRIGHT="$(notice_line "$SPM_SRC/src/sentencepiece_processor.h" 'Copyright [0-9]+ Google Inc\.')"
PROTOBUF_COPYRIGHT="$(notice_line "$SPM_SRC/third_party/protobuf-lite/LICENSE" '^Copyright .*')"
DARTS_COPYRIGHT="$(notice_line "$SPM_SRC/third_party/darts_clone/LICENSE" '^Copyright .*')"

license_mit parakeet.cpp/LICENSE "$PARAKEET_COPYRIGHT"
license_mit yarn/LICENSE "$YARN_COPYRIGHT"
# FP16 and Arm Optimized Routines carry no copyright line in ggml's sources;
# these are the lines from their upstream LICENSE files (the Arm one is dual
# MIT OR Apache-2.0 WITH LLVM-exception — we take the MIT option).
license_mit FP16/LICENSE \
    "Copyright (c) 2017 Facebook Inc." \
    "Copyright (c) 2017 Georgia Institute of Technology" \
    "Copyright 2019 Google LLC"
license_mit arm-optimized-routines/LICENSE "Copyright (c) 1999-2022, Arm Limited."

# nlohmann/json: the MIT text above plus every copyright line in the header
# itself (it embeds MIT code by others). Anything but MIT in it needs a look.
# One exception is known: every section is SPDX-tagged MIT, but one also
# carries code taken from Google Abseil "licensed under the Apache License
# 2.0" (C++11 stand-ins for std::integer_sequence), with an SPDX copyright
# line for The Abseil Authors. That code sits in the #else of
# `#ifdef JSON_HAS_CPP_14`, which our C++14+ build never compiles, so the
# Abseil line is kept out of the MIT list and noted on its own. Any other
# mention of Apache in json.hpp, or that code leaving its #else, fails here.
JSON_SPDX="$(sed -nE 's|^// SPDX-License-Identifier: *(.*)|\1|p' "$JSON_HPP" | sort -u)"
JSON_COPYRIGHTS="$(sed -nE 's|^// SPDX-FileCopyrightText: *(.*)|Copyright (c) \1|p' "$JSON_HPP" | awk '!seen[$0]++')"
JSON_ABSEIL_COPYRIGHT="$(echo "$JSON_COPYRIGHTS" | grep 'The Abseil Authors' || true)"
JSON_COPYRIGHTS="$(echo "$JSON_COPYRIGHTS" | grep -v 'The Abseil Authors' || true)"
# "<line> ok" for Apache text inside that #else, "<line> bad" for any other
# (and "0 bad" when the #if/#endif walk doesn't balance, i.e. can't be trusted).
JSON_APACHE="$(awk '
    /^[[:space:]]*#[[:space:]]*if/    { depth++; cond[depth] = $0; branch[depth] = "if" }
    /^[[:space:]]*#[[:space:]]*elif/  { branch[depth] = "elif" }
    /^[[:space:]]*#[[:space:]]*else/  { branch[depth] = "else" }
    /^[[:space:]]*#[[:space:]]*endif/ { depth-- }
    /Apache/ {
        ok = depth > 0 && branch[depth] == "else" && /Google Abseil/ &&
             cond[depth] ~ /^[[:space:]]*#[[:space:]]*ifdef[[:space:]]+JSON_HAS_CPP_14[[:space:]]*$/
        print NR, (ok ? "ok" : "bad")
    }
    END { if (depth != 0) print 0, "bad" }
' "$JSON_HPP")"
JSON_APACHE_OK="$(echo "$JSON_APACHE" | awk '$2 == "ok"')"
JSON_APACHE_BAD="$(echo "$JSON_APACHE" | awk '$2 == "bad" { print $1 }' | paste -sd, -)"
CXX_STANDARD="$(sed -nE 's/^set\(CMAKE_CXX_STANDARD ([0-9]+)\).*/\1/p' CMakeLists.txt)"
if [ -z "$JSON_COPYRIGHTS" ] || [ "$JSON_SPDX" != "MIT" ]; then
    echo "[local-stt] ERROR: json.hpp's SPDX notices changed (licenses: $(echo $JSON_SPDX)) — recheck its notice" >&2
    exit 1
fi
if [ -n "$JSON_APACHE_BAD" ]; then
    echo "[local-stt] ERROR: json.hpp has Apache-licensed text outside its known C++11-only Abseil block (line(s) $JSON_APACHE_BAD) — recheck its notice" >&2
    exit 1
fi
if [ "${JSON_ABSEIL_COPYRIGHT:+yes}" != "${JSON_APACHE_OK:+yes}" ]; then
    echo "[local-stt] ERROR: json.hpp's Abseil copyright and its Apache-licensed block no longer come together — recheck its notice" >&2
    exit 1
fi
case "$CXX_STANDARD" in
    14|17|20|23|26) ;;
    *)
        echo "[local-stt] ERROR: CMakeLists.txt's CMAKE_CXX_STANDARD is '$CXX_STANDARD'; below C++14 json.hpp compiles Apache-2.0 Abseil code — recheck its notice" >&2
        exit 1
        ;;
esac

# Versions are informational: a blank one never fails the build.
NEMO_VERSION="$(sed -nE 's/^NEMO_SPEECH_VERSION: *([^ ]+).*/\1/p' upstream/VERSION 2>/dev/null || true)"
GGML_VERSION="$( (sed -nE 's/^set\(GGML_VERSION_(MAJOR|MINOR|PATCH) ([0-9]+)\).*/\2/p' upstream/ggml/CMakeLists.txt | paste -sd. -) 2>/dev/null || true)"
GGML_SHA="$(git -C upstream/ggml rev-parse HEAD)"
LLAMA_SHA="$(git -C upstream/llama.cpp rev-parse HEAD)"
SPM_VERSION="$(cat "$SPM_SRC/VERSION.txt" 2>/dev/null || true)"
PROTOBUF_VERSION="$( (sed -nE 's/^#define GOOGLE_PROTOBUF_VERSION ([0-9]+).*/\1/p' "$SPM_SRC/third_party/protobuf-lite/google/protobuf/stubs/common.h" \
    | awk '{ printf "%d.%d.%d", $1 / 1000000, ($1 / 1000) % 1000, $1 % 1000 }') 2>/dev/null || true)"
DARTS_VERSION="$(sed -nE 's/^#define DARTS_VERSION "(.*)"/\1/p' "$SPM_SRC/third_party/darts_clone/darts.h" 2>/dev/null || true)"
JSON_VERSION="$( (sed -nE 's/^#define NLOHMANN_JSON_VERSION_(MAJOR|MINOR|PATCH) ([0-9]+).*/\2/p' "$JSON_HPP" | paste -sd. -) 2>/dev/null || true)"

SHIPS="$(
    for f in "$OUT/bin/"*; do echo "  Contents/MacOS/$(basename "$f")"; done
    for f in "$OUT/lib/"*.dylib; do echo "  Contents/Frameworks/$(basename "$f")"; done
)"
PATCHED=""
for p in patches/*.patch; do
    [ -f "$p" ] || continue
    PATCHED="$PATCHED
    $(basename "$p"): $(sed -n 's|^+++ b/||p' "$p" | paste -sd, - | sed 's/,/, /g')"
done
# Apache-2.0 4(b): say that the shipped libraries come from modified files.
MODIFIED=""
if [ -n "$PATCHED" ]; then
    MODIFIED="
  Modified by Dial8: these libraries are built from NeMo-Speech.cpp with
  Dial8's changes to these files, by patch:$PATCHED"
fi
NEMO_NOTICE="$(sed 's/^./    &/' "$LIC/NeMo-Speech.cpp/NOTICE")"
JSON_COPYRIGHTS_INDENTED="$(echo "$JSON_COPYRIGHTS" | sed 's/^/  /')"
JSON_ABSEIL_NOTE=""
if [ -n "$JSON_ABSEIL_COPYRIGHT" ]; then
    JSON_ABSEIL_NOTE="
  json.hpp also contains code from Google Abseil, licensed under the Apache
  License 2.0 (abseil/LICENSE):
  $JSON_ABSEIL_COPYRIGHT
  It is a fallback for compilers older than C++14. dial8-local-stt is built
  as C++${CXX_STANDARD}, which does not compile that code, so it is not in this app."
fi

# The models are not part of the app: when local transcription is turned on,
# the app downloads them directly from NVIDIA's Hugging Face repositories at
# the pinned URLs in module.json, so Dial8 does not redistribute them. The
# notice still names each one with its license. Every "url" in module.json
# must be a file in an NVIDIA Hugging Face repo that has an entry here, or
# the build fails.
model_notice() {
    case "$1" in
        nvidia/nemotron-speech-streaming-en-0.6b)
            echo "  Nemotron Speech Streaming (speech recognition)"
            echo "    https://huggingface.co/$1"
            echo "    Licensed by NVIDIA Corporation under the NVIDIA Open Model License"
            echo "    License: NVIDIA Open Model License Agreement"
            echo "    https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/"
            ;;
        nvidia/Nemotron-3-Diarization)
            echo "  Nemotron 3 Diarization (speaker diarization)"
            echo "    https://huggingface.co/$1"
            echo "    By NVIDIA Corporation"
            echo "    License: OpenMDW License Agreement, version 1.1"
            echo "    https://openmdw.ai/license/1-1/"
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
    echo "[local-stt] ERROR: read $URL_VALUES of $URL_KEYS \"url\" values in module.json — keep one \"url\": \"https://...\" per line" >&2
    exit 1
fi
MODEL_REPOS=""
while IFS= read -r url; do
    repo="$(echo "$url" | sed -nE 's|^https://huggingface\.co/(nvidia/[A-Za-z0-9._-]+)/resolve/[^/]+/.+$|\1|p')"
    if [ -z "$repo" ]; then
        echo "[local-stt] ERROR: module.json downloads $url, which is not a file in an NVIDIA Hugging Face repo — give it a license entry in build.sh step 5 (and update its wording)" >&2
        exit 1
    fi
    if ! model_notice "$repo" >/dev/null; then
        echo "[local-stt] ERROR: module.json downloads from $repo, which has no license entry in build.sh's model_notice" >&2
        exit 1
    fi
    case " $MODEL_REPOS " in
        *" $repo "*) ;;
        *) MODEL_REPOS="$MODEL_REPOS $repo" ;;
    esac
done <<< "$MODEL_URLS"
MODELS="$(for repo in $MODEL_REPOS; do echo; model_notice "$repo"; done)"

cat > "$LIC/NOTICES.txt" <<EOF
Local speech-to-text (local-stt)

Ships as:
$SHIPS

These files contain the open-source components below. License paths are
relative to this module's license folder.

NeMo-Speech.cpp ${NEMO_VERSION} by NVIDIA, commit ${UPSTREAM_SHA:0:12}
  https://github.com/NVIDIA/NeMo-Speech.cpp
  $NEMO_COPYRIGHT
  License: Apache License 2.0 (NeMo-Speech.cpp/LICENSE)
  In libnemo_speech_asr and libnemo_speech_asr_c; NVIDIA's ggml patches are
  in the ggml libraries.$MODIFIED
  NeMo-Speech.cpp's NOTICE file (NeMo-Speech.cpp/NOTICE) reads:

$NEMO_NOTICE

  Its THIRD_PARTY_NOTICES.md is included verbatim
  (NeMo-Speech.cpp/THIRD_PARTY_NOTICES.md). It covers NeMo-Speech.cpp's whole
  source tree; the components compiled into the files above are listed here.

ggml ${GGML_VERSION}, commit ${GGML_SHA:0:12}, with NVIDIA's ggml patches
  https://github.com/ggml-org/ggml
  $GGML_COPYRIGHT
  License: MIT (ggml/LICENSE)
  The libggml libraries.

whisper.cpp (Silero VAD graph, ported into NeMo-Speech.cpp)
  https://github.com/ggml-org/whisper.cpp
  $GGML_COPYRIGHT
  License: MIT (ggml/LICENSE; same authors and text)

parakeet.cpp (code derived from it in NeMo-Speech.cpp)
  https://github.com/jason-ni/parakeet.cpp
  $PARAKEET_COPYRIGHT
  License: MIT (parakeet.cpp/LICENSE)

YaRN RoPE scaling (code in ggml)
  https://github.com/jquesnelle/yarn
  $YARN_COPYRIGHT
  License: MIT (yarn/LICENSE)

FP16 (FP16 <-> FP32 conversion in ggml)
  https://github.com/Maratyszcza/FP16
  Copyright (c) 2017 Facebook Inc.
  Copyright (c) 2017 Georgia Institute of Technology
  Copyright 2019 Google LLC
  License: MIT (FP16/LICENSE)

Arm Optimized Routines (NEON exp/SiLU routines adapted in ggml)
  https://github.com/ARM-software/optimized-routines
  Copyright (c) 1999-2022, Arm Limited.
  License: MIT OR Apache-2.0 WITH LLVM-exception; used under MIT
  (arm-optimized-routines/LICENSE)

SentencePiece ${SPM_VERSION}, commit ${SPM_COMMIT:0:12}
  https://github.com/google/sentencepiece
  $SPM_COPYRIGHT
  License: Apache License 2.0 (sentencepiece/LICENSE)
  Statically linked into libnemo_speech_asr, with the three components below
  that SentencePiece bundles.

Abseil (the subset bundled with SentencePiece)
  https://github.com/abseil/abseil-cpp
  Copyright 2017 The Abseil Authors.
  Copyright 2016 Google Inc.
  License: Apache License 2.0 (abseil/LICENSE)

Protocol Buffers ${PROTOBUF_VERSION} (protobuf-lite, bundled with SentencePiece)
  https://github.com/protocolbuffers/protobuf
  $PROTOBUF_COPYRIGHT
  License: BSD 3-Clause (protobuf-lite/LICENSE)

Darts-clone ${DARTS_VERSION} (bundled with SentencePiece)
  https://github.com/s-yata/darts-clone
  $DARTS_COPYRIGHT
  License: BSD 3-Clause (darts-clone/LICENSE)

nlohmann/json ${JSON_VERSION} (as vendored by llama.cpp, commit ${LLAMA_SHA:0:12})
  https://github.com/nlohmann/json
$JSON_COPYRIGHTS_INDENTED
  License: MIT (nlohmann-json/LICENSE)
  In dial8-local-stt.$JSON_ABSEIL_NOTE

Speech models (downloaded from NVIDIA, not redistributed by Dial8)

  The speech models are not part of this app, and Dial8 does not
  redistribute them. When local transcription is turned on, the app
  downloads them directly from NVIDIA's Hugging Face repositories onto this
  Mac. Their own licenses, linked below, govern them.
$MODELS
EOF

echo "[local-stt] built $(du -sh "$OUT/bin" "$OUT/lib" | awk '{print $1}' | paste -sd+ -) → .out/bin, .out/lib, .out/licenses"

#!/usr/bin/env bash
# Our own FFmpeg and ffprobe for the desktop app's exports (the local runner, studio-worker/src/local.ts): an LGPL
# build of a pinned, verified FFmpeg release with exactly what the export path uses, and the system's own H.264
# encoder (VideoToolbox on macOS, Media Foundation on Windows). See README.md beside this file.
#
#   scripts/ffmpeg/build.sh <out-dir>            on macOS (arm64 or x86_64), or on Windows in MSYS2's MINGW64 shell
#
#   → <out>/bin/ffmpeg[.exe], <out>/bin/ffprobe[.exe]   static: no FFmpeg libraries beside them, system frameworks only
#   → <out>/LICENSE.LGPL-2.1.txt                        FFmpeg's licence (COPYING.LGPLv2.1 from the source)
#   → <out>/NOTICE.md                                   what this is, its version, its configure line, where its source is
#   → <out>/source/ffmpeg-<version>.tar.xz              the exact source it was built from (the LGPL's corresponding source)
#   → <out>/source/build.sh, configure.txt              how it was built
#   → <out>/SHA256SUMS                                  every file above
#
# Never: --enable-gpl, --enable-nonfree, libx264, libx265, libfdk-aac (the script refuses a configure that has them).
set -euo pipefail

VERSION=7.1.5
SHA256=de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f
URL="https://ffmpeg.org/releases/ffmpeg-${VERSION}.tar.xz"
# FFmpeg's release signing key (ffmpeg.org/ffmpeg-devel.asc); the signature is checked when gpg is there.
KEY_FPR=FCF986EA15E6E293A5644F10B4322F04D67658D8  # gitleaks:allow (the public fingerprint of FFmpeg's release signing key, not a secret)

here="$(cd "$(dirname "$0")" && pwd)"
out="$(mkdir -p "${1:?usage: build.sh <out-dir>}" && cd "$1" && pwd)"
work="${FFMPEG_BUILD_DIR:-$out/.build}"
jobs="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"
mkdir -p "$work" "$out/bin" "$out/source"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# ---- the source, pinned and verified ---------------------------------------------------------------------------------
tarball="$work/ffmpeg-${VERSION}.tar.xz"
if [ ! -f "$tarball" ]; then
  if [ -n "${FFMPEG_TARBALL:-}" ]; then cp "$FFMPEG_TARBALL" "$tarball"; else curl -fsSL --retry 3 -o "$tarball" "$URL"; fi
fi
got="$(sha256 "$tarball")"
if [ "$got" != "$SHA256" ]; then echo "ffmpeg-${VERSION}.tar.xz is $got, not the pinned $SHA256" >&2; exit 1; fi
if command -v gpg >/dev/null && [ -z "${FFMPEG_SKIP_GPG:-}" ]; then
  curl -fsSL --retry 3 -o "$tarball.asc" "$URL.asc"
  curl -fsSL --retry 3 -o "$work/ffmpeg-devel.asc" https://ffmpeg.org/ffmpeg-devel.asc
  export GNUPGHOME="$work/gnupg"; mkdir -p -m 700 "$GNUPGHOME"
  gpg --batch --quiet --import "$work/ffmpeg-devel.asc" 2>/dev/null || true
  status="$(gpg --batch --status-fd 1 --verify "$tarball.asc" "$tarball" 2>/dev/null || true)"
  echo "$status" | grep -q "VALIDSIG $KEY_FPR" || { echo "the signature of ffmpeg-${VERSION}.tar.xz is not FFmpeg's release key" >&2; exit 1; }
fi
src="$work/ffmpeg-${VERSION}"
rm -rf "$src" && tar -xf "$tarball" -C "$work"

# ---- what the export path uses (studio-worker/scripts/ffmpeg/README.md says where each comes from) -------------------
FILTERS="buffer,buffersink,abuffer,abuffersink,null,anull,format,aformat,scale,aresample,trim,atrim,setpts,asetpts,copy"   # the CLI's own
FILTERS="$FILTERS,settb,fps,tpad,split,select,concat,loop,color,geq,pad,fillborders,v360,crop,alphamerge,overlay,blend,setsar,setparams,sidedata" # the composition
FILTERS="$FILTERS,psnr,testsrc2"            # the checks and the encoder probe
FILTERS="$FILTERS,ebur128,loudnorm,volume"  # mastering
DEMUXERS="mov,matroska,wav,mp3,ogg,flac,aac,concat,image2,image2pipe,image_png_pipe,image_jpeg_pipe,image_webp_pipe"
MUXERS="mp4,mov,null,framemd5,pcm_f32le,wav"
DECODERS="h264,aac,pcm_s16le,pcm_f32le,mjpeg,png,wrapped_avframe"
ENCODERS="aac,pcm_f32le,pcm_s16le,rawvideo,wrapped_avframe"
PARSERS="h264,aac,mjpeg,png"
BSFS="trace_headers,h264_metadata,h264_mp4toannexb"   # h264_metadata brings H.264 header parsing (cbs_h264), which trace_headers needs; the concat demuxer asks for h264_mp4toannexb

common=(--disable-everything --disable-autodetect --disable-doc --disable-debug --disable-ffplay --disable-network
  --disable-shared --enable-static --enable-pthreads --enable-zlib --enable-avdevice --enable-indev=lavfi
  --enable-protocol=file,pipe --enable-filter="$FILTERS" --enable-demuxer="$DEMUXERS" --enable-muxer="$MUXERS"
  --enable-decoder="$DECODERS" --enable-encoder="$ENCODERS" --enable-parser="$PARSERS" --enable-bsf="$BSFS")

case "$(uname -s)" in
  Darwin)
    platform=(--enable-videotoolbox --enable-encoder=h264_videotoolbox --extra-cflags=-mmacosx-version-min=12.0 --extra-ldflags=-mmacosx-version-min=12.0)
    exe="" ;;
  MINGW*|MSYS*)
    # MSYS2 MINGW64 (gcc, mingw-w64): Media Foundation's encoder; zlib linked in statically; no DLLs beside the .exe.
    platform=(--target-os=mingw32 --arch=x86_64 --enable-mediafoundation --enable-encoder=h264_mf --pkg-config-flags=--static --extra-ldflags=-static)
    exe=".exe" ;;
  *) echo "build.sh builds for macOS and Windows (the desktop app); the server uses its image's FFmpeg" >&2; exit 1 ;;
esac

# No --prefix and no install: the two programs are taken from the build folder (so no path of this machine is in them).
configure=(./configure "${common[@]}" "${platform[@]}")
line="${configure[*]}"
case "$line" in *gpl*|*nonfree*|*x264*|*x265*|*fdk*) echo "refusing a configure line with GPL or non-free parts: $line" >&2; exit 1 ;; esac
( cd "$src" && "${configure[@]}" > "$work/configure.log" && make -j"$jobs" ffmpeg$exe ffprobe$exe > "$work/make.log" )

cp "$src/ffmpeg$exe" "$src/ffprobe$exe" "$out/bin/"
for b in "$out/bin/ffmpeg$exe" "$out/bin/ffprobe$exe"; do strip "$b" 2>/dev/null || true; done
buildconf="$("$out/bin/ffmpeg$exe" -hide_banner -buildconf 2>&1)"
license="$("$out/bin/ffmpeg$exe" -hide_banner -L 2>&1 | head -3)"
case "$buildconf" in *enable-gpl*|*enable-nonfree*) echo "the binary says it is GPL or non-free" >&2; exit 1 ;; esac

# ---- what an LGPL build is distributed with ---------------------------------------------------------------------------
cp "$src/COPYING.LGPLv2.1" "$out/LICENSE.LGPL-2.1.txt"
cp "$tarball" "$out/source/"
cp "$here/build.sh" "$out/source/build.sh"
echo "$line" > "$out/source/configure.txt"
cat > "$out/NOTICE.md" <<EOF
# FFmpeg ${VERSION} (LGPL 2.1 or later)

The Studio's exports on this computer use FFmpeg and ffprobe, from the FFmpeg project (https://ffmpeg.org), under the
GNU Lesser General Public License, version 2.1 or later (LICENSE.LGPL-2.1.txt). They are FFmpeg's own programs,
unmodified, built from the release tarball ffmpeg-${VERSION}.tar.xz (SHA-256 ${SHA256}, signed with FFmpeg's release
key ${KEY_FPR}), which is in source/ with the script and the configure line that built them; the same source is at
${URL}. No GPL or non-free part is in them.

Configure: ${line}

$(printf '%s\n' "$buildconf" | sed 's/^/    /')

$(printf '%s\n' "$license" | sed 's/^/    /')
EOF
( cd "$out" && for f in bin/ffmpeg$exe bin/ffprobe$exe LICENSE.LGPL-2.1.txt NOTICE.md source/ffmpeg-${VERSION}.tar.xz source/build.sh source/configure.txt; do echo "$(sha256 "$f")  $f"; done > SHA256SUMS )
cat "$out/SHA256SUMS"
ls -l "$out/bin"

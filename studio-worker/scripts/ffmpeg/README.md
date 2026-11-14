# The desktop app's FFmpeg

Every export the Studio makes on a person's computer (the local runner, `studio-worker/src/local.ts`) runs FFmpeg and
ffprobe. The desktop app carries its own copy, built here: an **LGPL** build of a pinned, signature-checked FFmpeg
release with exactly what the export path uses and the system's own H.264 encoder. Remotion's bundled FFmpeg is a GPL
build with x264, x265 and fdk-aac and is never shipped (the runner does not need it: `STUDIO_COMPOSITOR=off`).

```sh
studio-worker/scripts/ffmpeg/build.sh <out-dir>     # macOS (arm64 or x86_64); Windows: MSYS2's MINGW64 shell
```

It downloads `ffmpeg-7.1.5.tar.xz` (or takes `FFMPEG_TARBALL`), checks its SHA-256 against the pinned one and, when
`gpg` is there, its signature against FFmpeg's release key, configures, builds the two programs and writes:

| Path | What |
|---|---|
| `bin/ffmpeg`, `bin/ffprobe` (`.exe` on Windows) | the programs, static (no FFmpeg libraries beside them; system frameworks / DLLs only) |
| `LICENSE.LGPL-2.1.txt` | FFmpeg's licence |
| `NOTICE.md` | what they are, the version, the configure line, `-buildconf` and `-L`, where the source is |
| `source/ffmpeg-7.1.5.tar.xz`, `source/build.sh`, `source/configure.txt` | the exact source and how it was built (the LGPL's corresponding source) |
| `SHA256SUMS` | every file above |

The desktop bundle carries `bin/`, `LICENSE.LGPL-2.1.txt` and `NOTICE.md`; the `source/` folder is published with the
release (or carried too): distributing an LGPL program means offering its exact source. The runner's `NOTICES.md`
(`scripts/build-local-runner.ts`) lists FFmpeg among the third-party pieces.

## Why static

Two files to sign and notarise (or Authenticode-sign) instead of a program and six libraries with their install
names and load paths; nothing to collide with another FFmpeg on the machine; one `-buildconf` that says everything.
Static linking of an LGPL program is fine here: what is distributed is FFmpeg's own unmodified programs, run as
separate processes; nothing of ours links them. Each program is about 5.5 MB stripped (the libraries in each).

## What is in it, and why

| Kind | Components | Used by |
|---|---|---|
| filters | buffer, buffersink, abuffer, abuffersink, null, anull, format, aformat, scale, aresample, trim, atrim, setpts, asetpts, copy | the CLI itself (format conversion, `-ss`/`-t`) |
| | settb, fps, tpad, split, select, concat, loop, color, geq, pad, fillborders, v360, crop, alphamerge, overlay, blend, setsar, setparams, sidedata | the fast export's graph (`fast-export.ts`) and the Chrome path's pipe (`chrome-pipe.ts`) |
| | psnr, testsrc2 | the run-time checks and the encoder probe |
| | ebur128, loudnorm, volume | mastering (`master.ts`) |
| demuxers | mov, matroska, wav, mp3, ogg, flac, aac, concat, image2, image2pipe, image_png_pipe, image_jpeg_pipe, image_webp_pipe; the lavfi input device | the files a project names, the clips' join, Chrome's stills and frames, the probe |
| muxers | mp4, mov, null, framemd5, pcm_f32le, wav | the export, the checks, the frame hashes, the sound read |
| decoders | h264, aac, pcm_s16le, pcm_f32le, mjpeg, png, wrapped_avframe | sources, Chrome's JPEGs and PNGs, the probe's frames |
| encoders | h264_videotoolbox (macOS) or h264_mf (Windows), aac, pcm_f32le, pcm_s16le, rawvideo, wrapped_avframe | the picture, the sound, the hashes, the null output |
| parsers | h264, aac, mjpeg, png | |
| bitstream filters | trace_headers, h264_metadata (brings the H.264 header parser trace_headers needs), h264_mp4toannexb (the concat demuxer asks for it) | the colour labels in the stream itself (`encoder-probe.ts`), the join |
| protocols | file, pipe | |

`perspective` (what sampled the camera into the bubble before) is GPL-only: the bubble is sampled with `v360` now
(flat picture to flat picture, bilinear), which gives the same luma within one step and computes only the box.

## Windows

In GitHub Actions (`.github/workflows/studio-ffmpeg.yml`, run by hand) on `windows-2022` with MSYS2's MINGW64
toolchain (`mingw-w64-x86_64-gcc`, `nasm`, `pkgconf`, `zlib`), the same script configures with:

```
./configure <the common options above> --target-os=mingw32 --arch=x86_64 --enable-mediafoundation --enable-encoder=h264_mf --pkg-config-flags=--static --extra-ldflags=-static
```

Not built or run on Windows here: the workflow's job is the first place that proves it (and h264_mf's rungs,
`encoder-probe.ts`, are only proven on a Windows machine).

# The Studio worker

The Studio worker ([`../../studio-worker`](../../studio-worker)) does Studio's heavy media
work for the app: it turns uploads into library assets (FFmpeg), renders videos to MP4
with Remotion in a Chrome headless shell, draws stills and thumbnails, turns PDF,
PowerPoint and OpenDocument decks into page images (LibreOffice, poppler), and
transcribes speech through Deepgram when the person's desktop app cannot. The app keeps
the jobs (a `studio_job` row each, migration 620); the worker takes them one at a time.
It is the service `studio-worker` in `compose.yaml`, one container, stack `ni-studio`.

**How it fits.** Nothing calls the worker, and it publishes no port: every 2 s it asks the
app for a job (`/api/internal/studio/jobs/claim`) over the app stack's own network,
`ni-app`, at the app's proxy (`http://ni-app-proxy:8080`), so its requests never leave the
machine and never pass through Caddy. Every request carries `STUDIO_WORKER_SECRET`, a
secret of its own, the same in `app/.env` and in this folder's `.env`. It holds no database
or storage key: for the job it holds, the app signs a link per part of each file it may
read or write, and those links point at Storage's public name, reached the way the app's
own requests out are (`ni-app` has a way out; so does Deepgram's API). The contract, every
route and answer, is `web/src/lib/studio/server/job-contract.ts`.

**While a job runs** it reports progress at least every 10 s; the answer can ask it to
cancel, which stops the render or kills FFmpeg at once. On SIGTERM (an update, a restart)
it takes no more work, gives the running job 25 s, then stops it and fails it with a
sentence saying the worker was stopped, so the person can ask again. The one thing it
waits out is a call that is spending on a provider (a narration request, a generated
shot): its charge is always reported, never cut. `stop_grace_period` (6 minutes) leaves
time for that; an idle or rendering worker still stops in well under a minute.

**What it keeps.** The volume `ni-studio-work` holds the asset cache (every library file
it has downloaded, content-addressed, at most 5 GB, the least recently used going first),
the render bundle (made once per version of the engine's code, a few seconds), and each
job's scratch, removed when the job ends. Nothing in it needs a backup: deleting the
volume while the worker is stopped only means files are fetched again.

**What it may use.** At most 4 CPUs and 6 GB: a render is Chrome drawing frames in 3 tabs (the
worker reads the CPU quota and opens one tab fewer) and FFmpeg encoding them. Shared memory is
1 GB (Chrome keeps pages there). The root is read-only; scratch is the volume and a 2 GB `/tmp`.
"Export speed" below has what an export costs and what more CPUs would buy.

**What it may reach.** Everything it opens is a stranger's file: an upload, a deck. FFmpeg
and ffprobe open inputs as local files and pipes only (`-protocol_whitelist file,pipe` on
every input, `studio-worker/src/media.ts`), so a playlist dressed as a video cannot make
them fetch a URL; LibreOffice converts each deck in a fresh profile of its own that runs no
macros and follows no untrusted links (`studio-worker/src/jobs/slides.ts`). The network is
the last fence: the worker needs the app's proxy, Storage's public name, Deepgram's API (for
`transcribe`) and ElevenLabs' (for narration), and nothing else. `ni-app` gives it more than
that today (the app's own way out). Where the server's firewall can say so, give this
container a way out to those names only (an egress allowlist for its address, or a network
of its own with a proxy that allows only them); nothing in the worker needs any other host.

**What it cannot do here: Vision.** Cutting the person out of a recording (so graphics sit
behind them), face tracks (crops that keep the face in frame when a 16:9 video is delivered
9:16, the director pass choosing the camera the person faces) and the visual check's "covers
the face" use Apple's Vision framework, through small Swift programs the worker builds with
`swiftc` (`studio-worker/native/`, "Vision" in `studio-worker/README.md`). This container is
Linux: it builds nothing and never says `cutouts` or `faces`, so on the server the editor shows
no cut-out control, a narrower format's crops stay centred and the director chooses cameras
without faces. A Studio worker running on a Mac with the Xcode command-line tools (the owner's
own, pointed at the app with the same secret) has them: it builds and self-tests the helpers
at start, and nothing is downloaded, at build or at run time. A Linux replacement would need a
person-segmentation model and a face detector shipped in the image, behind the same job kinds
(`cutout`, `faces`) and capabilities.

**Remotion's licence.** Remotion is source-available under its own licence: free for
individuals and companies of up to three people; larger companies need a company licence
([remotion.dev/license](https://www.remotion.dev/license)). Running this worker means
complying with it.

## Export speed

Measured on 2026-11-13 on a made-up project shaped like the first slow export in production (a 20.2 s
2504×1438 60 fps screen recording, a 1080p 30 fps camera as the round bubble, a microphone track; 1212
frames), on an M2 Max: through the real worker against the fake app, and with Remotion's own render calls
timed frame by frame (the table below), then on Linux (further down). Production's worker had rendered the
owner's 20 s export in 631.6 s, about 1.9 frames a second, with its 4 CPUs full.

**Why it was slow.** On Linux the worker asked Chrome for `swangle`: a GPU emulated on the CPU
(SwiftShader). Chrome then composites every frame of the 2504×1438 page, the video canvases and the
screenshot through that emulated GPU: 0.84 CPU-seconds a frame, 95 % of it Chrome. The same render
composited in software (`gl: 'swiftshader'`, which leaves Chrome without a GPU process) costs 0.19.

| Per frame, software drawing (the server's case) | Before: `swangle`, 2 tabs | After: software, 3 tabs |
| --- | --- | --- |
| The page drawing the frame, video decode included (per tab) | 184 ms | 70 ms |
| The screenshot, handed to FFmpeg in shared memory (per tab) | 239 ms | 104 ms |
| Chrome's CPU | 0.80 s | 0.13 s |
| The encoder's CPU (x264 `medium` before, `veryfast` after) | 0.043 s | 0.03 s |
| All CPU | 0.84 s | 0.19 s |
| Frames a second on the Mac | 4.3 | 15.7 |

Of the 0.19 CPU-seconds (measured by leaving parts out): the page and its encoding 0.08, the screen
recording's decode and draw 0.065, the camera bubble 0.07 (a 1080p frame decoded, handed to every tab and
drawn for a 403 px circle). Bundling (4–6 s) happens once per engine version; staging from the cache 2 s;
the closing decode check 1–2 s.

**What changed** (`studio-worker/src/render.ts`, `config.ts`, `jobs/export.ts`):
- Software compositing on Linux, `swangle` kept only for a video with code scenes (whose code might use WebGL).
  4.5× less CPU a frame. Nothing the engine draws uses WebGL.
- Tabs from the CPUs the worker may use (the container's quota, not the machine's 12 cores): one fewer than
  the CPUs, 1 to 4. On the Mac, software drawing: 2 tabs 12.2 fps (2.0 CPUs busy), 3 tabs 15.7 (3.0), 4 tabs
  16.2 (3.5), 6 tabs 15.8 and 8 tabs 11.3 with 0.30 and 0.39 CPU-seconds a frame: Remotion decodes each video
  in one tab and hands every frame to all the others, so each tab past the first adds work to every frame, and
  one export never keeps more than about 3.5 CPUs busy.
- BT.709: the export's colours are now the preview's (below), converted by FFmpeg's scaler instead of
  zscale (0.01 instead of 0.08 CPU-seconds a frame for the conversion).
- x264 `veryfast` instead of `medium` at the same CRF 18: the encoder's CPU down 35 %, the file 11 % smaller,
  46.2 instead of 47.0 dB against the recording (SSIM 0.9988 between the two).

**Colour, found on the way.** Chrome turns a recording into RGB as BT.709 (what the preview shows), and
Remotion's default turned that back into YUV as BT.601 without saying so, so a player (which reads an
untagged HD video as BT.709) showed saturated colours shifted: a green at 216 came out at 183. Exports
before this change measured 30.5 dB against their recording; after, 46.2 dB. Videos exported before keep
the shift. An export now says (H.264 and the MP4's `colr`, read back with ffprobe): primaries BT.709, matrix
BT.709, limited range, transfer IEC 61966-2-1 (sRGB, the label Chrome's screenshots arrive with, as every export
said before; Remotion's `-color_trc bt709` does not override it).

**Measured on Linux** (2026-11-13): the worker's image built from this branch, run on a Linux server with 8
cores limited to 4 CPUs and 6 GB as here, on the same made-up 20 s project (`Rendering 1212 frames at
2504×1438, 60 fps (3 tabs)`: the quota read in a real container). The new settings rendered it in 124.4 s
(9.7 frames a second), the whole export job 140.0 s. The same image with the old render settings (`swangle`,
2 tabs; the new encoding) rendered it in 693.9 s (1.75 frames a second), the job 700.5 s; production's own
log for the owner's 20 s video was 631.6 s (about 1.9 frames a second), so the machines compare. 5.6 times
faster. Extrapolated, not measured: 30 minutes of 60 fps 2504×1438 video (108,000 frames) at 9.7 frames a
second renders in about 3.1 hours, where it took about 17. More CPUs are not measured on Linux; on the Mac a
fourth tab gave 3 % over three and one export never kept more than 3.5 CPUs busy, so 4 is what one export
uses; 8 CPUs would let two exports run at once (`STUDIO_WORKER_CONCURRENCY=2`), with twice the memory.

**If software compositing ever fails.** It works because Chrome's GPU process gives up on
`--use-gl=swiftshader`; a later Chrome could make that a fatal start instead. A render that fails that way
(Chrome not starting, or the browser or page gone, or a GL or GPU message, before any frame is drawn) is made
once more with `swangle`, the log says so in one line, and the worker keeps using `swangle` until it restarts
(`studio-worker/src/render.ts`, `withGlFallback`): slow again, but exports work.

**Measured, not worth it:** each tab decoding its own frames (0.31 CPU-seconds a frame, worse);
`OffthreadVideo` (0.57, 7.4 fps); JPEG or PNG frames and their quality (no effect: Remotion 4.0.534
hands frames to FFmpeg in shared memory); more than 4 tabs (above).

**The FFmpeg export (built; `STUDIO_FAST_EXPORT`, on by default).** Most exports are a recording with a camera
bubble and cuts and nothing drawn by React; those are composed by FFmpeg (`studio-worker/src/fast-export.ts`,
`fast-export-run.ts`), the rest drawn by Chrome as above. The job's log says which: `Composing … with FFmpeg (the
fast export, …)`, or `Rendering in Chrome: <the first reason>`.

- *What goes through* (default deny: one function, `fastExportPlan`, over the whole project; any other part, any key
  it does not know, any value outside these, and the whole export is Chrome's): 30 or 60 fps; the recording at the
  video's size and rate (MP4, H.264 yuv420p, BT.709 or untagged, limited range, from time 0); clips of it with cuts
  and their soft blend, starting anywhere in the take, at 1x (2x in 60 fps videos); no zoom, motion, hold, chosen
  transition, layout, layer, caption, cut-out, slide, extra source, automation, platform format or drawn pointer;
  a look with no padding, inset, window radius or camera fill (background none, solid or gradient, any shadow or
  blur, all hidden under the full-frame recording); the camera synced to the take, as a still round or
  rounded-square bubble anywhere inside the frame, uncropped, its own sound off, 30 fps in a 30 or 60 fps video
  or 60 fps in a 30 fps one; any sound (mixed here when it can be, otherwise by Remotion: below).
- *How it draws*: each clip's frames are the source frames @remotion/media would show (its rule, the latest frame
  at or before the clip's time with a millisecond's grace, replayed and checked frame by frame against what the
  FFmpeg graph will pick before anything runs); a jump cut's blend as `cutVideoPlan` lays it; the camera's timing
  from `presenterPieces` (now in the engine's `presenter-pieces.ts`, the one copy the editor and the worker both
  use), sampled bilinearly at Chrome's fractional place under an antialiased circle or rounded-square mask; one
  FFmpeg pass per clip with the Chrome path's encoder settings and labels, joined without re-encoding.
- *What the files must be* (checked before anything runs): H.264 yuv420p, colour BT.709 or not said (an untagged
  take, as a browser's conformed by the worker arrives, is read by Chrome as BT.709 limited range: proven), square
  pixels, not turned, starting at 0, and every source frame the plan shows on its file's frame grid (within 0.25 ms,
  each once; read only around the stretches used). A rounded bubble's radius must be a pixel or more.
- *The sound* (`studio-worker/src/fast-sound.ts`), mixed as Remotion mixes it: the layers are the composition's own
  (the engine's `sound-layers.ts`, which `composition.tsx` now draws from too: each recording's sound under its
  clips with the cut fades, each audio track's segments with gain and fades); for every frame of a layer the file's
  samples from the frame's time to the next frame's, turned into 16 bits as Chrome turns float audio into them (×32768
  below zero, ×32767 above, the fraction dropped), at the frame's level truncated, nothing at level 0, each piece at
  its frame's place, the layers summed and clipped. Two things only Remotion's own mix gives, so the fast export asks
  it for them in one shared browser: the first ~100 ms of a file played from its very start, where Chrome's AAC
  decoder starts cold (448 samples of silence, then its ramp), spliced in; and ten frames around each layer's
  loudest frame (every layer, up to six windows; past that, layers spread through the video; a layer silent
  throughout is checked in its middle), compared, with Remotion's whole mix taking over if they differ by more than 2 steps
  RMS or 64 at a sample (Chrome's AAC decoder and FFmpeg's round differently: on the made-up voices one sample in a
  thousand by one step; on a pure tone one in eight by up to 14 steps, -97 dBFS RMS). Sources it mixes: 48 kHz AAC
  or PCM, mono or stereo, starting at 0 in its file, at 1x (a clip at 2x is silent in Remotion's mix as here: its
  sound is muted), no ducking. Each layer's file is decoded only over the stretch it plays, as a stream (a quarter
  second of decoding before it, then sample-exact): what is held is a ten-second block and a few readers' buffers,
  whatever the files' lengths (a 10-minute source: +23 MB for a 20 s trim at minute 9, +66 MB for all of it; decoding
  the files whole had taken 580 MB).
  Otherwise the sound is Remotion's mix of the same video without its silent pictures, in stretches rendered at
  once (one browser each) and joined to the sample.
- *Proof* (`studio-worker/test/fast-export-e2e.ts`: made-up videos exported by the real worker both ways, every
  frame compared): a 2504×1438 60 fps take with a 30 fps camera; the same cut at odd frames, starting mid-take, a 2x
  stretch, a rounded bubble top left, a camera offset between frames, a gradient look with shadow and blur; a
  1366×766 30 fps take with a 60 fps camera top right on a solid look; the 60 fps take with no camera; the 30 fps
  take cut, a rounded bubble bottom left, a negative camera offset. In every frame the fast frame matches Chrome's
  same frame better than its neighbours, inside and outside the bubble. Worst frames: outside the bubble 44.5 dB,
  SSIM 0.998; inside 27.7 dB, SSIM 0.941 (the camera is a sharp test card with one-pixel checkerboards and noise,
  drawn five times smaller without filtering by Chrome; side by side the same picture). Thresholds: 40 dB and 0.99
  outside, 27 dB and 0.93 inside. The sound, against Remotion's own mix of the same video sample for sample: the
  same length to the sample, offset 0 at every layer's start, level within 0.0001 dB, 28–108 samples a step apart
  (residual 115–117 dB below the sound). Thresholds: length equal, offset 0, 0.1 dB, residual under -90 dBFS, no
  sample more than 32 steps apart. One of the five has no camera and a cut (below). Also: two untagged takes (60
  and 30 fps: 44.9 and 45.4 dB outside, 32.0 and 27.0 inside), and a take whose sound starts 0.28 s after its picture
  (left to Remotion's mix, picture still FFmpeg's). The mask's edge on its own, 2 px inside it and 0.5–2.5 px
  outside: at least 18 and 30 dB, and the same bubble drawn with its radius 2 px smaller must fail (about 18 dB
  outside). A radius 2 px larger is not caught: Chrome's rounded corners measure about a pixel rounder than the mask.
  With `STUDIO_FAST_ENCODER=lossless` the proof compares the frames before any lossy encoder with Chrome's PNG
  screenshots encoded at CRF 1: outside the bubble 46.5–48.7 dB; inside 26.9–32.4 (one case, the 30 fps camera drawn
  five times smaller under a rounded mask, 0.06 dB under the 27 dB threshold).
- *At run time*: a failure, or a failed check, and the export goes through Chrome, with the reason in the log.
  The check: the frame count; at each clip's two ends, after a blend and where the source changes most, the frames
  FFmpeg's graph had (hashed in the real run, before the encoder) against the source frames the plan says, decoded
  alone, bit for bit; then two or three frames (the first with the bubble, a blended one, the one where the recording
  changes most) drawn by Chrome and compared with the file (34 dB, bubble 25 dB with x264; 30 and 25 with a hardware
  encoder; the wrong camera frame scores about 22). A failure stops the other branches, and what the fast export left
  in the job's folder is removed before Chrome starts. Chrome (one
  browser for the whole fast export) draws them, and the sound's windows, while FFmpeg draws the picture.
  The log gives every stage's time: `Fast export: Chrome started …`, `sound mixed in …`, `picture …, alongside it
  the sound … and Chrome's check frames …; joining …, comparing …`, `Composed in …`, `Decode check in …`,
  `Stored in …`.
- *Speed* (a Mac with Chrome's GPU off, as on the server; the 20 s project, `test/export-bench.ts`): plain, Chrome
  47.9 s (0.153 CPU-seconds a frame) against FFmpeg 8.3 s (0.039); with cuts and a 2x stretch, 34.8 s (0.166)
  against 8.4 s (0.045). FFmpeg's stages, plain: Chrome started 0.3 s; picture 4.6 s, alongside it the sound 2.9 s
  (mixed in 0.2 s, Remotion's windows 2.5 s) and the check frames 1.4 s; joining 1.0 s; comparing 0.9 s; decode
  check 0.4 s. On Linux at 4 CPUs (the image, measured before the sound was mixed here) the Chrome path took 125.6
  s and the fast path 110.8 s, nearly all of it Remotion mixing the sound in Chrome: that is what this mix removes.
- *Found on the way, both in the Chrome path and both fixed*: (1) a clip played faster went black for the last
  part of it in Chrome's export and in the editor's preview in a Chromium browser: at 2x the second half, at 4x the
  last three quarters, at 1.25x the last fifth (`media-video.tsx` gave @remotion/media the clip's timeline length
  where it counts source frames; the camera bubble and video layers over such a clip went black with it). Every
  export with a sped-up clip made before the fix has it. (2) Under a jump cut's blend the outgoing shot's held last
  frame came out as an earlier frame of the take (source frame 132 where 179 belonged, a 175-frame clip); a hold at a
  clip's end did the same. The hold froze the clip's whole video on its last frame, and @remotion/media asked for
  frame 127 of the clip instead of 174; it is now a one-frame video at that frame (`motion-layers.tsx`). Not every
  cut showed it (a 94-frame clip held the right frame), so earlier exports may or may not; the editor's preview was
  not checked.
- *Not built*: mixing the two (FFmpeg for the plain stretches, Chrome for the rest, joined). It would need each
  stretch to start on a keyframe with the encoder's state reset, the same x264 settings both sides, the blend at a
  join drawn by one of them, and the sound mixed once for the whole video; until then a video with anything drawn
  is all Chrome's.

Exporting at 30 fps (enough for most screen recordings) would halve every number above; it is a product
decision, not a setting the editor offers.

## Live slots

Off by default (`STUDIO_LIVE_SLOTS=0`). On, a browser take's video tracks (screen, camera) are prepared while they
record: a `live-import` job per track, taken only by a live slot, reads each piece as it is uploaded and pipes it into
one FFmpeg with the import's own arguments (studio-worker/README.md, the `live-import` row). At Stop only the last
seconds are left, and the conformed file's measuring, hashing and storing. When the live slots are busy, or there are
none, a take is prepared after Stop as before; a live job that fails gives way to that ordinary import.

What it makes is what the import would make, or nothing: the screen's rate is the import's own rule, decided once
enough of the picture has moved and checked on the whole take after the seal (a disagreement fails the job: it takes
a take whose motion changes character after its first seconds, and costs the time live would have saved, never a
wrong rate); it conforms with the strict import's flags, and hands over at the seal when the reader of the copy stops
short of its end or met damage (a pipe resyncs otherwise than a file); the app refuses
its result when its bytes or pieces are not the sealed track's. It always re-encodes, where the import keeps an MP4
already on the frame grid byte for byte. At Stop a running live job asked to make what the import would (the same
conform, cursor flag) is kept; at the seal the worker hands the take to the import at once when what it has left
would take longer than the import takes for all of it (studio-worker/src/jobs/live-import.ts `handOver`, measured
below): what it has left runs at its lower priority and threads.
A live job runs at most 2 h 30 min and ends when no piece comes for 3 minutes; a workspace has at most 4 live jobs
queued or running (two takes), later takes are prepared after Stop.

Measured on the Mac (Apple silicon, other work running; a made-up 10-minute take at 2504×1438, its frames 43 a second
on average, conformed to 60 fps, ultrafast CRF 26, 267 MB):

- After Stop, live slot ON, when the live job kept up: the last piece fed and the encoder closed, the `+faststart`
  rewrite, measuring and hashing side by side, and the end decode check: **2.05 s** (storing the 267 MB file is on top:
  a copy on the same disk took 0.23 s; storing it through Storage on the server is not measured).
- Live slot OFF: the whole conform after Stop, 4 encoder threads: **185.6 s**, then the same tail (about 2 s).
- The live job caught up with the 10 minutes in under 260 s on 4 threads: about 0.43 of real time on the Mac.
- The check of the screen's rate after the seal (every frame time of the whole take, then the rule): 0.13 s on another
  made-up 10-minute 2.5K take (268 MB, MP4 or Matroska alike), beside the encoder's close: the 2 s above stand.
- Whether a live job behind at Stop is worth keeping, on that take: the live conform (`nice`, 4 threads for decoder,
  filters and encoder) 54.7 s, the import's (every thread) 26.7 s. Keeping a job is sooner once it has fed more
  than 1 − 26.7/54.7 of the take: about half. With the machine busy (a load of 26 to 65): 1 thread 344 s, 2 threads
  163 s, 8 threads 73 s against the import's 54.7 s. The worker takes the import to be √(cores ÷ threads) times as
  fast (one thread: the 0.64th power), within an eighth of these from 2 threads up: at the default of 2 threads on
  18 cores a job is kept up to a third behind, at 4 threads on 8 cores up to about seven tenths. Capping the decoder's and filters' threads changed nothing on this H.264 take (54.0 s
  either way, about 5 cores busy): it bounds them on a take whose decoding is heavier.

Expected from Stop to an editable video on the Mac, all steps included (the last piece's upload, the worker's 1.5 s
poll, storing the file, putting the video together, the dialog's 1.5 s poll): ON about 5 s for 1 minute, 7 to 10 s for
10 minutes, 10 to 15 s for 30 minutes (extrapolated); OFF about 25 s, 4 to 5 minutes and 13 to 15 minutes (the camera,
conformed after the screen, adds about a third).

**What production needs for it.** The server's CPUs did the same conform 3 to 5 times slower than the Mac (the
owner's 20 s take, studio-worker/README.md). So to keep up in real time a 60 fps 2504×1438 screen needs about 5 to 9
CPUs of its own, a 30 fps screen about half that, a 1080p camera about 1 to 2. Recommendation: `STUDIO_LIVE_SLOTS=2`
(screen and camera of one take), `STUDIO_LIVE_THREADS=4`, and the container's `cpus` raised from 4 to about 8 (memory
6 GB is enough: a live job holds one FFmpeg and its pieces on disk). With that, a 30 fps screen and the camera keep up;
a 60 fps 2.5K screen runs at roughly half to three quarters of real time, so a backlog of a quarter to half the take is
left at Stop: still several times sooner than now (a job less than half way along is replaced by the ordinary import,
which on the server's fewer cores is closer to the live job's speed, so the line could be lower there). Live jobs run under `nice`, so an export beside them gets the CPU
first. Not measured on the server: one take there settles these numbers. Turning it on is the owner's call: set the two
settings in `.env`, raise `cpus` in compose.yaml, and restart the worker (`sudo docker compose up -d --no-build`).

## First start

**S1. The source.** The server's checkout is sparse: the worker's source has to be added
to it, as the checkout's owner (not with sudo). It also reads the engine from `web/`,
which later steps of `../README.md` add already:

```bash
cd /opt/native-intelligence && git sparse-checkout add studio-worker
```

**S2. The settings.** This folder's `.env` from its `.env.example`, and in `app/.env` the
line `STUDIO_WORKER_SECRET=` from `app/.env.example`, empty:

```bash
cd /opt/native-intelligence/deploy/studio && [ -e .env ] || sudo install -m 600 -o root -g root .env.example .env
```

Then one new secret into both files, never shown:

```bash
v=$(openssl rand -hex 24); sudo sed -i "s/^STUDIO_WORKER_SECRET=.*/STUDIO_WORKER_SECRET=$v/" .env ../app/.env; unset v
```

Check them by length only:

```bash
sudo awk -F= '/^STUDIO_WORKER_SECRET=/ { print FILENAME, length(substr($0, length($1) + 2)) }' .env ../app/.env
```

Both must print 48. `DEEPGRAM_API_KEY` may be copied from `app/.env` (with `sudo nano .env`)
for the `transcribe` jobs; empty, only those fail, with a sentence saying so.

`ELEVENLABS_API_KEY` (optional) turns narration on: the worker tells the app it can narrate,
and the editor's "Rewrite voiceover" and the agent's narration tools appear. Empty, narration
is simply not offered. Generated shots need the `higgsfield` command-line tool installed and
signed in where the worker runs; this image does not have it, so on the server they stay off.
They are a capability of a worker on the owner's own
Mac until a provider API key path exists.

The motion check and the video review need nothing set here: the image carries Debian's Python
with numpy and OpenCV (`python3-numpy`, `python3-opencv`), the worker finds it as `python3` at
start, and tells the app it can run both (the editor's Motion check and Review buttons and the
agent's check tools appear). Its start-up log says which (`motion check and review on: …`, or
`off:` with the reason). The image has no `tesseract`, so the review leaves on-screen text out
and its report says so. The visual check needs only the renderer; on this Linux worker it
measures text contrast, size and overflow, and says overlap with the person was not measured
(that part needs macOS Vision).

**S3. The image.** Built on the server with Docker itself, from the repository's root (the
worker carries the engine's own files from `web/`), then started from that image.
(`sudo docker compose up -d --build` fails in a shell that is not interactive, as the call
recorder's does: Compose asks for leave to read outside this folder.) The first build
fetches FFmpeg, LibreOffice Impress, fonts and Chrome's headless shell: allow ten minutes
and about 2 GB.

```bash
sudo docker build -f ../../studio-worker/Dockerfile -t ni-studio-worker:local ../..
```

```bash
sudo docker compose up -d --no-build
```

```bash
sudo docker compose ps
```

`ni-studio-worker` must say `healthy` within a minute. Its log says
`[studio-worker] started as studio-worker`, then, until the app has Studio's routes and
the secret (S4), `no work read (404)` every 30 s or so: that is right.

```bash
sudo docker compose logs --tail 30 studio-worker
```

**S4. The app, in this order.** Every migration is applied as migrations are ("Day to
day" in `../README.md`, on the owner's word).

1. **Before the app:** `620_studio.sql` (the Studio's tables and its storage bucket),
   `623_studio_persona_grant.sql` (agents that had every tool category keep every one),
   `624_studio_entities.sql` (who may read a link to a video) and
   `625_studio_job_fairness.sql` (the job queue), `627_studio_limits.sql` (the job caps
   under requests at once; the app works without it, so either way),
   `631_studio_paid_job_kinds.sql` (after 625: the paid job kinds a stale claim ends as
   failed, never queued again, now with re-voicing, sound effects and music), plus any later
   `6xx_studio_*.sql` whose header says "before the app". All are additive and safe under the app that serves today.
2. `STUDIO_WORKER_SECRET` in `app/.env` (S2), and, if narration or generated shots should
   work for some workspaces, `STUDIO_PROVIDER_WORKSPACES` (see `app/.env.example`): the
   workspace ids that may spend on the worker's one ElevenLabs and Higgsfield account, or
   `*`. Empty in production: none may (per-workspace provider keys do not exist yet).
3. **The app rolled out** (`sudo ./deploy.sh` in `app/`). The worker's log then stops
   saying 404 (it says 503 while the app runs without the secret).
4. **Right after the app:** `621_studio_skills.sql`, `626_studio_skills_refresh.sql`,
   `629_studio_skills_parity.sql`, then `630_studio_skills_capabilities.sql` (the agent's
   Studio skills). After, not before: the app that served until now does not
   know these skills are for the Studio only and would offer them in every chat. 629 and
   630 also teach tools only the new app has: an older app would offer skills for tools it
   does not have.

**If the app is rolled out without step 1** (anyone rolling out `main` for another change
does this): nothing else breaks, but every person sees the Studio in the rail and it opens
on "The Studio is not set up here yet". Apply the migrations and it works, with no restart.

**S5. A real job, from outside.** In Studio, upload a short screen recording, then export
a video of it. The worker's log says `import: started`, `Storing assets/…`, `completed`,
then `export: started`, `Bundling the composition` (the first time), `Rendering … frames`,
`Checking complete MP4 decode`, `Export complete`; the export plays in the app, with its
sound. Then a deck (a PDF, and a PowerPoint), and an export cancelled half way (the log
says `failed: Cancelled` within seconds).

**What only this server can prove** (none of it could be run off it): the image building
(it first built here on 2026-11-12), Chrome's headless shell starting in it under the
read-only root and Docker's seccomp profile, LibreOffice converting in it, its way to
`ni-app-proxy:8080` and to Storage's public name, the app's routes answering it, and its
CPU and memory on a long render (`sudo docker stats ni-studio-worker`).

## Day to day

| To | Command, in this folder |
| --- | --- |
| Take a change to the worker or to the engine (`studio-worker/`, `web/src/lib/studio/`) | After `git pull`: `sudo docker build -f ../../studio-worker/Dockerfile -t ni-studio-worker:local ../..`, then `sudo docker compose up -d --no-build`. The running job gets 25 s to finish, or is failed with a sentence saying why. A change to the engine also changes what the app's preview draws: roll the app out with it. |
| See what it is doing | `sudo docker compose logs --tail 100 -f studio-worker`; its health answer, from inside: `sudo docker exec ni-studio-worker node -e "fetch('http://127.0.0.1:9092/').then(r=>r.text()).then(console.log)"` |
| Empty its cache | `sudo docker compose down`, `sudo docker volume rm ni-studio-work`, `sudo docker compose up -d --no-build` |

## The undo

Stop it; nothing else is touched. Jobs queued meanwhile wait in the app; a running one is
failed with a sentence saying the worker was stopped:

```bash
sudo docker compose down
```

## What it needs from the owner

- The go-ahead to build it and start it on the server (S1 to S3), and to apply the
  Studio's migrations and roll the app out with `STUDIO_WORKER_SECRET` (S4, in its order).
- Whether `transcribe` should run here at all (a Deepgram key in this `.env`), or only on
  the person's own machine.
- Whether narration should run here (an ElevenLabs key in this `.env`): it spends that
  account's credits, recorded in the Studio's cost ledger.
- Remotion's licence: whether the company's size needs a company licence.
- Whether sound design should run here: the image does not install earshot (the outside,
  MIT-licensed sound tool the Studio's sound pass and listening use), so on the server the
  `sound` capability is off and the editor shows no ♪ Sound menu. Installing it is the
  commented block in `studio-worker/README.md` ("The image"): untested, it adds Python 3.12,
  earshot at its reviewed commit and its models (a few hundred MB) to the image, then
  `STUDIO_EARSHOT_DIR=/opt/earshot` in this `.env`. Until then a worker on the owner's Mac with
  earshot installed does sound design.
- Whether code scenes (graphics the agent writes as React code) should run: they are off in
  production on the app AND the worker unless `STUDIO_CODE_SCENES=on` is set in each one's
  `.env` (`../app/.env` and this one). The reasons are in `studio-worker/README.md` ("Code
  scenes").
- Whether cut-outs and face tracks should run on the server: today they need a worker on a Mac
  (macOS Vision); a Linux path means choosing a person-segmentation model and a face detector
  to ship in the image.

# The Studio worker

One process that does Studio's heavy media work for the app: it turns uploads into
library assets, renders videos to MP4 with Remotion, draws stills and thumbnails, turns
slide decks into page images, and transcribes speech when the person's own machine
cannot. The app keeps the jobs (a `studio_job` row each, migration 620); this process
takes them one at a time and does them.

- It asks the app for work every 2 s (`/api/internal/studio/jobs/claim`) with a shared
  secret, `STUDIO_WORKER_SECRET`. Nothing calls it, it publishes no port, and it holds no
  database or storage key: it reaches files only through the links the app signs for the
  job it holds. The contract, with every route, body and answer, is
  [`web/src/lib/studio/server/job-contract.ts`](../web/src/lib/studio/server/job-contract.ts);
  the worker imports it (and the engine's schemas) from there, never a copy.
- A file is a blob: numbered parts of at most 32 MB, read through one link per part and
  joined (checked against its sha256), written by cutting the file and PUTting each part
  with the headers the app names, then committed.
- While a job runs it reports progress at least every 10 s, with its log lines; the app's
  answer can ask it to cancel, which kills the job's FFmpeg or stops its render at once.
- SIGTERM (a deploy): it takes no more work, gives the running job
  `STUDIO_SHUTDOWN_GRACE_MS` (25 s) to finish, then stops it and fails it with a sentence
  saying it was stopped, so it can be asked for again.

## The jobs

| Kind | What it does | Stores |
| --- | --- | --- |
| `import` | Downloads the upload, measures it with ffprobe as the editor imports media (MP4/MOV/WebM/MKV, PNG/JPEG/WebP, WAV/MP3/M4A/AAC/FLAC/OGG; two hours at most). A video must keep a constant frame rate, every packet counted: one that doesn't (a phone video, a screen recording) is conformed as a recording is, to a constant 60 fps when its average rate is above 45, else 30, and the job log says so ("This file's frame rate varied, so it was converted to a constant 30 frames a second."); it is refused only when it can't be conformed. A container with sound and no picture (a browser's microphone take, Opus in WebM or AAC in MP4) is audio whatever its name says: stored as AAC in `.m4a` (AAC copied, anything else encoded, the duration written), the job log saying so. A recording (`conform: {fps}`) is first made a steady 30 or 60 fps H.264/AAC MP4 with libx264 (kept byte for byte when it already is one) and its first and last seconds decoded. A browser's WebM or Matroska that does not say how long it is is copied into a fresh file first (duration and index written, no frame changed). Then: sha256, a waveform of 600 peaks for anything with sound, and the `EditorAsset`, checked by the engine's `EditorAssetSchema`. | `assets/<sha256>.<ext>` |
| `export` | Checks the frozen project (`parseEditorProject`), stages every asset it names (cached, checked against its sha256), renders the engine's composition `EditorVideo` with Remotion (H.264, AAC, yuv420p, CRF 18), masters the sound when asked (two-pass loudnorm to the LUFS and true-peak target), and decodes the whole MP4 once (`-xerror`) before storing it. | `exports/<job id>/video.mp4` |
| `stills` | PNGs of the project at the given times, scaled, from one browser. | `stills/<job id>/<n>.png` |
| `thumbnail` | One JPEG of the project at `seconds`, at most 640 px wide. | the key the job names |
| `slides` | PowerPoint (`.pptx`, `.ppt`) and OpenDocument (`.odp`) become a PDF with LibreOffice, headless; poppler's `pdftoppm` draws each page 1920 px wide; each page becomes an image asset. A missing tool fails the job with what to install. | one asset per page |
| `transcribe` | The first audio stream as 16 kHz mono FLAC, sent to Deepgram's prerecorded API (nova-3, smart formatting, punctuation, word times), mapped to the engine's `TranscriptSchema` (label "Transcript", origin `imported`). `no-audio` and `no-speech` when there is nothing to hear. Without `DEEPGRAM_API_KEY` the job fails with a sentence saying so. The desktop app's own model is the first path; this is the fallback. | nothing (the transcript is the result) |
| `voices` | The ElevenLabs account's voices (`GET /v1/voices` with `ELEVENLABS_API_KEY`), for the person to choose a narration voice. | nothing (the list is the result; the app keeps it an hour) |
| `narration` | One exact text-to-speech request the app built and hashed (`POST /v1/text-to-speech/<voice>/with-timestamps`, MP3 44.1 kHz): the audio becomes an asset, the provider's character alignment becomes words in milliseconds (the normalized alignment when there is one), checked against the measured audio; what ElevenLabs charged (its `character-cost` header, else the request's length) comes back for the cost ledger. Never retried, and a job handed out a second time (a worker stopped mid-request) refuses rather than pay twice. | `assets/<sha256>.mp3` |
| `voice-search` | The account's voices (`GET /v1/voices`) and the shared voice library (`GET /v1/shared-voices` with `page_size`, `search`, `gender`, `age`, `accent`, `language`, `use_cases`), the account's matches first. Free. The app keeps what it finds so a voice can be chosen by its id (only the id is stored; the account is unchanged). | nothing (the voices are the result) |
| `revoice` | A library asset's speech (the stretch `from`..`to`, 1 to 300 s) cut to mono 44.1 kHz WAV and re-spoken in another voice with the voice changer (`POST /v1/voice-changer/<voice>`, multipart `audio`, `model_id` `eleven_multilingual_sts_v2`, `remove_background_noise`), which keeps the timing. The answer is streamed to disk under a 200 MB cap and becomes an asset with its provenance (voice, stretch, whose speech it is). The app carries the source's transcript words over when the length matches. Spends: never retried, a job handed out again refuses, and an answer that could not be kept comes back `undelivered` with the charge. | `assets/<sha256>.mp3` |
| `sound-effect` | Designed sound effects from a description (`POST /v1/sound-generation`: `text`, `duration_seconds` 0.5 to 30, `prompt_influence`, `loop`, `model_id` `eleven_text_to_sound_v3`), one request per candidate (1 to 3), each an asset with its provenance and the terms the provider states. Spends, as `revoice`. | `assets/<sha256>.mp3`, one per candidate |
| `music` | Music beds from a description (`POST /v1/music`: `prompt`, `music_length_ms` 3000 to 300000, `force_instrumental`, `model_id` `music_v2_5`), one request per candidate (1 or 2), as `sound-effect`. Spends, as `revoice`. | `assets/<sha256>.mp3`, one per candidate |
| `shot-quote` | A storyboard beat's still or clip priced as it will run, with the `higgsfield` tool (`account status`, `model get`, `generate cost`, all `--json`): a draft quotes every candidate model that can take the inputs at its lowest quality and answers the cheapest (the others tried with it); a final quotes the beat's good model at the best quality short of 4k. Library media it names (cast references, the approved still) are downloaded and handed to the tool as files; the quote names them `asset:<id>`. A model the plan was refused for is not quoted again on that plan. Free. | nothing |
| `shot` | The spend: quotes again and spends only when the price is the model and credits the person confirmed (else nothing, "the price changed"); `generate create`, `generate wait` (up to 30 minutes), every result downloaded at once and stored as an asset with its provenance (the provider's job id, model, tier, credits, prompt); a clip is graded toward the camera footage when there is some (frame statistics through FFmpeg, a `lutrgb` grade, a second asset). A plan refusal comes back for the app to remember; spent with no file comes back as such, with the provider's job id. A job handed out a second time refuses rather than spend twice. | the made files as assets |
| `continuity` | Light, colour and brightness of each generated beat against the recorded beat it cuts to (three small frames each, FFmpeg), as sentences. | nothing |
| `sounds` | Sound design (see "Sound" below). The cues the app computed from the edit, rendered by earshot with the preset's sounds (a take that fails earshot's audit is rendered again), levelled against the music bed (the music segments mixed with FFmpeg on the timeline's clock), each placed so its sync point (onset, or a whoosh's peak) lands on its cue; sounds on the never-use list are rendered again as their stand-in. Then the stop-down: the music steps down 9 dB over the 0.4 s before every hit, drop, big whoosh and swell, always made from the bed as imported; a pass with no big moment asks for that take back. | `assets/<sha256>.wav` per take (and the ducked bed) |
| `sound-import` | One sound or music file (a library asset, or an upload) with its onset and peak measured, its level applied, placed so its onset or peak lands on the time; a music bed is cut to the video's end and faded out (1.5 s by default), from a moment of the file when asked. | `assets/<sha256>.wav` |
| `listen` | The frozen edit rendered as sound only (Remotion, WAV; mastered to the edit's loudness target when it has one, as the export will be), then earshot listens against the edit's own cue sheet in one process: the listening transcript with the sync of every cue, the scorecard against reference launch films, and an annotated sheet. The first listen loads earshot's models (about 30 s). | `listen/<job id>/sheet.png` |
| `sound-bank` | earshot's sound bank (252 sounds made in code) and its kit presets with their roles. | nothing (the app keeps it a week) |
| `sound-judge` | earshot's ears on any sounds: library audio (each decoded first to a 48 kHz WAV with the fenced FFmpeg, ten minutes at most) and bank sounds (rendered by earshot at their own settings). `action`: `describe` (tags, character, meters; with a description, its match z and verdict), `measure` (meters only, no models), `compare` (the first against two or more references), `rank` (by a description, or by closeness to a target sound), `find` (best moments in one sound, or with none the bank sounds that match a description best, a category narrowing it), `ab` (A then B against a description or references), `realness` (p_real and a verdict). Run offline: a model missing from earshot's cache fails the job with a sentence, never a download. | nothing: a compact answer (numbers and short words, files by their names, never a path) |
| `sound-make` | `forge`: a recipe's parameters searched toward a description by earshot's critic (designed mode, no references, budget 80 to 128 renders, earshot's own seed bank left alone), one to four candidates kept. `fit`: a library recording (30 s at most, decoded first) turned into code (earshot fit, kind auto) and rendered again. Offline, as the judge. | `assets/<sha256>.wav` per made sound, with its provenance (the recipe, the description and the critic's scores; or the recording it was fitted from and how close the fit is). Never placed on a video |
| `motion` | The motion check: the project's picture for the range (`from`/`to` seconds) rendered at half size with no sound, then watched frame by frame by `python/motion_analysis.py` (`watch`): how much of the time something moves, every move's length, peak speed and ease shape, spring overshoot, holds, empty frames, handoffs between beats (transform, crossfade, cut through an empty frame), compared with the bundled reference films (`python/references/`) and any library videos named (each measured once, kept in the work folder by its sha256), with what to fix first. Needs the `motionCheck` capability (below). | `checks/<job id>/`: `timeline.png`, each move's `*_onion.png` and `*_strip.png`, each handoff's strip, `motion.json`, `motion.txt`, `compare.txt` |
| `review` | The whole-video review: the same render with its sound (a silent track when it has none), cut into scenes by the script (`review`), with the words said, layers and clicks the app sends lined up, on-screen text read with `tesseract` when it is on `PATH` (otherwise left out, and the result says so), motion and sound per scene, flags (static, dead air, empty, small text, reading, mismatch, slow open) and, with reference videos, the style rows. Needs the `review` capability. | `checks/<job id>/`: `scenes.png`, `timeline.png`, `review.json`, `review.txt` |
| `look` | The visual check: frames every `step` seconds (0.5) where an overlay is settled on screen, rendered twice, with and without the overlays (full-frame scenes count as the picture); each overlay's footprint is the difference; per text layer its contrast against what is behind it (WCAG, 4.5:1 or 3:1 for big text), its size (under ~30 px at 1080p) and whether it runs off the frame; overlap with the person and their face where the worker has macOS Vision (`../vision`), otherwise reported as not measured. Any worker can do it. | `checks/<job id>/sheet.png` (each problem boxed, or a few frames when there are none), `report.json` |
| `cutout` | macOS only (see "Vision" below). Each recording asked for is staged, `subject-matte` finds the person (`person`, Vision's person segmentation) or any main subject (`subject`, foreground instances) in every frame at up to 1280 px and writes a greyscale matte frame for frame with it, and FFmpeg merges the two into a transparent VP9 WebM (the matte blurred 1.2 px as the alpha channel, CRF 30, no sound, the recording's shape at up to 1920 px). The WebM must match the recording frame for frame (±1) and keep its alpha (`alpha_mode` 1; libvpx decodes it as `yuva420p`). The app registers each cut-out and attaches it to the video (`cutouts`) as one undoable step. | `assets/<sha256>.webm`, one per recording |
| `faces` | macOS only. `face-track` reads each recording and finds the face boxes every 0.2 s (fractions, top-left origin) with which way the face is turned (yaw, pitch) and Vision's confidence. The app caches each track by the recording's bytes (`studio_record` collection `faces`), so a recording is tracked once; the director pass, a narrower format's crops and the checklist read it. | nothing (the tracks are the result) |

**Paid providers.** The worker says what it can do beyond media work with every claim and
progress report: `voiceover` when `ELEVENLABS_API_KEY` is set (narration, `voice-search`,
`revoice`, `sound-effect`, `music`: one key, one capability), `generatedShots` while the
`higgsfield` tool answers its account status (asked at start and every five minutes). The app
keeps that word about a minute, so the editor's narration and generation buttons, and the
agent's tools, exist only while such a worker runs. The provider kinds are asked for only while
their capability holds, by one slot of their own beside the media slots (provider calls wait on
the network and must not queue behind a long export); `continuity` rides in that slot too.
Generated shots need the tool installed and signed in where the worker runs: the container
image does not have it, so on the server they are off. They are a local worker's capability
(the owner's Mac) until a provider API key path exists.

**Sound.** Sound design runs [earshot](https://github.com/Leonxlnx/earshot) (ears and sound
effects for agents): an outside project under the MIT licence, used at the reviewed commit
`591fa3e028032e6dce56620a20e932e35667e8d8` (re-review its diff before moving the pin). It is
not a package of this worker: it lives in a folder of its own with its own Python 3.12
environment, named by `STUDIO_EARSHOT_DIR`, and the worker talks to it only through
`python/earshot_bridge.py` (one JSON request on stdin, one JSON answer on stdout, run with
earshot's own Python in isolated mode). At start and every five minutes the worker asks it for
its kit presets (a cheap call); while it answers, the worker tells the app `sound`, the
editor shows its ♪ Sound menu and the agent's sound tools work, and the worker asks for the
sound kinds (`sound-bank` in the quick slot, the rest in the media slots). Unset, or not
answering, the capability is simply absent. The jobs never edit a video: the app applies
what they made (`web/src/lib/studio/server/sound.ts`; judging and making sounds:
`sound-judge.ts`, whose made sounds are library assets the agent places itself). Each time `sound`
comes on, the worker also asks earshot's own health check (`doctor`: packages, models, data files,
offline) once and logs it in one line, so a missing listening model shows before a job needs it.
Installing it where the worker runs:

```bash
PIN=591fa3e028032e6dce56620a20e932e35667e8d8
git clone https://github.com/Leonxlnx/earshot.git ~/earshot && cd ~/earshot
git checkout "$PIN" && [ "$(git rev-parse HEAD)" = "$PIN" ]
uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python -e '.[mcp]'   # or: python3.12 -m venv .venv && .venv/bin/pip install -e '.[mcp]'
.venv/bin/python -m earshot doctor --fetch                                # fetches its models and data once
# then run the worker with STUDIO_EARSHOT_DIR=~/earshot
```

The container image does not include it yet, so on the server `sound` is off: it is a local
worker's capability (the owner's Mac) until the image installs it ("The image" below has the
lines that would).

**The measured checks.** `motion` and `review` run `python/motion_analysis.py` (numpy and
OpenCV, nothing else; FFmpeg for the sound levels) in the Python `STUDIO_ANALYSIS_PYTHON`
names, else `python3` on `PATH`. At start the worker asks it once to import both modules: when
it can, the worker tells the app `motionCheck` and `review` (the editor draws its Motion check
and Review buttons, the agent's check tools work) and asks for those jobs; when it can't, it
says why in one log line and never asks for them. The container image installs both
(`python3-numpy`, `python3-opencv`). A local worker on a Mac: `python3 -m venv <dir>` and
`<dir>/bin/pip install 'numpy>=1.26,<3' 'opencv-python-headless>=4.9,<5'`, then point
`STUDIO_ANALYSIS_PYTHON` at `<dir>/bin/python`. On-screen text in the review needs
`tesseract` on `PATH` (`brew install tesseract`, Debian `tesseract-ocr`); it is optional.
`python/references/` holds the motion measurements of the reference films the motion check
compares against (numbers only, under neutral names).

**Vision (macOS only).** Subject cut-outs (`cutout`) and face tracks (`faces`) use Apple's
Vision framework through three small Swift programs in `native/` (`subject-matte`,
`face-track`, `frame-subject`, each printing one JSON object a line). They are built with
`swiftc` the first time they are needed, into the work folder (`STUDIO_WORK_DIR/native/`),
and again only when their source changes (a receipt keeps the source's sha256); nothing is
signed, and nothing is downloaded, at build or at run time: Vision's models ship with macOS.
At start, on a Mac with the Xcode command-line tools, the worker builds all three in the
background (about 15 s) and runs each once on a made-up half-second grey clip as a self-test;
only when they pass does it tell the app `cutouts` and `faces` (the editor then shows "Isolate
the person", the format picker centres crops on faces, the director knows which camera the
person faces, and the agent's vision tools work). `cutout` jobs are taken in the media slots;
`faces` jobs, quick, also ride the provider slot, so a format's face check never waits behind an
export. On any other system nothing is built, neither capability is said, and the worker never
asks for those jobs: **the Linux container does not have them**. There the app refuses a
cut-out with a sentence, keeps crops centred and lets the director choose cameras without
faces. A Linux replacement would need a person-segmentation model (a matte per frame, white =
the person) and a face detector (boxes with a confidence, ideally the face's yaw), both shipped
in the image, behind the same two job kinds and capabilities. `src/vision/subject.ts`
(`facesAndPersonAt`, `subjectsOfFrames`) answers where the person and their face are at given
moments of a video or in drawn frames, for the visual check.

**What a job can make the worker do.** Every string and file in a job's input is someone's text, so:
the ads' kits, batches, briefs and reels are checked against the contract's schemas again before
anything is drawn (font names, veils and shades, a sound's audio filters, copy-rule patterns and
grade names each held to a grammar), and every value is escaped for where it goes
(`src/ads/escape.ts`); the ads' pages are served from the job's own scratch folder at a made-up
origin, every other request refused, in a browser started with no route to any network and a
minimal environment (`src/ads/fence.ts`, `src/ads/browser.ts`); a kit's copy rules run with a
time limit (`src/ads/patterns.ts`); FFmpeg opens local files and pipes only, labels and uploads
never enter a filter graph, an uploaded sound is decoded to a WAV before earshot sees it;
earshot, the analysis, the Vision helpers and the generation tool run with a minimal environment
in a process group of their own (`src/child.ts`), the tool in the job's scratch folder with
only the media the job staged; and a paid job that has spent is completed with its charge,
whatever happens after (`src/runner.ts`).

**Rendering.** The engine's Remotion entry (`web/src/lib/studio/engine/remotion.tsx`) is
bundled once per process and kept in the work folder under a key made from the engine
files' names, sizes and mtimes, so it is made again only when the engine changes (a few
seconds with Remotion's Rspack bundler). The bundle's public folder holds a link to the
asset cache as `assets/`, so `staticFile('assets/<sha256>.<ext>')` in the composition reads
the cached file itself. Renders use `STUDIO_RENDER_CONCURRENCY` Chrome tabs (2).

**Not staged yet.** Fonts a job does not carry (text layers and captions draw in the
fallback stack); the job's log says so.

**Code scenes.** A `code` layer plays a graphic the agent wrote as React code
(`web/src/lib/studio/server/scenes.ts`). Its code never runs in the composition's page: the
layer holds a locked frame (`web/src/lib/studio/engine/scene-frame/protocol.ts`), two nested
`<iframe sandbox="allow-scripts">` (no same origin, so no cookies, storage or way into the
page), whose documents carry one policy: no request of any kind (`default-src 'none'`,
`connect-src`, `frame-src`, `form-action` and the rest `'none'`; images and fonts only from
bytes handed in), and scripts only by hash (the relay, the bootstrap, the runtime and this
scene). The outer frame's `frame-src 'none'` also stops the inner one navigating itself
anywhere. The layer sends the scene's module once and then each frame number; the frame
answers when that frame is painted, and the render waits for it (`delayRender`). A scene
that fails, or does not draw a frame within 15 s (30 s for its first), fails the render
with a sentence naming it. The frame's runtime (React, Remotion, the scene kit) is built
into the bundle's public folder when the bundle is made (`studio-scene/frame-runtime.js`,
the same script the app serves to the editor's preview); each scene's module is read from
the job's workspace (`scenes/<id>.js`, checked against its sha256) into `public/scenes/`,
every time, even when the bundle (shared by every job on the worker) has that id already.
A scene that never gives its thread back stops the render's page too (the headless shell runs
the frame on the page's thread), so the 15 s limit cannot fire and the render fails only at
Remotion's own timeout (about two minutes).

The frame's only walls are the browser's origin checks and its policy, and the render's
Chrome is not otherwise fenced: Remotion launches it with `--no-sandbox` and site isolation
off, and it inherits the worker's environment (`STUDIO_WORKER_SECRET`, the providers' keys),
its files (every job's scratch and the shared bundles) and its network. Any flaw in Chrome
that a scene can reach is then the worker's. So code scenes are a setting,
`STUDIO_CODE_SCENES`, read the same way by the app and by this worker: on outside
production, **off in production on the app AND the worker unless `STUDIO_CODE_SCENES=on` is
set on each**. Off on this worker, an export, stills or a check of a video with code scenes
is refused with a sentence naming them, and a thumbnail and a sound-only render draw each
scene as a labelled box without loading its code. Off on the app, nothing writes a scene or puts
one on a video, and the editor draws code layers as labelled boxes without loading the frame
or the scene's code (a viewer's browser can still be made to look up a host name and open a
connection to it, see the test's header). Turning it on in production is the owner's call.
`test/scene-frame-e2e.ts` mounts the real frame in Chrome under the app's own policy and
proves a hostile scene reaches nothing (cookies, storage, the page's DOM, any request,
navigation, a host name in the net log) in the headless shell; a full Chrome still
preconnects to where a refused navigation was headed (the file's header says more);
`test/scene-export-e2e.ts` exports a made-up video with a scene through this
worker and reads its frames back.

**The asset cache.** Every asset downloaded or imported is kept in the work folder,
content-addressed, so the next render of the same project fetches nothing. Past
`STUDIO_CACHE_BYTES` (5 GB) the least recently used files go first; a file a running job
uses is never removed. Each job's own scratch folder is removed when it ends, whatever
happened.

## Running it against `next dev`

Node 24, FFmpeg and ffprobe on `PATH` (`brew install ffmpeg`); for decks, poppler
(`brew install poppler`) and LibreOffice (`brew install --cask libreoffice`). The worker
imports the engine from `../web`, so `web/node_modules` must be installed (`npm ci` in
`web/`).

```bash
cd studio-worker
npm ci
# The app's STUDIO_WORKER_SECRET must match; both default to dev-studio-worker outside production.
STUDIO_APP_URL=http://localhost:3000 npm start
```

The first render downloads Remotion's Chrome headless shell (a few hundred MB) into
`node_modules/.remotion`. To use one already on the machine, point `STUDIO_CHROME` at it
(the executable, or a folder it is somewhere inside).

## Settings

All from the environment; an empty value counts as unset. `.env.example` lists them. For a
local run, `npm start` also reads a `.env` file beside `package.json` when there is one
(never committed; a value already in the environment wins over the file).

| Setting | Default | What it is |
| --- | --- | --- |
| `STUDIO_APP_URL` | `http://localhost:3000` | The app's origin. On the server, the app stack's proxy on its own network: `http://ni-app-proxy:8080`. |
| `STUDIO_WORKER_SECRET` | `dev-studio-worker` outside production | Sent with every request. Required with `NODE_ENV=production`, where the development value is refused. |
| `STUDIO_WORKER_ID` | host-pid | Its name on the jobs it claims. |
| `STUDIO_WORKER_KINDS` | all | The kinds it takes, comma separated (the provider kinds still only while their capability holds). |
| `STUDIO_WORKER_CONCURRENCY` | 1 | Jobs at once. |
| `STUDIO_WORKER_POLL_MS` | 2000 | How often it asks for work when idle. |
| `STUDIO_WORK_DIR` | `<tmp>/studio-worker` | Scratch, the bundle and the asset cache. |
| `STUDIO_CACHE_BYTES` | 5 GB | The asset cache's bound. |
| `STUDIO_RENDER_CONCURRENCY` | 2 | Chrome tabs per render. |
| `STUDIO_CHROME` | Remotion's own | A Chrome headless shell to render in. |
| `STUDIO_ENGINE_DIR` | `../web/src/lib/studio/engine` | The engine's folder (the bundle's entry is `remotion.tsx` in it). |
| `STUDIO_HEALTH_PORT` | 9092 | The health answer on 127.0.0.1 (0: none). |
| `STUDIO_SHUTDOWN_GRACE_MS` | 25000 | After SIGTERM, how long a running job may still take. |
| `DEEPGRAM_API_KEY` | none | Deepgram's key, for `transcribe`. |
| `DEEPGRAM_URL` | Deepgram's prerecorded endpoint | A test's fake. |
| `ELEVENLABS_API_KEY` | none | ElevenLabs' key, for `voices`, `narration`, `voice-search`, `revoice`, `sound-effect` and `music` (the `voiceover` capability). The same per-workspace gate as narration applies to all of them (`STUDIO_PROVIDER_WORKSPACES` in the app). |
| `ELEVENLABS_URL` | `https://api.elevenlabs.io` | https only; a test's fake on this machine may be http. |
| `STUDIO_HIGGSFIELD_BIN` | `higgsfield` on PATH | The higgsfield tool, signed in, for `shot-quote` and `shot` (the `generatedShots` capability). |
| `STUDIO_EARSHOT_DIR` | none | An installed earshot (its folder, holding `.venv`), for `sounds`, `sound-import`, `listen`, `sound-bank`, `sound-judge` and `sound-make` (the `sound` capability, while it answers). |
| `EARSHOT_THREADS` | 3 | Threads earshot's models use. |
| `STUDIO_ANALYSIS_PYTHON` | `python3` on PATH | A Python with numpy and OpenCV, for `motion` and `review` (the `motionCheck` and `review` capabilities). |
| `STUDIO_ANALYSIS_TESSERACT` | `tesseract` on PATH | The text reader the review reads on-screen text with (optional). |
| `STUDIO_CODE_SCENES` | on, off with `NODE_ENV=production` | Whether renders run code scenes' code in their locked frame (`on`/`off`). Off, a render of a video with code scenes is refused with a sentence. |

## Working on it

```bash
npm ci
npm test            # the pure parts, and the app client against a fake app
npm run typecheck
npm run e2e         # the real worker against a fake app: real FFmpeg, Remotion and Chrome
```

`test/sound-e2e.ts` runs the sound jobs' handlers with the real earshot against the fake app
(`STUDIO_EARSHOT_DIR=<earshot folder> node --import tsx test/sound-e2e.ts`): the bank; the
automatic pass over a made-up project with two text entrances and a zoom punch, levelled against
a synthetic bed, each take's sync point measured from the stored file against its cue (within a
frame), and the bed stepped down before the hit; a click imported on its onset; and a listen
over the mix with the sounds applied, the sheet copied to `STUDIO_SOUND_OUT` for a look. It
renders and loads models: one heavy run at a time.

`test/sound-judge-e2e.ts` runs the judge and make jobs the same way
(`STUDIO_EARSHOT_DIR=<earshot folder> node --import tsx test/sound-judge-e2e.ts`): the doctor;
a bank pop described against a description and measured; three bank sounds ranked against a
description; two sounds forged from a description, stored, then ranked; and a made-up knock (made
with FFmpeg) fitted and A/B-ed against its resynthesis. The made WAVs and every answer go to
`STUDIO_SOUND_OUT`. `test/sound-judge.test.ts` (in `npm test`) runs the real bridge against a fake
earshot package, so the new commands are checked without earshot installed.

`npm run e2e` (`test/e2e.ts`) starts a fake app that speaks the job contract in memory
(`test/fake-app.ts`, every body checked with the contract's own schemas, blobs cut into
small parts on disk), makes test media with FFmpeg's test sources, and runs the worker as
the image does. It imports an MP4, a browser-style WebM both conformed and as it is, a
variable-rate MP4 (conformed to 30 fps), a PNG and a WAV; renders an export and checks it with ffprobe
(about 3 s, H.264 and AAC, 1280×720) and against the source (PSNR, loudness); renders
stills and a thumbnail; turns a PDF (and, with LibreOffice installed, a PowerPoint) into
pages; transcribes against a fake Deepgram; cancels one export before it starts and one
while it renders; and stops the worker with SIGTERM in the middle of a render. The bundle
is kept between runs in `STUDIO_E2E_WORK_DIR`; `STUDIO_E2E_KEEP=1` keeps the media and
outputs for a look.

`test/vision-e2e.ts` (macOS only) builds the Vision helpers in a fresh work folder, runs the
start-up self-test, then one real `cutout` and one `faces` job through the worker's runner and
app client against the fake app: a made-up two-second 1280×720 clip (a bright disc drifting
over a flat colour) cut out in `subject` mode, the stored WebM checked to be VP9 with an alpha
channel decoded as `yuva420p`, frame for frame with the clip, a valid library asset, with alpha
that keeps the disc. `STUDIO_VISION_CLIP=<clip>` and `STUDIO_VISION_MODE=person|subject` run it
on another made-up clip (never footage of a real person):
`node --import tsx test/vision-e2e.ts`. Runs swiftc and FFmpeg: one heavy run at a time.

`test/checks-e2e.ts` does the same for the measured checks: a made-up 6 s blank-canvas video (a
headline that blurs in, a small faint line that slides in two seconds later) through `motion`,
`look` and `review`, the pictures copied to `STUDIO_CHECKS_OUT` to look at. It needs the
analysis: `STUDIO_ANALYSIS_PYTHON=<python> node --import tsx test/checks-e2e.ts`.

## The image

`Dockerfile` (built from the repository's root, `Dockerfile.dockerignore` beside it)
installs FFmpeg, poppler, LibreOffice Impress, fonts and Chrome's libraries on the app's
own Node 24 base, the engine's few packages from `engine-deps/` as `web/`, the worker's
packages, and Remotion's Chrome headless shell at build time. **It was first built on the
server on 2026-11-12** (about 2.8 GB). That first image lacked three contract files the
job contract imports and died at start; with them mounted in, the worker started and
offered its job kinds, and `test/image-files.test.ts` now holds the Dockerfile to what the
code reaches. A render, a deck and a transcript have not been run in the container yet:
the worker's jobs are proven on macOS by the end-to-end run above. The image's Python has
no fontTools, so an ad's knocked-out word is drawn as text there, not as its outline (the
ad says so in a note). Deployment is [`deploy/studio`](../deploy/studio).

The image does not install earshot (see "Sound"), so a worker in it never offers `sound`. It
already copies `studio-worker/python` (the bridge and the analysis script, with
`!studio-worker/python` in `Dockerfile.dockerignore`) and Debian's `python3` (with numpy and
OpenCV). The lines that WOULD install earshot at the pinned commit go after the `apt-get` steps,
with `git` and `python3-pip` added to their packages (Debian bookworm's Python is 3.11, so `uv`
fetches a 3.12); untested, and its models (a few hundred MB) are fetched at build time:

```dockerfile
# ARG EARSHOT_PIN=591fa3e028032e6dce56620a20e932e35667e8d8
# RUN pip3 install --break-system-packages uv \
# 	&& git clone https://github.com/Leonxlnx/earshot.git /opt/earshot \
# 	&& cd /opt/earshot && git checkout "$EARSHOT_PIN" && test "$(git rev-parse HEAD)" = "$EARSHOT_PIN" \
# 	&& uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python -e '.[mcp]' \
# 	&& .venv/bin/python -m earshot doctor --fetch \
# 	&& chown -R node:node /opt/earshot
# ENV STUDIO_EARSHOT_DIR=/opt/earshot
```

## Remotion's licence

Rendering uses [Remotion](https://www.remotion.dev), which is source-available under its
own licence, not an open-source one: it is free for individuals and for companies of up
to three people; larger companies need a company licence
([remotion.dev/license](https://www.remotion.dev/license)). Whoever runs this worker must
comply with it.

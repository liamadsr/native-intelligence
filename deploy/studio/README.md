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

**What it may use.** At most 4 CPUs and 6 GB: a render is Chrome drawing frames in 2 tabs
and FFmpeg encoding them, as fast as it is given cores. Shared memory is 1 GB (Chrome keeps
pages there). The root is read-only; scratch is the volume and a 2 GB `/tmp`.

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
(it has not been built anywhere yet), Chrome's headless shell starting in it under the
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

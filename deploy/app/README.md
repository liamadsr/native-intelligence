# The app as containers

One image that runs the web app (`web/`) and its eight eve agents off their earlier
host (Vercel), the stack that runs it on the server (`compose.yaml`), and a
container test of the same image (`smoke/`).

The server itself (its public Caddy in `../edge/`, the self-hosted Inngest in
`../inngest/`, Supabase in `../supabase/`, backups) is set up by
[`../README.md`](../README.md). Step 20 there is how this stack is set up, rehearsed
next to the earlier host, and switched on; step 21 is the switch of the real names.

## On the server

```text
deploy/app/
├── compose.yaml      the stack: proxy, web, worker, eight agents, cron (project ni-app)
├── .env              its settings (root only, never in git; .env.example lists them)
├── deploy.sh         build the image here and roll it out; --rollback goes back
├── pull-settings.sh  run on your own machine: fills .env from the earlier host
├── check-settings.sh run on your own machine: checks .env before the switch
└── proxy/Caddyfile   the stack's router
```

The edge Caddy (`../edge`) is the only thing with public ports. It sends every name
in `APP_HOSTS` (its `.env`) to this stack's proxy, `ni-app-proxy`, the one
container of the stack on the shared network `ni-edge`. The proxy sends
`/eve/<name>/v1/*` to that agent, `/api/inngest` to the worker, and everything else
to web. The app's containers sit on their own network, `ni-app`, which has a way out
to the internet and nothing else on it.

The app calls itself through its public address: web reaches the agents at
`$NEXT_PUBLIC_APP_URL/eve/<name>/v1/*`, the agents call web back at
`$NEXT_PUBLIC_APP_URL/api/internal/*`, and both reach Supabase and Inngest at their
public names. All of that leaves the container, enters the edge Caddy on this same
server, and comes back in. It works because Docker sends a container's request for
the server's own public address to the published ports (checked: a container on its
own network got `401` from `sb.nativeintelligence.dev/auth/v1/health`).

| To | Command (from this folder) |
|---|---|
| Ship what is checked out | `git pull` as the checkout's owner, then `sudo ./deploy.sh` |
| Go back to the image before | `sudo ./deploy.sh --rollback` |
| See what runs | `sudo docker compose ps` |
| Read a part's log | `sudo docker compose logs -f --tail 100 web` (`worker`, `cron`, `agent-chat-agent`, `proxy` …) |
| Which commit runs | `sudo docker image inspect ni-app:live -f '{{index .Config.Labels "org.opencontainers.image.revision"}}'` |
| Restart one part | `sudo docker compose restart agent-chat-agent` |
| Call one scheduled job now | `sudo docker compose exec cron node /app/deploy/app/cron/call.mjs /api/cron/<name>` |

Logs are Docker's own, capped at 5 files of 20 MB per container (step 6 of
`../README.md`); nothing ships them anywhere else. Errors also go to Sentry when
`NEXT_PUBLIC_SENTRY_DSN` was set when the image was built.

### deploy.sh

Builds the image from the checkout (about ten minutes the first time, less once its
layers are cached) while the running one keeps serving, keeps the running image as
`ni-app:previous`, then replaces the containers: the agents one by one (each stops
before its new one starts: eve's file store allows one process per agent, so a
reply streaming from that agent at that moment is cut), the worker and web without
a gap (a second container starts beside the first, takes requests once healthy, and
the first stops with its grace period: 900 s and 120 s), and the scheduler last (a
job that is running is let finish). `--rollback` swaps the two images and rolls out
again, without a build. One request can still fail in a replacement: one already
sent to the old web or worker on a kept-open connection at the moment it closes.
Every image is labelled with the public address it was built for (`ni.app-url`),
and `deploy.sh` refuses to put one into service while `.env` names another: the
rehearsal's image, built for the test address, never serves production.

Merging to `main` does not deploy here. Someone runs `git pull` and `deploy.sh` on
the server.

### NI_LIVE: rehearsal or production

One line in `.env`. Until it is exactly `1`, `entrypoint.sh` keeps the copy from
acting on its own:

- the scheduler logs each job and calls nothing;
- web and worker point the Inngest SDK's registration at a closed port. Anyone can
  ask an app to register its functions (a `PUT` to `/api/inngest` needs no
  signature), and a copy that registered with production's Inngest server, under
  production's app id and keys, would take every background job of production. Its
  events still reach Inngest.

Everything a person does on a rehearsal copy is real: it uses the production
database. What it does not do is anything nobody asked it to. With `NI_LIVE=1` the
containers also refuse to start while a value in `.env` still starts with
`rehearsal-` (the stand-ins `pull-settings.sh` writes for a rehearsal).

### Settings

`pull-settings.sh` fills `.env` without showing a value. The earlier host gives out
its production settings, except those stored as write-only ("sensitive"): nobody can
read those back, so they are entered by hand with
`deploy/supabase/set-secret.sh` (hidden typing, several names at once; an empty
answer leaves that one as it is), from the password manager or from the provider
that issued them. `check-settings.sh` then says, without showing a value, which are
set and, where the server can tell, which are right (`../README.md` step 21, Gate 1).

Some values must be exactly what the earlier host has, because what they sign or
encrypt is already stored or held elsewhere:

| Setting | Why it must not change | Checked against |
|---|---|---|
| `CREDENTIAL_ENCRYPTION_KEY` | Encrypts every connected account's tokens in the database. | Every stored ciphertext must open. |
| `RUN_SKILL_INTERNAL_SECRET` | Keys the stored link, invite and phone-code hashes, and the reply codes already texted. | A stored phone code's hash must come out of it. |
| `CLOUD_BROWSER_SIGNING_KEY` | Its public half is built into released desktop apps. | That pinned public key. |
| `UNSUBSCRIBE_SECRET` | Signs the unsubscribe links in mail already sent. | Readable; `pull-settings.sh` brings it. |
| `OUTLOOK_WEBHOOK_SECRET`, `GMAIL_WEBHOOK_TOKEN` | Part of every live mail subscription. | Readable; brought. |
| `GPT_LIVE_TRUNK_SECRET` | The phone trunk sends it with every call. | The Twilio trunk's origination address (`--fill` brings it from there). |
| `GPT_LIVE_WEBHOOK_SECRET`, `LINEAR_WEBHOOK_SECRET` | The provider signs its webhooks with it. | Nothing here: the provider's dashboard. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | The number, the messaging service and the trunk belong to that account; Twilio signs its webhooks with the account's current token. | Twilio accepts them; the number and the service are the account's. |
| `STRIPE_SECRET_KEY` | Any secret key of the account and mode the stored customers and prices are in. | Stored customers read with it. |
| The OAuth apps' client ids (`*_CLIENT_ID`) | Stored connections were made with that app: keep the app, and its client secret may be a new one. | Nothing here: a connection's next refresh. |
| `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY` | The Inngest server's; `pull-settings.sh` copies them from `../inngest/.env`. | |

**Exactly** means byte for byte. Two of the readable values on the earlier host
(`OAUTH_STATE_SECRET`, `OUTLOOK_WEBHOOK_SECRET`) end in a line break, almost
certainly pasted with one, and the app uses them with it; `pull-settings.sh`
carries it. A write-only value may have one too, and `set-secret.sh` trims what is
typed: give such a name to `set-secret.sh` as `NAME+nl` to keep it. For
`RUN_SKILL_INTERNAL_SECRET`, `check-settings.sh` says which form is production's.
After the switch, before the earlier host is retired, check what only real use
shows: an unsubscribe link from an old mail, a connected account that still syncs.

These may be new on the server (`PULL_GENERATE=1` makes the first three):

- `AGENT_RUN_INTERNAL_SECRET`: run tokens of an hour, and the coding sandbox's push
  token of six; only runs in flight across the switch fail.
- `CHAT_INTERNAL_SECRET`: chat-run tokens of an hour or so. Usage rows the chat
  agent left in `chat_usage_outbox` within the last half hour are then billed to the
  session's owner rather than the token's payer.
- `LOCAL_AGENT_TOKEN_SECRET`: the Mac's model token, valid two hours. A job running
  on a Mac across the switch is refused until its token is renewed, which happens at
  three quarters of its life or when the page reloads.
- `BROWSER_INTERNAL_SECRET`: cloud browsers running at the switch hold relay tokens
  made with it for up to six hours; they have to be opened again.

Each of them falls back to `RUN_SKILL_INTERNAL_SECRET` when empty
(`web/src/lib/eve/internal-secret.ts`), so give each its own value.

## The container test

From the repository root, with Docker and Compose, on any machine but the server:

```bash
docker compose -f deploy/app/smoke/compose.yaml build web
```

```bash
deploy/app/smoke.sh
```

The first command builds the image (about ten minutes with no cache). The second
starts web, worker, the eight agents, cron and the proxy with made-up values, waits
until every container is healthy, checks that each role answers, and removes
everything again, its volumes included. It needs no secret. `NI_KEEP=1
deploy/app/smoke.sh` leaves the stack running at `http://127.0.0.1:8080`. Its
project is called `app-smoke`, not `ni-app`, so that its clean-up can never reach the
server's stack.

`.github/workflows/image.yml` runs the same two steps on every pull request that
touches this folder or what the image is built from (web's dependencies, patches,
`next.config.mjs`, the agents, `web/vercel.json`), and runs the web test suite as a
separate job.

## One image, four roles

The role is the container's command (`entrypoint.sh`):

| Command | What runs |
|---|---|
| `web` | `next start`. `/eve/<name>/v1/*` is sent to agents that run elsewhere. |
| `worker` | The same server. Route only `/api/inngest` to it. |
| `agent <name>` | One agent's built server, as `eve start` runs it (`entrypoint.sh` says what differs). |
| `cron` | supercronic with `cron/crontab`: calls the web role's `/api/cron/*` routes. |

Every role runs as the `node` user. web, worker and each agent listen on `$PORT`
(3000); cron listens on nothing. The image's health check asks the role's own
route: `/api/version` for web; `/api/inngest` for the worker, which must report
functions and a signing key; `/eve/v1/health` for an agent. For cron it checks
that supercronic is running.

No role starts with Inngest or eve in development mode (`INNGEST_DEV` set to
anything the Inngest SDK reads as on, or `EVE_DEV=1`): both skip the checks that
keep strangers out. `INNGEST_DEV=0` is allowed.

Each role exits on its own when Docker sends SIGTERM, and both stacks give each a
`stop_grace_period` to finish what is in flight: 120 s for web, 900 s for the worker
and cron, 60 s for an agent. A phone call (GPT-Live) runs inside web for up to ten
minutes, so a deploy that replaces web cuts a call older than its 120 s.

The image also carries the commit it was built from (`/app/BUILD_ID`, from
`deploy.sh`). The app reads it as `VERCEL_GIT_COMMIT_SHA`, the name its earlier host
gave it: it becomes the build id that open windows compare to reload after a deploy,
and the cloud browser's relay is built with it and must report the same one.

## What is fixed when the image is built

`next build` compiles these into the web role, so they are build arguments
(`Dockerfile`), not something a container can change when it starts.
`NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
and `EVE_NEXT_PRODUCTION_ORIGIN` have no defaults: the build stops at once without
them. Only `smoke/compose.yaml` fills them with made-up values, for the container
test. On the server they come from `.env`, and changing one needs a new build.

- Every `NEXT_PUBLIC_*` value, in server code as well as the browser's. That
  includes `NEXT_PUBLIC_APP_URL`, which is where the web role calls the agents, and
  `NEXT_PUBLIC_SENTRY_DSN`, without which Sentry is off in the browser and on the
  server.
- `NEXT_PUBLIC_SUPABASE_PROJECT_REF`, one of those values, is optional and empty by
  default. It pins the session cookie's name for a project whose address has moved
  (`web/src/lib/supabase/project.ts`). Two agents read the same cookie and take the
  value from their environment when they start, so the build argument and the
  running containers must agree: change it in `.env`, then build again.
- `EVE_NEXT_PRODUCTION_ORIGIN`, the origin the web role forwards
  `/eve/<name>/v1/*` to. `entrypoint.sh` refuses to start the web role under a
  different value.

The agents read their environment when they start.

## The proxy

`proxy/Caddyfile` gives the stack one origin. It sends `/eve/<name>/v1/*` straight
to that agent's container, because Next's own rewrite proxy gives up after 30
seconds and an agent's stream can run far longer. `/api/inngest` goes to the
worker and everything else to web.

It keeps the `X-Forwarded-*` headers of a proxy in front of it on a private
address, so the app sees the public `https://` origin and each client's own
address. That is safe only while this proxy is never published to the internet. On
the server the proxy in front is the edge Caddy, over `ni-edge`; the edge removes
the `X-NI-Upstream` header the proxy adds for the container test.

web and worker are found by name each second (`dynamic a`), so a second container
of either is used as soon as it is up, and one that has stopped taking requests is
skipped: that is what lets `deploy.sh` replace them without a gap.

## State

web and worker write into their own folder: Next's cache, the docs index
(`.source`, rewritten at each start) and every page Next regenerates, which it
saves beside the built ones in `.next/server/app`. So those two containers are not
read-only; the agents and cron are.

An agent writes in two places, and both stacks put a volume on each (on the server
they are named `ni-app-<agent>-workflow` and `ni-app-<agent>-sandbox`, which is how
the move script and the backups find them):

- `agents/<name>/.eve/.workflow-data`: its workflow runs.
- `agents/<name>/.eve/sandbox-cache/just-bash/sessions`: its sandbox's files, per
  session.

The rest of `agents/<name>/.eve` is written by `eve build` (the sandbox template)
and has to come from the image, so the volumes are not on `.eve` itself: a volume
there would keep the first image's template after an upgrade.

eve's default workflow store is these local files, and it allows one process per
agent: do not scale an agent service past one container. When an agent starts it
resumes the runs it finds unfinished there.

That store does not honour `experimental.workflow.retention: 0`, which two agents
(utility and web-research) set so that the mail text and other workspace content in
their runs is deleted as soon as a run ends. Here it stays on their volumes. The
nightly backup leaves those two volumes out (`../backup/compose.app.yaml`); deleting
their finished runs on the server is still to be written ("Not done" under
[steps 20 to 22](../README.md#steps-20-to-22-the-app) in `../README.md`).

Backups: every other agent's two volumes, nightly, 7 days kept
(`../backup/compose.app.yaml`).

## Cron

`cron/crontab` is generated from the `crons` array in `web/vercel.json`:

```bash
node deploy/app/cron/generate.mjs
```

Run it after changing `web/vercel.json` and commit the result. The `--check` flag
fails when the two disagree; the image build and `.github/workflows/crontab.yml`
both run it.

Each job is one `GET` with `Authorization: Bearer $CRON_SECRET` (`cron/call.mjs`),
at the same UTC times as Vercel Cron. Two differences from Vercel:

- supercronic does not start a job again while its last run is still going; Vercel
  would. A route that hangs therefore delays its own next run.
- Nothing ends a route at its `maxDuration`: `next start` ignores it. `call.mjs`
  gives up after 15 minutes, which does not stop the work on the server.

In the container test the scheduler is a dry run (`CRON_DRY_RUN=1` in
`smoke/compose.yaml`), and on the server it is one until `NI_LIVE=1`: it logs each
job and calls nothing. Never let it run while the earlier host's own scheduled jobs
still run the same schedule against the same database: switch those off first
(`../README.md`, step 21).

## Files

| File | What it is |
|---|---|
| `Dockerfile`, `Dockerfile.dockerignore` | The image, built from the repository root. |
| `build-agents.sh` | The eight `eve build`s, and the list of agents. |
| `entrypoint.sh`, `healthcheck.mjs`, `eve-origin.mjs` | Starting a role, and checking it. |
| `cron/` | The crontab, its generator, and the one authenticated call each job makes. |
| `proxy/Caddyfile` | The stack's router, on the server and in the test. |
| `compose.yaml`, `.env.example` | The stack on the server, and its settings. |
| `deploy.sh` | Build and roll out on the server, or go back. |
| `pull-settings.sh` | Fill the server's `.env` from the earlier host, unseen. |
| `check-settings.sh`, `check_settings.py` | Check the server's `.env` before the switch, unseen; `tests/` is its test. |
| `smoke/compose.yaml`, `smoke/.env.example` | The container test's stack. |
| `smoke.sh` | The container test. |

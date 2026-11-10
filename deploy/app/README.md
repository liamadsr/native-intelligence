# The app as containers

One image that runs the web app (`web/`) and its eight eve agents off Vercel, and a
Docker Compose stack that starts every part of it on one machine. It is a test that
the app builds and starts in containers. It is not the production setup, and it
changes nothing about how the app runs on Vercel.

The server itself (its public Caddy in `../edge/`, the self-hosted Inngest in
`../inngest/`, backups) is set up by [`../README.md`](../README.md). Nothing from
this folder runs there yet. This stack's own proxy publishes port 8080 on
127.0.0.1 for the test; that is not the way onto the server, where only the edge
Caddy publishes ports.

## Try it

From the repository root, with Docker and Compose:

```bash
docker compose -f deploy/app/compose.yaml build web
```

```bash
deploy/app/smoke.sh
```

The first command builds the image (about ten minutes with no cache). The second
starts web, worker, the eight agents, cron and a proxy with made-up values, waits
until every container is healthy, checks that each role answers, and removes
everything again. It needs no secret. `NI_KEEP=1 deploy/app/smoke.sh` leaves the
stack running at `http://127.0.0.1:8080`.

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

Each role exits on its own when Docker sends SIGTERM, and `compose.yaml` gives
each a `stop_grace_period` to finish what is in flight: 120 s for web, 900 s for the
worker and cron, 60 s for an agent.

## What is fixed when the image is built

`next build` compiles these into the web role, so they are build arguments
(`Dockerfile`), not something a container can change when it starts.
`NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
and `EVE_NEXT_PRODUCTION_ORIGIN` have no defaults: the build stops at once without
them. Only `compose.yaml` fills them with made-up values, for the container test.

- Every `NEXT_PUBLIC_*` value, in server code as well as the browser's. That
  includes `NEXT_PUBLIC_APP_URL`, which is where the web role calls the agents.
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
address. That is safe only while this proxy is never published to the internet.

## State

web and worker write into their own folder: Next's cache, the docs index
(`.source`, rewritten at each start) and every page Next regenerates, which it
saves beside the built ones in `.next/server/app`. So those two containers are not
read-only; the agents and cron are.

An agent writes in two places, and `compose.yaml` puts a volume on each:

- `agents/<name>/.eve/.workflow-data`: its workflow runs.
- `agents/<name>/.eve/sandbox-cache/just-bash/sessions`: its sandbox's files, per
  session.

The rest of `agents/<name>/.eve` is written by `eve build` (the sandbox template)
and has to come from the image, so the volumes are not on `.eve` itself: a volume
there would keep the first image's template after an upgrade.

eve's default workflow store is these local files, and it allows one process per
agent: do not scale an agent service past one container.

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

In the test stack the scheduler is a dry run (`CRON_DRY_RUN=1` in `compose.yaml`):
it logs each job and calls nothing. Do not turn that off while Vercel Cron still
runs the same schedule against the same database.

## Files

| File | What it is |
|---|---|
| `Dockerfile`, `Dockerfile.dockerignore` | The image, built from the repository root. |
| `build-agents.sh` | The eight `eve build`s, and the list of agents. |
| `entrypoint.sh`, `healthcheck.mjs`, `eve-origin.mjs` | Starting a role, and checking it. |
| `cron/` | The crontab, its generator, and the one authenticated call each job makes. |
| `proxy/Caddyfile` | The test stack's proxy. |
| `compose.yaml`, `.env.example` | The test stack. |
| `smoke.sh` | The test. |

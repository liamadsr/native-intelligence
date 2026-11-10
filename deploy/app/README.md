# The app as containers

One image that runs the web app (`web/`) and its eight eve agents off Vercel, and a
Docker Compose stack that starts every part of it on one machine. It is a test that
the app builds and starts in containers. It is not the production setup, and it
changes nothing about how the app runs on Vercel.

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
touches this folder, and runs the web test suite as a separate job.

## One image, four roles

The role is the container's command (`entrypoint.sh`):

| Command | What runs |
|---|---|
| `web` | `next start`. `/eve/<name>/v1/*` is sent to agents that run elsewhere. |
| `worker` | The same server. Route only `/api/inngest` to it. |
| `agent <name>` | `eve start` for one agent. |
| `cron` | supercronic with `cron/crontab`: calls the web role's `/api/cron/*` routes. |

All roles listen on `$PORT` (3000) and run as the `node` user. The image's health
check asks the role's own route: `/api/version` for web and worker,
`/eve/v1/health` for an agent.

## What is fixed when the image is built

`next build` compiles these into the web role, so they are build arguments
(`Dockerfile`), not something a container can change when it starts:

- Every `NEXT_PUBLIC_*` value, in server code as well as the browser's. That
  includes `NEXT_PUBLIC_APP_URL`, which is where the web role calls the agents.
- `EVE_NEXT_PRODUCTION_ORIGIN`, the origin the web role forwards
  `/eve/<name>/v1/*` to. `entrypoint.sh` refuses to start the web role under a
  different value.

The agents read their environment when they start.

## The proxy

`proxy/Caddyfile` gives the stack one origin. It sends `/eve/<name>/v1/*` straight
to that agent's container, because Next's own rewrite proxy gives up after 30
seconds and an agent's stream can run far longer. `/api/inngest` goes to the
worker and everything else to web.

## State

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

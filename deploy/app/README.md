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
├── auto-deploy.sh    automatic deploys of main (off unless switched on), see below
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
| See what the automatic deploys did, or why they hold | `sudo ./auto-deploy.sh status` ([Automatic deploys](#automatic-deploys)) |
| See what runs | `sudo docker compose ps` |
| Read a part's log | `sudo docker compose logs -f --tail 100 web` (`worker`, `cron`, `agent-chat-agent`, `proxy` …) |
| Which commit runs | `sudo docker image inspect ni-app:live -f '{{index .Config.Labels "org.opencontainers.image.revision"}}'` |
| Restart one part | `sudo docker compose restart agent-chat-agent` |
| Call one scheduled job now | `sudo docker compose exec cron node /app/deploy/app/cron/call.mjs /api/cron/<name>` |

Run git as the checkout's owner, never as root. When `git pull` says "Permission
denied", files in the checkout are owned by root (something was copied in or run as
root): find them with `sudo find . ! -user <owner>` from `/opt/native-intelligence` and
give them back. A script that opens several ssh connections in a row can fail with
exit code 255: the firewall allows about six new ones in 30 seconds, so wait a minute.
More of these under "Day to day" in [`../README.md`](../README.md#day-to-day).

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

One deploy at a time: `deploy.sh` takes the lock `/run/lock/ni-app-deploy.lock` and
stops at once, saying so, while another deploy holds it (by hand, or the automatic
deploys below).

Merging to `main` does not deploy here. Someone runs `git pull` and `deploy.sh` on
the server, or the automatic deploys below do, when the owner has switched them on.

### Automatic deploys

`auto-deploy.sh` rolls out what is merged to `main` by itself, within minutes. It is
**off** until someone switches it on, on the server, and stays as it was across
reboots. Nothing outside the server can start it or reach it: a systemd timer on the
server runs it every two minutes, and each run asks GitHub, as the checkout's owner,
whether `main` moved (`git fetch origin main`).

What is new is measured from **what serves**, not from the checkout: the commit on
the image `ni-app:running`, which `deploy.sh` tags only after a finished roll-out.
When that cannot be read (no such image, no commit on it, a commit the checkout does
not have), the run holds: roll out by hand once, and it knows again. So a checkout
someone pulled by hand is still "something to deploy", and every check below covers
everything between what serves and `origin/main`. When `origin/main` serves, the run
ends without a word.

When all is well, it moves the checkout to exactly the commit it checked (`git merge
--ff-only`, as the owner: `git pull` without a second fetch), builds (`deploy.sh
--build-only`, while the old version keeps serving), rolls out (`deploy.sh
--no-build`, as that file's header describes), and then checks that the new commit
serves: `ni-app:running` must carry it, and `/api/version`, asked through the stack's
proxy from inside its container, must answer with its first eight characters.

What it never does: touch the database, add or change a setting, roll back, or roll
out anything while a deploy runs. It holds the same lock as `deploy.sh` for its whole
run: while someone deploys by hand, a run does nothing and the status says `waiting:
a deploy is running`; while it deploys, `deploy.sh` by hand stops at once.

**Holds.** The run changes nothing, and says why in the status (and once in the
log), until a person resolves it. Any error while checking holds too; it never
counts as "nothing to hold".

| Holds when | What a person does |
|---|---|
| Between what serves and `origin/main`, a file in `web/supabase/migrations/` is added, changed, renamed or removed | Apply the migrations (below), then `sudo ./auto-deploy.sh acknowledge <commit>`, with the commit the hold names. |
| The same for `web/supabase/functions/` or `web/supabase/templates/` | These are mounted from the checkout into the Supabase stack (`../supabase/compose.override.yaml`: the `stripe-webhook` function, and the mail templates' file server): they change the moment the checkout moves, whatever happens to the build. Read the change, then `acknowledge <commit>`. |
| The same for `deploy/edge/`, `deploy/supabase/`, `deploy/inngest/` or `deploy/backup/` | Other stacks. Edge reads its folder (`Caddyfile`) when Caddy starts; Supabase's compose files and mounted files, and Inngest's `sync.sh`, take effect when those containers are next created or started; the backup container has its files built in, so its next `up --build`. A reboot restarts the first three, so a broken file there takes its stack down at the next reboot even though the app's build is fine. Read the change, `acknowledge <commit>`, and once the checkout has moved, roll that stack out by hand (Day to day in [`../README.md`](../README.md#day-to-day)). |
| The new `deploy/app/.env.example` names a setting `.env` has no line for (names only; no value is read out or shown) | Copy the line into `.env` (`sudo nano .env`) and fill it in where needed. The next run sees it. |
| The new commits add a path that exists untracked or ignored in the checkout (`deploy/app/.env` is one: the fast-forward would overwrite it) | Look at it and move it away, or roll out by hand. |
| `origin/main` is not a plain step forward from what serves or from the checkout (history was rewritten), the checkout is not on `main`, has changes of its own, or holds files its owner does not own | Look as the owner (`git status`, `git log --oneline HEAD...origin/main`) and put the checkout right by hand. The hold says which. |
| What serves cannot be told | Roll out by hand once (`git pull` as the owner, `sudo ./deploy.sh`). |
| A commit was rolled back by hand (below), or its build failed | That commit only; a newer one on `main` goes ahead. |
| A roll-out was left half done (below) | Everything, until `clear-failure`. |
| `git fetch` failed | Usually the network: the next run tries again. |

`acknowledge <commit>` records each held file by its content at that commit, in a
root-only file. It covers exactly those: a later change to one of them, or another
file, is held again. It does not fetch, so it never covers a commit nobody has seen
in a hold.

**Applying a held migration.** Either pull first (as the owner) and apply the file
as "Apply a database migration" under [Day to day](../README.md#day-to-day) says, or
apply it straight from the commit the hold names, without moving the checkout, from
`/opt/native-intelligence` as its owner:

```bash
git show <commit>:web/supabase/migrations/<file> | sudo docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 --single-transaction
```

then the second step, the schema reload, as that row says. Then `sudo
./deploy/app/auto-deploy.sh acknowledge <commit>`. Both ways work: what is held is
measured from what serves, not from the checkout.

**Failures.** A run's output is in `runs/`. It tells two kinds apart by the step
that failed, because it runs the two halves of `deploy.sh` one after the other:

- **The build** (`deploy.sh --build-only`) failed, or the run stopped during it: the
  old version still serves the app, nothing was replaced. That commit is not tried
  again; a newer one on `main` is. But the checkout has moved, so files other stacks
  use from it (the held kinds above) are already the new ones: they were
  acknowledged before the run moved it.
- **The roll-out** (`deploy.sh --no-build`) failed, or the run stopped during it (a
  reboot, the service's two-hour limit), or the checkout could not be moved, or the
  new commit does not serve afterwards: it may be half done, so nothing is rolled
  out on top. Everything holds until a person has looked (`sudo docker compose ps`,
  then `sudo ./deploy.sh --no-build` or `--rollback`) and run `sudo
  ./auto-deploy.sh clear-failure`.

Each step is recorded as the failure before it starts, so a run that is killed
leaves the right kind behind. `clear-failure` forgets the record: the next run rolls
out `origin/main` (unless it already serves, deployed by hand). Only the run in which
a deploy fails exits non-zero; every other run exits 0 and the status file and the
pings carry the state, so that systemd does not report a failure every two minutes.

**Rollbacks.** `sudo ./deploy.sh --rollback` by hand is noticed at the next run: what
serves is no longer the commit this tool last rolled out, nor a later one. That
commit is then held and not rolled out again; a newer commit on `main` is. To roll
it out again: `clear-failure`.

| To | Command (from this folder) |
|---|---|
| Put the service and timer in place (once, and after they change) | `sudo ./auto-deploy.sh install`: enables and starts nothing |
| Switch it on | `sudo ./auto-deploy.sh on` (enables the timer and sets the switch) |
| Switch it off | `sudo ./auto-deploy.sh off`: a deploy running now finishes what it started |
| What serves, what it did, and why it holds | `sudo ./auto-deploy.sh status` |
| What a run would do now, changing nothing | `sudo ./auto-deploy.sh run --dry-run` (fetches and checks; no move, no build, no state) |
| Release a hold on migrations or other stacks' files | `sudo ./auto-deploy.sh acknowledge <commit>` |
| Forget a failure or a rollback | `sudo ./auto-deploy.sh clear-failure` |

"On" is two things, both on the server: the timer is enabled, and the switch file
`/var/lib/ni-auto-deploy/on` exists. Every run reads the switch file first, so a
timer enabled by anything else still deploys nothing. Installing never sets either.

Everything it keeps is in `/var/lib/ni-auto-deploy`: `status` (the last run's time;
the state: `idle`, `deployed <commit> at <time>`, `waiting`, `holding: <reason>` or
`failed: <commit>: <reason>`; what a person does; and the commit that serves;
readable by anyone), `log` (one line per change of state), `runs/` (each deploy's
own output, the newest 30), `failed`, `deployed`, `acknowledged`, and `settings`.
`systemctl status ni-auto-deploy` and `journalctl -u ni-auto-deploy` have systemd's
side.

`settings` holds three addresses, each optional, requested at the end of every run
while it is on (like the backups' `*_PING_URL`, a plain request):
`AUTO_DEPLOY_PING_URL` after a run that ended well (nothing new, waiting, deployed),
`AUTO_DEPLOY_HOLD_PING_URL` after a run that holds, `AUTO_DEPLOY_FAIL_PING_URL` after
a run whose deploy failed and every run while that stands. A check elsewhere can
then tell running and well (the first, every two minutes), holding, failed, and not
running at all (none).

**The undo.** `sudo ./auto-deploy.sh off` stops the automatic deploys; `sudo
./deploy.sh --rollback` goes back to the version before the last roll-out, whoever
made it, and the automatic deploys do not undo that.

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

These tools only change values of lines that already exist in `.env`; none adds a
line. A new setting's line is copied from `.env.example` by hand (`sudo nano .env`),
then filled in.

Some values must be exactly what the earlier host has, because what they sign or
encrypt is already stored or held elsewhere:

| Setting | Why it must not change | Checked against |
|---|---|---|
| `CREDENTIAL_ENCRYPTION_KEY` | Encrypts every connected account's tokens in the database. | Every stored token ciphertext must open. |
| `RUN_SKILL_INTERNAL_SECRET` | Keys the stored link, invite and phone-code hashes, and the reply codes already texted. | A stored phone code's hash must come out of it. |
| `CLOUD_BROWSER_SIGNING_KEY` | Its public half is built into released desktop apps. | That pinned public key. |
| `UNSUBSCRIBE_SECRET` | Signs the unsubscribe links in mail already sent. | Readable; `pull-settings.sh` brings it. |
| `OUTLOOK_WEBHOOK_SECRET`, `GMAIL_WEBHOOK_TOKEN` | Part of every live mail subscription. | Readable; brought. |
| `GPT_LIVE_TRUNK_SECRET` | The phone trunk sends it with every call. | The Twilio trunk's origination address (`--fill` brings it from there). |
| `GPT_LIVE_WEBHOOK_SECRET`, `LINEAR_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_SECRET` | The provider signs its webhooks with it (GitHub: a repository's webhook to `/api/webhooks/github`). | Nothing here: the provider's dashboard. |
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

These exist only here: the earlier host has no such settings, because there the
app's own deployment token did their work (`web/src/lib/slack/config.ts`).

- `CONNECT_ACCESS_TOKEN`: an access token of that account, scoped to the team the
  Slack connector is in. The connector refuses this team token as the credential
  for a Slack login (measured from this server), so the app only makes a
  short-lived project token with it (`web/src/lib/slack/connect-auth.ts`) and sends
  that to the connector. The project token is for the project's development
  environment, so the connector must stay enabled for development as well as
  production. An access token narrowed to the project, instead of scoped to the
  team, is refused outright, here and by the sandbox service (`SANDBOX_ACCESS_TOKEN`
  is scoped to the team too).
- `CONNECT_PROJECT_ID`: the id of the project the connector is attached to and
  forwards Slack's events for. Required with the access token: the project token
  is made for it. A forwarded event or button click must carry a token naming it.
- `CONNECT_TEAM_ID`: that project's team, sent with the project-token request when
  set. May stay empty: the request was measured working both with and without
  the team named.
- `CONNECT_ENVIRONMENT`: that project's environment the forwarded token must name;
  empty is `production`.

`check-settings.sh` makes the app's own requests for a Slack login, in order, and
says at which step it stopped: the project token, made exactly as the app makes it
(the team named only when `CONNECT_TEAM_ID` is set, no body), the connector read
with it (a trigger destination with `CONNECT_PROJECT_ID` and the path
`/api/slack/events`), a Slack login for the connector's default installation, and
Slack's own `auth.test` naming that workspace. It shows no token, at most a
length; network trouble, too many requests (429) or the other side's failure is
"cannot tell", not wrong. This path was seen working end to end from this server.

A `*` in `CONNECT_PROJECT_ID` or `CONNECT_ENVIRONMENT` makes the app refuse every
forwarded event, and the check calls it wrong.

`VERCEL_PROJECT_ID` and `VERCEL_ENV` are never set here in their place: other code
reads `VERCEL_ENV` to tell production from a preview.

### Sealed copy (done once, then removed)

The earlier host's write-only production settings reached this server once, on
2026-11-10, by a sealed copy: the last step of one production build encrypted them
to a key only this server held and printed that block in the build's log; the
server opened it, wrote the values into `.env` and deleted its key;
`check-settings.sh` then proved what can be proven. The build step, its public key
and both ends of the tooling were taken out afterwards, so no later build can seal
anything. They are in the history (PR #67, merge `ca24594d`) for a move that needs
them again: restore them,

```bash
git checkout ca24594d -- web/scripts/seal-settings.mjs deploy/app/sealed_settings.py deploy/app/sealed-copy.sh deploy/app/tests/test_sealed_settings.py
```

put the step back at the end of `npm run build` and the files back into
`.github/workflows/deploy-scripts.yml` (its paths and its `bash -n` line), make a new
key with `sealed-copy.sh new-key`, and follow the steps as they were
(`git show ca24594d:deploy/app/README.md`, "Sealed copy").

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
| `auto-deploy.sh`, `ni-auto-deploy.service`, `ni-auto-deploy.timer` | Automatic deploys of `main`, off unless switched on; `tests/test_auto_deploy.py` is its test. |
| `pull-settings.sh` | Fill the server's `.env` from the earlier host, unseen. |
| `check-settings.sh`, `check_settings.py` | Check the server's `.env` before the switch, unseen; `tests/test_check_settings.py` is its test. |
| `smoke/compose.yaml`, `smoke/.env.example` | The container test's stack. |
| `smoke.sh` | The container test. |

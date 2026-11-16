# CLAUDE.md

Read this before reporting anything as live or touching production. The code guides are
[`web/CLAUDE.md`](web/CLAUDE.md) and [`ios/CLAUDE.md`](ios/CLAUDE.md); the server is
[`deploy/README.md`](deploy/README.md).

## How production works (since 2026-11-11)

- **Production runs on our own server.** Merging to `main` builds and deploys nothing,
  anywhere: the repository is no longer connected to the earlier host (Vercel). A change
  is live only after the roll-out on the server: in the server's checkout, `git pull` as
  the checkout's owner, then `sudo ./deploy.sh` in `deploy/app`. Five to ten minutes of
  build; web and worker are replaced without a gap, the agents one by one (a reply
  streaming from an agent at that moment is cut). Commands and `--rollback` are in
  [`deploy/app/README.md`](deploy/app/README.md).
- **Automatic deploys exist and are OFF** unless the owner switched them on, on the
  server (`deploy/app/auto-deploy.sh`, "Automatic deploys" in
  [`deploy/app/README.md`](deploy/app/README.md#automatic-deploys)). When on, a merge to
  `main` is rolled out within minutes, EXCEPT when it brings a migration, a new setting
  in `deploy/app/.env.example`, or a change to files other stacks use (Supabase's
  functions and mail templates, `deploy/edge`, `deploy/supabase`, `deploy/inngest`,
  `deploy/backup`, `deploy/livekit`, and `recorder` but its `test/`, `e2e/` and guide),
  or to the server's own deploy tooling (everything in `deploy/app`,
  the `Dockerfile` included, except `cron/`, `smoke/`, `tests/`, the two `.mjs` files
  and the guide): those hold it until a person has taken care of them. A failed roll-out or a
  rollback by hand holds everything until the owner clears it. With it on, a merge to
  `main` runs its code on the production server,
  inside the app's containers, without a person in between. So "merged" still does not
  mean "live": `sudo ./auto-deploy.sh status` on the server says what serves.
- **Never report a merged change as live.** Say "merged, not rolled out" until the
  roll-out has happened. Who rolls out, and when, is the owner's decision: never do it
  unasked, and never switch the automatic deploys on, or release one of their holds
  (`acknowledge`, `clear-failure`), unasked.
- **The database is the Postgres on the server.** A migration is applied there, with
  `psql` in the database container over ssh ("Apply a database migration" under "Day to
  day" in `deploy/README.md`), before the code that needs it is rolled out, and only on
  the owner's word. The hosted Supabase project production used before is frozen and is
  not production: never use its dashboard, the Supabase CLI or any connector to it for a
  production change.
- **Production's settings** (environment variables) live in the server's
  `deploy/app/.env`, not in the earlier host's project settings. A new setting needs a
  line there and in [`deploy/app/.env.example`](deploy/app/.env.example) (no tool adds
  a line to an existing `.env`). Changing production's settings, like anything done on
  the server over ssh, is the owner's call, as roll-outs and migrations are.
  `deploy/app/check-settings.sh <user>@<server>` checks them: it runs from your own
  machine, over ssh, and only reads (unless given `--fill`).
- **The app's address is `https://nativeintelligence.dev` since 2026-11-16**
  (`NEXT_PUBLIC_APP_URL` in the server's `.env`, compiled into the image): every link the
  app makes is built on it. `dial8.ai` still serves the same app and has to: desktop
  builds before 0.2.107, MCP clients on `dial8.ai/api/mcp`, Asana webhooks, older
  Outlook subscriptions and links in sent emails use it. Still naming `dial8.ai` on
  purpose: the connectors' callbacks (`OAUTH_REDIRECT_BASE_URL`), the Slack app's event
  and interactivity addresses, mail addresses, the carrier-reviewed text messages. The
  forward from the old domain (`NI_FORWARD_OLD_DOMAIN`) is off; switching it on is the
  owner's call. Proven live that day: both domains on the new build, canonical tags and
  the sitemap, a new form link, Inngest's registration at the new address. NOT yet
  proven: a sign-in on the new domain after the move, a connector connect, a cloud
  browser's start, a call's webhook. "The app's address" in
  [`deploy/README.md`](deploy/README.md#the-apps-address) has the steps and the way back.
- **Scheduled jobs** run from the server's cron container. Their source is the `crons`
  array in `web/vercel.json`: after changing it, run `node deploy/app/cron/generate.mjs`
  and commit `deploy/app/cron/crontab` with it (the image build and CI fail when the two
  disagree).
- **Still at the earlier host, on purpose:** the AI Gateway, and DNS with the two
  domains' registrations (the owner's decision, 2026-11-14: they cost nothing there).
  Slack is not on that list any more: since 2026-11-14 the
  code talks to Slack directly with our own Slack app (`web/src/lib/slack/`,
  migration 644). The Slack app's addresses point at us, the earlier host's
  connector is revoked and deleted, and a Slack workspace is connected with
  "Add to Slack" in Settings › Connectors › Slack: from a browser, or from the
  desktop app, where the install is finished in the person's browser and claimed
  by the window that started it. Proven live on 2026-11-14, and only these: the
  connector's revocation arriving as Slack's own events (the workspace was
  marked disconnected), an install from a browser (bot token stored, the Slack
  workspace bound again) and a direct message to the bot, answered. NOT yet
  proven: an install started in the desktop app, a mention in a channel, a
  button click (`/api/slack/interactivity`), a second Slack workspace. "Slack"
  under "Day to day" in [`deploy/README.md`](deploy/README.md) is the record of
  the switch and says what a move to another address needs.
- **The cloud browser runs on our own sandbox server since 2026-11-14**
  (`CLOUD_BROWSER_BACKEND=runtime` in the server's `.env`; "The cloud browser" in
  [`deploy/README.md`](deploy/README.md)): one sandbox per person and workspace,
  paused when idle, each with a public name `<sandbox id>.<CLOUD_BROWSER_HUB_DOMAIN>`
  that the edge certifies on demand (a wildcard DNS record at the earlier host
  points those names at the server). Proven live that day: the conformance script
  against the real runtime (every check), and one person's browser: its start, its
  certificate, the live view, the exit through the person's Mac, and the idle stop
  (a pause). NOT yet proven: a wake with the person still signed in, a night across
  the daily reboot with a browser running, more than one person at once. The earlier
  host's sandbox service is the way back (empty `CLOUD_BROWSER_BACKEND` and
  `CLOUD_BROWSER_RUNTIME_KEY`, then the guide's two steps), which is why
  `SANDBOX_ACCESS_TOKEN`, `SANDBOX_TEAM_ID`, `SANDBOX_PROJECT_ID` and
  `CLOUD_BROWSER_BASE_SNAPSHOT_ID` stay in the server's `.env` for now. People's
  sign-ins do not move between the two.
- **The coding agent's sandbox runs on our own sandbox server since 2026-11-12**
  ([`deploy/sandbox/README.md`](deploy/sandbox/README.md)), chosen by
  `SANDBOX_RUNTIME_API_URL`, `SANDBOX_RUNTIME_TRAFFIC_URL` and `SANDBOX_RUNTIME_KEY` in
  the server's `.env` (at the image build and in the coding agent's container; they
  win over the hosted three). It is not handed the person's GitHub token: it clones,
  fetches and pushes through the app's git gate, which adds the token server-side and
  refuses an LFS answer that contains it. (GitHub's own short-lived LFS storage
  links, in its LFS answers, are not checked, as before.) On our runtime the run's
  gate token sits inside the sandbox, so the gate takes it only from the sandbox
  server's addresses (`AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES`). Proven live on
  2026-11-12: a sandbox started from production's coding agent container, and the
  gate's address rule from both sides. Proven live on 2026-11-13: a whole coding run
  on our runtime, started from chat (the clone and the push through the git gate from
  the sandbox server's address, the reviewer's approval, the pull request, the sandbox
  removed at the end; its level was not read: `trusted` unless its environment narrows
  it). NOT yet proven: the `restricted` and `isolated` levels on any sandbox ("The coding
  agent" in `deploy/README.md` lists the checks to do first; on our runtime a narrowed
  level still leaves the sandbox's DNS resolver reachable, so `isolated` does not yet
  mean "nothing gets out"). On the hosted service a `trusted` run was proven live on
  2026-11-11, before the move. A private
  tunnel links production to the sandbox server since 2026-11-12: production carries a network
  interface `ni-sandbox`, a firewall table `inet ni_sandbox_tunnel` and the first rule
  in `ufw`'s list for it. They are not strays; "The tunnel" in that guide says what each
  is and how to take the tunnel away.
- No server address, ssh user or ids in this repository: it is public. Use the
  placeholders `deploy/README.md` uses (`<server>`, `<user>@<server>`).

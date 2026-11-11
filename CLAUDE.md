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
  `deploy/backup`, `deploy/livekit`), or to the server's own deploy tooling (everything in `deploy/app`,
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
- **Scheduled jobs** run from the server's cron container. Their source is the `crons`
  array in `web/vercel.json`: after changing it, run `node deploy/app/cron/generate.mjs`
  and commit `deploy/app/cron/crontab` with it (the image build and CI fail when the two
  disagree).
- **Still at the earlier host, on purpose:** Slack's connector, the cloud browser's
  sandboxes and the coding agent's, the AI Gateway, and DNS. The coding agent's sandbox
  runs on that host's sandbox service when `SANDBOX_ACCESS_TOKEN`, `SANDBOX_TEAM_ID` and
  `SANDBOX_PROJECT_ID` are set at the image build and in the container. It holds no
  GitHub credential: it clones, fetches and pushes through the app's git gate, which
  adds the GitHub token server-side, and that service's firewall rules add only the
  run's gate token, on the gate's endpoints. Written and tested without live
  calls, NOT yet proven by a live coding run from the server ("The coding agent" in
  `deploy/README.md` lists the checks to do first).
- No server address, ssh user or ids in this repository: it is public. Use the
  placeholders `deploy/README.md` uses (`<server>`, `<user>@<server>`).

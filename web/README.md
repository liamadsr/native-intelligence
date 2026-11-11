# Native Intelligence: web app

This folder is the Native Intelligence web app, a Next.js 16 project. It holds:

- the marketing site and the docs site (`content/docs/`);
- the dashboard people work in (`src/app/account/`) and the admin panel (`src/app/admin/`);
- the API (`src/app/api/`);
- the eve agents that make every model call (`agents/`);
- the database migrations (`supabase/migrations/`).

Native Intelligence used to be called Dial8, and a few names in the code still say so on purpose.
The top-level [README](../README.md) covers the desktop and iOS apps beside this folder.

## Requirements

- **Node 24.** `.nvmrc` and `package.json` (`engines`) pin it.
- **A Supabase project.** A hosted project is simplest. A local stack through the
  Supabase CLI works too, but this repo has no `supabase/config.toml`: run
  `supabase init` first.
- **A Vercel AI Gateway key**, or a Vercel project to pull an OIDC token from. The
  agents' model calls go through the Gateway.
- **The Inngest dev server** for background jobs. `npm run dev:inngest` fetches it with
  `npx`.
- **Keys for the features you want.** Email and calendar need Google or Microsoft
  OAuth apps. Billing needs Stripe, texting needs Twilio, live transcription needs
  Deepgram, the app's own email needs Resend. [`.env.example`](.env.example) lists every
  variable the app reads, grouped by feature. Without a feature's keys, that feature
  stays off or fails when used. The rest of the app runs.

## Running it locally

1. **Install.**

   ```bash
   npm install
   ```

   `postinstall` applies the patches in `patches/` (one of them is eve's). If a patch
   stops applying, `patch-package` prints an error, but a local install still
   finishes: check the output. The install fails on it only in CI.

2. **Set up the environment.**

   ```bash
   cp .env.example .env.local
   ```

   Fill in the first group, "Required for the core app":
   - the Supabase URL, anon key and service role key (Supabase: Settings → API);
   - `AI_GATEWAY_API_KEY`;
   - `RUN_SKILL_INTERNAL_SECRET` and `CREDENTIAL_ENCRYPTION_KEY` (the comments say
     how to generate them).

   Keep `NEXT_PUBLIC_APP_URL=http://localhost:3000` and `INNGEST_DEV=1`.

3. **Set up the database.**
   - On a new, empty Supabase project (or a local one from `supabase start`), run the
     bootstrap with the project's connection string (Supabase: Connect), as `postgres`.
     It needs `psql`:

     ```bash
     DATABASE_URL="postgresql://postgres:<password>@<host>:5432/postgres" scripts/db-bootstrap.sh
     ```

     It applies `supabase/baseline/schema.sql` (the schema as of the migration number in
     `supabase/baseline/CUT`, with the extensions, auth triggers, storage buckets and
     policies, and realtime setup the app needs), then `seed.sql` (plans, model costs
     and the built-in library), then every migration numbered after the cut. It refuses
     a database that isn't empty. The plans' Stripe price ids are blank: set your own.
   - An existing database only takes the migrations it hasn't run yet: apply those in
     file-name order with `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <file>`. The
     migrations aren't for the Supabase CLI's runner, since some numbers are used twice.
   - New migrations are numbered after the cut. The baseline is regenerated from time to
     time with `scripts/db-baseline-regenerate.mjs`, never edited by hand (the rules are
     in `supabase/baseline/CUT`).
   - Sign-in emails link to `/auth/confirm`. Copy the templates in
     `supabase/templates/` into Supabase (Authentication → Email Templates), and set
     the Site URL to your `NEXT_PUBLIC_APP_URL`.

4. **Run it.**

   ```bash
   npm run dev          # http://localhost:3000
   npm run dev:inngest  # in a second terminal, for background jobs
   ```

   `npm run dev:all` runs both in one terminal. Before `next dev` starts, `predev`
   copies the ONNX runtime into `public/ort/` and clears stuck eve runs.

   On a port other than 3000, set `NEXT_PUBLIC_APP_URL` to match. The agents call the
   app back at that URL.

## The eve agents

Every server-side generation runs on an [eve](https://www.npmjs.com/package/eve)
agent, and a test enforces that rule
(`src/lib/ai/__tests__/eve-everywhere-tripwire.test.ts`). The exceptions are
embeddings, two eval graders, and the voice layer of phone calls.

There are eight agents, one folder each under `agents/`:

- `chat-agent`
- `skill-runner`
- `coding-agent`
- `work-agent`
- `live-agent`
- `utility`
- `onboarding-researcher`
- `web-research`

`withEve` in `next.config.mjs` mounts them at `/eve/<name>/v1/*`.

How they run in dev:

- `npm run dev` starts them. `withEve` boots one eve dev server per agent beside
  `next dev`, and rewrites the `/eve/<name>/...` routes to it. There's nothing else to
  start.
- They're child processes of `next dev`, so they get the same variables from
  `.env.local`.
- They read their instructions and run tools through the app's internal routes
  (`src/app/api/internal/`). They reach them at `NEXT_PUBLIC_APP_URL`, signed with
  the internal secrets. In dev, `RUN_SKILL_INTERNAL_SECRET` alone covers every agent.
- Their models go through the Vercel AI Gateway, using `AI_GATEWAY_API_KEY`, or else
  `VERCEL_OIDC_TOKEN`.
- Each agent keeps its local run state in `agents/<name>/.eve/` (gitignored).
  `npm run eve:prune-runs` clears runs that died with a dev server. `predev` runs it
  for you.
- An agent's sandbox needs microsandbox or Docker running locally. Read "Local eve
  sandbox" in [docs/DEV_SETUP.md](docs/DEV_SETUP.md) before you use a feature that
  starts one. Without either, eve installs `just-bash`, which rewrites `package.json`
  and `package-lock.json`.
- The cloud browser starts Vercel Sandbox VMs. It needs `VERCEL_OIDC_TOKEN` and the
  `CLOUD_BROWSER_*` variables. Coding runs use Vercel Sandbox only when deployed on
  Vercel. Locally they run in the agent's local sandbox (above). In production the
  agents run in containers on our own server ([`deploy/app/`](../deploy/app/README.md)),
  where an agent's shell is eve's `just-bash` ("The coding agent" in
  [`deploy/README.md`](../deploy/README.md) says what that means for coding runs).

`agents/local-agent` isn't mounted here. It's the agent that runs on a person's Mac,
and the desktop app bundles it.

## Tests and typecheck

```bash
npm test               # the full Vitest suite, once
npm run test:watch     # watch mode
npm run test:coverage  # v8 coverage report in coverage/
npm run typecheck      # tsc --noEmit over everything, tests included
npm run lint           # ESLint on src/
```

Run them under Node 24. The suite needs no `.env.local`: `src/test/setup.ts` clears
the internal secrets and the Vercel variables before each run. `npm run build` runs the
suite first and stops on a failure.

The end-to-end tests use Playwright against a running app (`BASE_URL`, default
`http://localhost:3000`):

```bash
npm run e2e:install    # once: Chromium and its dependencies
npm run e2e
```

[docs/TESTING.md](docs/TESTING.md) covers the patterns: mocking Supabase, testing
route handlers, and the source-scan tripwires.
[docs/E2E_TESTING_AND_DEPLOYMENT.md](docs/E2E_TESTING_AND_DEPLOYMENT.md) covers the
end-to-end tests, and how the hosted project's deploy pipeline is planned.

## Connecting integrations

- **OAuth callbacks.** Every provider's callback is
  `<OAUTH_REDIRECT_BASE_URL or NEXT_PUBLIC_APP_URL>/api/oauth/<provider>/callback`.
  The providers are `google`, `microsoft`, `github`, `hubspot`, `asana`, `jira`,
  `linear` and `brevo`. Each one's scopes are in `src/lib/oauth/config.ts`, with notes
  on the ones that are easy to get wrong. Two callbacks differ: Stripe Connect uses
  `/api/payments/setup/oauth/callback`, and MCP connectors use
  `/api/mcp-oauth/callback`.
- **Webhooks need a public HTTPS URL.** A `localhost` app never receives them.
  Asana and Jira skip registering a webhook to a `localhost` or `http` target. In
  dev, call `/api/cron/asana-sync` and `/api/cron/jira-sync` yourself (with the cron
  bearer below), or point `NEXT_PUBLIC_APP_URL` at an HTTPS tunnel. The receivers
  are:
  - `/api/webhooks/{gmail,outlook,github,linear,jira,stripe-connect}`, and
    `/api/webhooks/stripe-connect/v2`;
  - `/api/webhooks/asana/<id>`;
  - `/api/twilio/sms` and `/api/twilio/sms/status`;
  - `/api/calls/live`;
  - `/api/slack/events` and `/api/slack/interactivity`;
  - `/api/inngest`, for the Inngest server in production.
- **Stripe billing's webhook isn't in this app.** It's a Supabase Edge Function
  (`supabase/functions/stripe-webhook/`). On your own Supabase project, deploy it with
  the Supabase CLI and set its secrets there. Production's copy is not deployed that
  way: the server's Supabase stack mounts this folder and runs it from the checkout
  (`git pull`, then a restart of its functions service:
  [`deploy/supabase/README.md`](../deploy/supabase/README.md)).
- **Crons.** `vercel.json` lists the cron jobs. Each one is a route under
  `src/app/api/cron/` that needs `Authorization: Bearer $CRON_SECRET`. Off Vercel,
  nothing calls them unless you schedule them yourself. The hosted service's server
  does that with a crontab generated from this list
  ([`deploy/app/README.md`](../deploy/app/README.md#cron)).

## Settings you set in your environment

The hosted service turns these on with its own environment variables. A copy without
them leaves the feature off. Each one is in `.env.example`.

- **Error reporting (Sentry).** `NEXT_PUBLIC_SENTRY_DSN` turns Sentry on for
  production builds (`src/lib/sentry-env.ts`). With `SENTRY_ORG`, `SENTRY_PROJECT` and
  `SENTRY_AUTH_TOKEN` too, the build uploads source maps. Without a DSN the build
  doesn't load Sentry's plugin and uploads nothing.
- **The sender of the app's email.** `EMAIL_FROM`, e.g. `Your Name <you@your-domain.com>`,
  on a domain you've verified in Resend. Every email the app sends goes through
  `sendEmail` in `src/lib/email.ts`. Without `EMAIL_FROM` nothing is sent: each send
  logs one line and fails the way a send Resend refused does.
- **Who gets the admin panel.** `ADMIN_EMAILS`, a comma-separated list of addresses
  (spaces and case don't matter). Admins also skip the app's billing wall. Unset, nobody
  is an admin (`src/lib/admin-emails.ts`). The admin sign-in asks Google for an account
  on your admins' domain when they all share one. The database's AI usage gate
  (`check_ai_usage_limit`, migration 468) exempts the hosted service's admins by address
  in SQL, not yours, so give your admins a subscription from the admin panel. On the
  hosted service `ADMIN_EMAILS` must name the same people as that SQL
  (`src/lib/__tests__/admin-emails-sql.test.ts`).
- **The desktop download.** `APP_DOWNLOAD_URL` (macOS) and `APP_DOWNLOAD_URL_WINDOWS`.
  `/api/download` redirects to the first, or to the second for `?platform=windows`, and
  answers 404 when that one is unset (`src/lib/app-download.ts`). Every download button
  and link renders nothing when its file isn't set. They're decided at build time, so
  set the variables before you build.

## Settings that still point at the hosted service

The code has some values for the hosted service built in. Change them for your own
deployment:

- **PostHog.** The `/ingest` rewrites in `next.config.mjs` go to PostHog's US cloud.
- **Stripe Checkout's return address.** It falls back to the app's address unless
  `NEXT_PUBLIC_SITE_URL` is set (`src/lib/stripe.ts`).
- **The cloud browser's relay.** On a Vercel production deploy it is `browser-relay.` on
  the app's domain (`src/lib/cloud-browser/config.ts`), and `RELAY_HOST_REDIRECTS` in
  `next.config.mjs` covers the hosted domains only.
- **The app's address.** It is one setting, `NEXT_PUBLIC_APP_URL`, read through
  `src/lib/app-url.ts`. Left empty it is the hosted address
  (`https://nativeintelligence.dev`), so always set it: the links in the app's emails,
  the marketing pages' canonical URLs, the sitemap and `llms.txt` all follow it. The
  hosted domains are also named in `APP_DOMAINS` there, for the few checks that ask
  whether a host is the hosted app.
- **The Scribe page's download.** `src/app/scribe/page.tsx` links to the hosted Scribe
  app's file.

## Project layout

```
src/app/            pages and API routes (App Router)
  account/          the dashboard
  admin/            the admin panel
  api/              the API: account CRUD, internal routes for the agents, webhooks, crons
src/components/     shared UI
src/lib/            business logic: AI tools, OAuth, email, calendar, CRM, billing, Inngest functions
agents/             the eve agents (eight mounted; local-agent is the Mac's)
packages/ui/        a shared UI package (npm workspace)
content/docs/       the docs site's MDX
supabase/           migrations, auth email templates, the Stripe webhook function
e2e/                Playwright tests
evals/              eve evals for the chat agent
scripts/            dev and build scripts
```

[CLAUDE.md](CLAUDE.md) walks through the architecture and the conventions: API route
helpers, error shapes, the internal secrets, and the risky-call reviewer.

## License and contributing

Native Intelligence is source-available under the Business Source License 1.1. See
[LICENSE](../LICENSE) at the top of the repo, and the top-level [README](../README.md)
for what it allows and for the files under other licenses.

To contribute, read [CONTRIBUTING.md](../CONTRIBUTING.md). Everyone signs the
[Contributor License Agreement](../CLA.md) once, on their first pull request.

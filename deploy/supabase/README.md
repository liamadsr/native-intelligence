# Supabase on our own server

The app's database, sign-in, live updates and file storage, as Supabase's own self-hosted stack. Setting it up and moving the hosted project onto it are steps 14 to 19 of [`../README.md`](../README.md). This page is the reference for what is in this folder and why.

## What is theirs and what is ours

```text
deploy/supabase/
├── stack/                   THEIRS. Supabase's docker/ folder from the release named in
│   ├── docker-compose.yml   stack/.supabase-version. Never edit anything in here: their
│   ├── run.sh  update.sh    update.sh merges new releases into it.
│   ├── volumes/…            (gateway config, database init scripts, the functions' main worker)
│   └── .env                 the settings. On the server only, root-only, not in git.
├── compose.override.yaml    OURS. Everything we change, layered on top of their compose file.
├── postgres/ni-memory.conf  Postgres memory settings for this server.
├── .env.example             every setting, with a comment. Copied to stack/.env.
├── check-env.sh             checks stack/.env before a start.
├── after-update.sh          the second half of taking a new release of theirs.
├── migrate/                 the move from the hosted project: scripts and runbook.
└── LICENSE-supabase         their files are Apache-2.0; this is that licence.
```

The rule that keeps their monthly releases applying cleanly: **`stack/` holds nothing of ours and is never edited by hand.** The only things that live in it without coming from them are `.env` and what the running stack writes (`volumes/snippets`, a folder Docker makes under `volumes/functions`), all of which their own `.gitignore` already leaves alone.

`stack/` is their folder exactly, except for two things of theirs that are left out: `.env.example` and `tests/`. Both hold Supabase's public demo keys, and this repository's leak check ([`.github/guard.sh`](../../.github/guard.sh)) refuses anything shaped like a key, whoever's it is. Neither is needed to run the stack: our own [`.env.example`](.env.example) has every setting theirs has, and `tests/` is their test suite. Their `update.sh` brings both back each time it runs, because it finds them missing; `after-update.sh` removes them again.

Three files in `stack/` are in git although their `.gitignore` lists them: `.supabase-version` (this repository is where the installed release is recorded) and the two `.gitkeep` files they ship.

## What `compose.override.yaml` changes

| Their default | Here | Why |
| --- | --- | --- |
| Project `supabase`, volumes and network named after it | Project `ni-supabase`, volumes `ni-supabase-db`, `ni-supabase-storage`, `ni-supabase-db-config`, `ni-supabase-deno-cache`, network `ni-supabase` | Like the rest of `deploy/` |
| Gateway published on host port 8000, pooler on 5432 and 6543 | Nothing published | A published port is open to the internet whatever the firewall says |
| The gateway is the public address | A second listener on the gateway, port 80, that lets through only `/auth/v1/`, `/rest/v1/`, `/graphql/v1`, `/realtime/v1/`, `/storage/v1/` and `/functions/v1/`. Caddy talks to that one. | Their listener's last route serves Studio, and `/pg/` runs SQL for the service-role key. See below. |
| Database and files in folders inside the checkout | Named volumes | Data does not belong in a git checkout |
| Postgres with the image's memory defaults (128 MB of shared buffers) | 4 GB shared buffers, 10 GB assumed cache, 16 MB per sort, 1 GB for maintenance | [`postgres/ni-memory.conf`](postgres/ni-memory.conf): a 24 GB machine shared with everything else |
| Image transformation on, imgproxy running | Off, imgproxy not started | The app transforms no images through Storage |
| Auth providers, hooks and templates commented out in their file | Google, Apple, the sign-up hook, the five email templates and their subjects wired to `.env` | These exist only in the hosted dashboard today |
| Functions: their `hello` example | plus `stripe-webhook`, mounted from `web/supabase/functions` | The one function that moves |

Container names are left as theirs (`supabase-db`, `supabase-auth`, …). Their gateway finds Realtime by its container name, and their scripts name the others.

Left exactly as they ship it: the logs and analytics add-on is a separate file of theirs (`docker-compose.logs.yml`) that is simply not switched on; Postgres 17 and the Envoy gateway are their defaults since 0.6.0 and 0.8.0.

### The public listener

Their gateway (Envoy) listens on port 8000 and serves everything on it: the API, Studio behind a password as the catch-all route, and `/pg/`, which runs arbitrary SQL for anyone holding the service-role key. None of the last two belongs on the internet, so Caddy must not simply forward to port 8000.

The allowlist is a second listener in the same Envoy process, added without touching their files: their entrypoint ends in `exec envoy -c /etc/envoy/envoy.yaml "$@"`, so the `command:` in our override becomes extra arguments, and `--config-yaml` is merged into their configuration. It matches the path and hands allowed requests to port 8000 on the loopback.

It is inside Envoy, and not a proxy in front of it, for a reason found while testing. A separate proxy cleans a path by its own rules before matching it; Envoy cleans it again by different ones. Envoy reads `..;` and `..\` as `..`. A Caddy allowlist in front of it let `/auth/v1/..;/..;/pg/tables` through as "an auth path", and Envoy then routed it to `/pg/`. With one program doing both the cleaning and the matching there is no gap. Every printable character was tried in that position against the listener, directly and through Caddy: nothing gets past it.

It listens on port 80 because Storage's S3 endpoint only accepts a request signed for the host name in `SUPABASE_PUBLIC_URL`, with no port. The backup container and the migration scripts call it under that name from inside Docker (pointed at the gateway's fixed address), and a bare name over plain http means port 80.

If a future release of theirs stops passing arguments to Envoy, the listener is simply absent and Caddy answers `502` for every Supabase request: it fails closed, and loudly.

## Auth settings

Nothing in this list is in the database, so none of it arrives with the restore. Each is read off the hosted project's dashboard and typed into `stack/.env`.

| Hosted dashboard | In `stack/.env` | Reaches Auth as |
| --- | --- | --- |
| Project Settings, JWT Keys: legacy JWT secret | `JWT_SECRET` | `GOTRUE_JWT_SECRET` (and the secret of every other service) |
| Project Settings, API Keys: legacy `anon` and `service_role` | `ANON_KEY`, `SERVICE_ROLE_KEY` | the gateway's list of accepted keys |
| Access token expiry | `JWT_EXPIRY` | `GOTRUE_JWT_EXP` |
| URL Configuration: Site URL | `SITE_URL` | `GOTRUE_SITE_URL` |
| URL Configuration: Redirect URLs | `ADDITIONAL_REDIRECT_URLS` | `GOTRUE_URI_ALLOW_LIST` |
| Providers: Email (enabled, confirm email) | `ENABLE_EMAIL_SIGNUP`, `ENABLE_EMAIL_AUTOCONFIRM` | `GOTRUE_EXTERNAL_EMAIL_ENABLED`, `GOTRUE_MAILER_AUTOCONFIRM` |
| Providers: Google | `GOOGLE_ENABLED`, `GOOGLE_CLIENT_ID`, `GOOGLE_SECRET`, `GOOGLE_SKIP_NONCE_CHECK` | `GOTRUE_EXTERNAL_GOOGLE_*` |
| Providers: Apple | `APPLE_ENABLED`, `APPLE_CLIENT_ID`, `APPLE_SECRET` | `GOTRUE_EXTERNAL_APPLE_*` |
| Hooks: Before User Created → `public.hook_require_work_email` | `HOOK_BEFORE_USER_CREATED_ENABLED` | `GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED`, and the URI `pg-functions://postgres/public/hook_require_work_email`, which is fixed in the override |
| Emails: SMTP Settings | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_ADMIN_EMAIL`, `SMTP_SENDER_NAME` | `GOTRUE_SMTP_*` |
| Emails: the five templates | nothing: they are files (below) | `GOTRUE_MAILER_TEMPLATES_*` |
| Emails: each template's subject | `MAILER_SUBJECTS_*` | `GOTRUE_MAILER_SUBJECTS_*` |

**The redirect address changes.** The hosted Auth tells Google and Apple to send people back to `https://<project ref>.supabase.co/auth/v1/callback`. This one says `https://sb.nativeintelligence.dev/auth/v1/callback`. That address has to be on Google's list of authorized redirect URIs and on Apple's list of return URLs before the switch. Adding it early does no harm.

**The email templates.** Auth does not read templates from disk; it fetches each one over HTTP. The override runs a small file server (`mail-templates`, reachable only inside the stack) on the app's own folder, `web/supabase/templates`, and points Auth at `http://mail-templates/confirmation.html`, `invite.html`, `magic-link.html`, `recovery.html` and `email-change.html`. There is one copy of each template, the one in `web/`, which is why the server's checkout includes that folder. After a template changes: `git pull`, then `sudo sh run.sh restart auth` (Auth keeps fetched templates in memory; a restart makes it fetch them again at once). If a fetch fails, Auth quietly sends its built-in English default instead, so after any change send yourself one of each.

All five build their link as `{{ .SiteURL }}/auth/confirm?token_hash=…`, so the links depend on `SITE_URL` only and never show this server's address.

**Settings this list does not cover.** The dashboard has more Auth settings than the ones the app is known to depend on: rate limits (emails per hour above all), password rules, CAPTCHA, session limits, OTP expiry and length. Whatever the hosted project has changed from the default has to be set here too, or it silently goes back to the default. The whole list in one go is the Management API's `GET /v1/projects/<project ref>/config/auth` with a personal access token. A setting their compose file does not pass through is added as one line under `auth: environment:` in `compose.override.yaml`, named `GOTRUE_…` as in [`stack/CONFIG.md`](stack/CONFIG.md), with its value in `.env`.

## The edge function

One function moves: `stripe-webhook`. Its code stays where it is, [`web/supabase/functions/stripe-webhook/index.ts`](../../web/supabase/functions/stripe-webhook/index.ts); nothing is copied.

- **How it is mounted.** The override mounts that folder read-only into the functions container at `/home/deno/functions/stripe-webhook`, beside their main worker, which serves `/functions/v1/<folder name>`. The public address becomes `https://sb.nativeintelligence.dev/functions/v1/stripe-webhook`. To deploy a change: `git pull`, then `sudo sh run.sh restart functions`.
- **Secrets it reads.** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, from `stack/.env` through the override. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are given to every function by the stack itself; the URL is the gateway inside Docker, so the function's writes never leave the server. After changing a secret: `sudo sh run.sh recreate functions` (a restart does not re-read `.env`).
- **The JWT check must be off.** `FUNCTIONS_VERIFY_JWT=false`. Stripe sends no Supabase key or token, only its own `Stripe-Signature` header, which the function verifies itself with the webhook secret. Self-hosted has one switch for the whole functions service, not one per function; with it on, the main worker answers Stripe `401` before the function runs. `stripe-webhook` is the only function here, so nothing else loses a check. A second function that needs one has to check its caller itself.
- **CORS.** Since release 0.8.4 the gateway no longer adds CORS headers to function responses or answers preflight requests for them. `stripe-webhook` sends no CORS headers and does not answer `OPTIONS`, and does not need to: it is called by Stripe's servers, never by a browser. A function that a browser calls would have to send its own.
- **Its imports come from the internet.** The function imports from `deno.land` and `esm.sh` by URL. The runtime downloads them the first time the function is called and keeps them in the `ni-supabase-deno-cache` volume. The first call after that volume is lost needs both sites to be up.

## Studio and the database, from your own machine

Neither is on the internet. Both are reached through SSH, at two fixed addresses on the stack's network that only the server itself can reach.

```bash
ssh -N -L 8000:172.31.0.10:8000 deploy@<server>
```

Studio is then at <http://localhost:8000>, behind `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD`.

```bash
ssh -N -L 5432:172.31.0.20:5432 deploy@<server>
```

Postgres is then at `localhost:5432` through the pooler. The user is `postgres.<POOLER_TENANT_ID>`, the password `POSTGRES_PASSWORD`, the database `postgres`.

## Day to day

Run from `stack/`. `run.sh` is theirs; it reads `COMPOSE_FILE` from `.env`, so every command sees their file with ours on top.

| To | Command |
| --- | --- |
| Start, and wait until everything is healthy | `sudo sh run.sh start` |
| See what is running | `sudo sh run.sh status` |
| Read logs | `sudo sh run.sh logs <service>` |
| Restart one service | `sudo sh run.sh restart <service>` |
| Apply a changed `.env` or override to one service | `sudo sh run.sh recreate <service>` |
| See the merged configuration | `sudo docker compose config` |
| Stop everything, keeping all data | `sudo sh run.sh stop` |

The services are `db`, `auth`, `rest`, `realtime`, `storage`, `functions`, `api-gw`, `supavisor`, `studio`, `meta` and `mail-templates`.

**Never run `sudo docker compose down -v` here, and never run `stack/reset.sh`.** `-v` deletes the named volumes: the database, every stored file, and `ni-supabase-db-config`, which holds the key that Postgres encrypts its vault with. `reset.sh` is their uninstaller and does the same, then replaces `.env`. `sudo sh run.sh stop` is the safe way to stop, and it is all `down` without `-v` does.

## Updating to a new Supabase release

They publish about once a month. Their [`CHANGELOG.md`](stack/CHANGELOG.md) says what each release changes; security fixes are marked. Updates go through a pull request like everything else, so the merge is done in a checkout of this repository, not on the server.

1. In a checkout, on a new branch. `update.sh` insists on a `stack/.env`; an empty one will do.

   ```bash
   cd deploy/supabase/stack && : > .env
   ```

   ```bash
   sh update.sh --dry-run
   ```

   ```bash
   sh update.sh
   ```

   It needs `git` and `jq`. It prints what changed, stops for confirmation on a release marked breaking, and lists the manual steps a release asks for. It reports every setting as "added" (to the empty file) and `.env.example` and `tests/` as "new": both are expected.

2. Our half:

   ```bash
   cd .. && ./after-update.sh
   ```

   It names every setting their release added that our `.env.example` does not have yet (add each there, with a comment, and run it again after `update.sh`), removes what is never committed, and reads their compose file with ours on top: it fails if the result publishes a port, runs a service that is meant to be off, or has lost one that is meant to be there. It ends with the two `git add` commands.

3. Look at the diff. Only files under `stack/` should have changed, plus `.env.example` if you added a setting. Read their changelog entry against [`compose.override.yaml`](compose.override.yaml): a service they renamed or a mount they moved is where an override stops applying, and not every such change can be caught by a script.

4. Merge the pull request. On the server, **after an hourly backup has gone through**:

   ```bash
   cd /opt/native-intelligence && git pull
   ```

   Add any new setting to `stack/.env` (`sudo nano stack/.env`), then:

   ```bash
   cd deploy/supabase && sudo ./check-env.sh
   ```

   ```bash
   cd stack && sudo sh run.sh pull && sudo sh run.sh recreate
   ```

   `recreate` stops and starts everything: about a minute of downtime.

Because nothing in `stack/` is ever edited, `update.sh` has nothing to merge and no conflict to report: every file is either unchanged or replaced by theirs. (Tried on a copy of this layout at 0.8.3: no conflicts, and after `after-update.sh` the folder was file for file what this repository holds for 0.8.4.) Database migrations of Auth, Storage and Realtime run by themselves when the new containers start, and some are one-way, which is what the backup before step 4 is for.

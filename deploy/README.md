# The server

Everything Native Intelligence runs on its own server lives in this folder. It is being moved there from managed services one piece at a time. This is the first piece: the server itself, and a self-hosted [Inngest](https://www.inngest.com/docs/self-hosting) that the app (still on Vercel) sends its background work to.

| Folder | What it runs | Public? |
| --- | --- | --- |
| [`edge/`](edge) | Caddy on ports 80 and 443, with automatic certificates. An allowlist in front of Inngest, and a pass-through host for Supabase. | Yes, the only thing that is |
| [`inngest/`](inngest) | The Inngest server, its own Postgres 17 and Redis 7, and a small loop that keeps the app's function list in sync. | No ports on the host |
| [`backup/`](backup) | A nightly, encrypted dump of Inngest's Postgres to Backblaze B2. | No |

Follow this page top to bottom on a fresh server. Every command is meant to be pasted as written, except where a value in `<angle brackets>` is yours to fill in. [What was and was not tested](#what-was-tested-and-what-was-not) is at the end: nothing here has run on a real server yet.

## 1. What you need

- A fresh **Ubuntu 24.04 LTS** VPS (sized for 8 vCPU, 24 GB) and the login the provider gave you.
- Your SSH public key on your own machine (`~/.ssh/id_ed25519.pub`). If you have none: `ssh-keygen -t ed25519`.
- Access to the DNS of `nativeintelligence.dev`.
- A Backblaze B2 account, and a dead-man check (any service that alerts when a URL has *not* been requested for a day).
- A password manager. Every secret below is generated once and has to be kept somewhere that is not the server.

Below, `<server>` is the server's IP address.

## 2. Your own user

Log in the way the provider set the server up (their Ubuntu image usually creates a user called `ubuntu`). Create the user everything else is done as. It asks for a password: make it long and keep it, because `sudo` will ask for it. It is never used to log in.

```bash
sudo adduser --gecos "" deploy
```

```bash
sudo usermod -aG sudo deploy
```

Give that user your SSH key. If you logged in with a key, copy the same one across:

```bash
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
```

```bash
sudo install -m 600 -o deploy -g deploy ~/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
```

If you logged in with a password instead, run this on **your own machine**:

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub deploy@<server>
```

Now check it, in a **new** terminal, and leave the old one open until step 3 is done:

```bash
ssh deploy@<server>
```

```bash
sudo -v && echo "sudo works"
```

Everything from here on is run as `deploy`.

## 3. SSH: keys only

One small file turns off passwords and root logins. Its name starts with `00` on purpose: sshd keeps the first value it reads, and the provider's own file (`50-cloud-init.conf`) may turn passwords on.

```bash
sudo tee /etc/ssh/sshd_config.d/00-ni-hardening.conf >/dev/null <<'EOF'
# Managed by hand: deploy/README.md in the native-intelligence repository.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers deploy
EOF
```

Check the file before applying it. The first command prints nothing when the config is valid; the second shows what sshd will really use.

```bash
sudo sshd -t
```

```bash
sudo sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|allowusers) '
```

That must print `permitrootlogin no`, `passwordauthentication no`, `kbdinteractiveauthentication no` and `allowusers deploy`. Then:

```bash
sudo systemctl restart ssh
```

From your own machine, prove both doors are shut. Each of these must end in `Permission denied`:

```bash
ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password deploy@<server>
```

```bash
ssh root@<server>
```

And `ssh deploy@<server>` must still work. Only then close the first terminal.

## 4. Automatic security updates

```bash
sudo apt-get update && sudo apt-get install -y unattended-upgrades
```

```bash
sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
```

Kernel fixes only take effect after a reboot, so let the server reboot itself when one is pending, at a quiet hour. The time is the server's clock, which is UTC: keep 08:30 or pick the hour that is the middle of the night for the people who use the product (step 12 schedules a job two hours after it). The containers come back by themselves (step 6 makes Docker start at boot, and every service has a restart policy).

```bash
sudo tee /etc/apt/apt.conf.d/52ni-unattended-upgrades >/dev/null <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "08:30";
EOF
```

Check that it would run. The last lines should list the allowed origins and no error.

```bash
sudo unattended-upgrade --dry-run --debug 2>&1 | tail -n 20
```

This covers Ubuntu's own packages. Docker is upgraded by hand (`sudo apt-get install --only-upgrade docker-ce docker-ce-cli containerd.io`), because upgrading it restarts every container.

## 5. Firewall

Only SSH, 80 and 443 come in.

```bash
sudo ufw default deny incoming
```

```bash
sudo ufw default allow outgoing
```

```bash
sudo ufw limit 22/tcp comment 'SSH'
```

```bash
sudo ufw allow 80/tcp comment 'HTTP (redirects, certificates)'
```

```bash
sudo ufw allow 443/tcp comment 'HTTPS'
```

```bash
sudo ufw enable
```

```bash
sudo ufw status verbose
```

**One rule that the firewall cannot enforce for you.** A port published by a Docker container (`ports:` in a compose file) is reachable from the internet whatever ufw says, because Docker writes its own firewall rules ahead of ufw's. Only Caddy publishes ports here, and only 80 and 443. Never add `ports:` to anything else in this folder. To reach a service from your own machine, use an SSH tunnel as in step 10.

## 6. Docker

From Docker's own repository, which also brings `docker compose`.

```bash
sudo apt-get install -y ca-certificates curl git
```

```bash
sudo install -m 0755 -d /etc/apt/keyrings
```

```bash
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && sudo chmod a+r /etc/apt/keyrings/docker.asc
```

```bash
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
```

```bash
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Before any container exists, cap the logs. Without this a chatty container fills the disk. Each container keeps at most 5 files of 20 MB.

```bash
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "20m",
    "max-file": "5"
  }
}
EOF
```

```bash
sudo systemctl restart docker && sudo systemctl enable docker
```

```bash
sudo docker run --rm hello-world
```

One kernel setting, for Redis (Inngest's queue). Redis saves to disk by forking, and without this the fork can be refused when memory is tight, after which Redis stops accepting writes. Redis prints a warning at every start until it is set.

```bash
echo 'vm.overcommit_memory = 1' | sudo tee /etc/sysctl.d/90-ni-redis.conf >/dev/null && sudo sysctl --system >/dev/null && sysctl vm.overcommit_memory
```

`deploy` is deliberately **not** added to the `docker` group: membership is the same as being root without a password. Every Docker command here is run with `sudo`, which is also what lets it read the root-only `.env` files.

## 7. The files

Only this folder is needed on the server, so only this folder (and the repository's top-level files) is checked out.

```bash
sudo install -d -o deploy -g deploy /opt/native-intelligence
```

Put this repository's HTTPS address (the one on its GitHub page, ending in `/native-intelligence.git`) in place of `<repository URL>`. The repository is public, so no login is needed.

```bash
git clone --depth 1 --filter=blob:none --sparse <repository URL> /opt/native-intelligence
```

```bash
cd /opt/native-intelligence && git sparse-checkout set deploy
```

What ends up where:

```text
/opt/native-intelligence/deploy/
├── edge/       compose.yaml  Caddyfile                               .env
├── inngest/    compose.yaml  sync.sh  prune-history.sh  prune-history.sql  .env
└── backup/     compose.yaml  Dockerfile  crontab  bin/               .env

Docker volumes   ni-inngest-postgres   ni-inngest-redis
                 ni-edge-caddy-data    ni-edge-caddy-config
Docker networks  ni-edge      shared by Caddy and whatever it proxies to (172.30.0.0/24;
                              fixed addresses below .128, Docker hands out the rest)
                 ni-inngest   Inngest, its Postgres and Redis, and the backup container; no route out
```

**The `.env` files.** Each of the three folders has a `.env.example` that lists every setting with a comment and no values. The real `.env` sits beside it, on the server only:

- owned by root and readable by root alone (`-rw------- root root`);
- never in git (`deploy/.gitignore` refuses them);
- a copy of each, filled in, in the password manager. They are the only thing you need to rebuild the server.

Each one is created the same way, shown in the steps below: `sudo install -m 600 -o root -g root .env.example .env`, then `sudo nano .env`. (Not `sudoedit`: it refuses to edit a file in a folder your own user can write to, which this checkout is.)

**The shared network.** Create it once. Caddy and Inngest both join it by name, and the fixed range is what gives the Inngest dashboard a fixed address for the tunnel in step 10. `--ip-range` makes Docker hand out addresses from the upper half only (`.128` and up), so the lower half is free for fixed addresses such as Inngest's `172.30.0.10`. Without it, any container that joined first could be given that address, and Inngest would then fail to start.

```bash
sudo docker network create --subnet 172.30.0.0/24 --ip-range 172.30.0.128/25 ni-edge
```

## 8. Inngest

Generate three secrets. Run each line and put the output straight into the password manager.

```bash
openssl rand -hex 32
```

```bash
openssl rand -hex 32
```

```bash
openssl rand -hex 24
```

The first is the **signing key**, the second the **event key**, the third the **Postgres password**. The signing key must be hex with an even number of characters, which is what this produces. The app will need the same signing key and event key in step 13.

```bash
cd /opt/native-intelligence/deploy/inngest
```

```bash
sudo install -m 600 -o root -g root .env.example .env
```

```bash
sudo nano .env
```

Fill in `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY`, `POSTGRES_PASSWORD` and `INNGEST_SDK_URL`. The last is the app's public serve endpoint, `https://<the app's production domain>/api/inngest`: the domain production answers on today, without a redirect. Nothing uses it until step 13: only the sync loop reads it, and the server itself is not given the app's address. Leave `COMPOSE_PROFILES` commented until step 13.

```bash
sudo docker compose up -d
```

```bash
sudo docker compose ps
```

After about a minute all three (`ni-inngest`, `ni-inngest-postgres`, `ni-inngest-redis`) must say `healthy`. If one does not: `sudo docker compose logs --tail 50 <service>`.

Two things to know:

- `POSTGRES_PASSWORD` is only read the first time Postgres starts on an empty volume. Changing it in `.env` later does not change the database's password.
- Until step 13 the dashboard shows no app at all. That is expected: the server is not told about the app, and the app still talks to Inngest Cloud. Nothing here sends production a request before step 13.

## 9. Caddy

**DNS first.** Caddy asks for certificates the moment it starts, and that fails until the names resolve to this server. Create two `A` records pointing at `<server>`, and wait until both answer:

| Name | Type | Value |
| --- | --- | --- |
| `inngest.nativeintelligence.dev` | A | `<server>` |
| `sb.nativeintelligence.dev` | A | `<server>` |

```bash
dig +short inngest.nativeintelligence.dev sb.nativeintelligence.dev
```

Then:

```bash
cd /opt/native-intelligence/deploy/edge
```

```bash
sudo install -m 600 -o root -g root .env.example .env
```

```bash
sudo nano .env
```

Set `SUPABASE_UPSTREAM` to the hosted Supabase project's URL (`https://<project ref>.supabase.co`, no trailing slash). That makes `sb.nativeintelligence.dev` a plain pass-through to the hosted project: nothing uses it until the app is pointed at it, and when Supabase moves to this server only this one value changes.

```bash
sudo docker compose up -d
```

```bash
sudo docker compose logs --tail 40 caddy
```

Look for `certificate obtained successfully` for both names. Then check the allowlist from your own machine. The first two must print `404`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://inngest.nativeintelligence.dev/
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST -d '{"query":"{apps{name}}"}' https://inngest.nativeintelligence.dev/v0/gql
```

These two must print `401`: the path is open, and Inngest itself refuses a caller without the right key.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST -d '{"name":"test"}' https://inngest.nativeintelligence.dev/e/not-the-key
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://inngest.nativeintelligence.dev/fn/register
```

And the pass-through must answer the way the hosted project does: `200` or `401` (Supabase asking for its API key), not `502`, which is Caddy failing to reach the upstream.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://sb.nativeintelligence.dev/auth/v1/health
```

After changing the `Caddyfile` (by hand or with `git pull`), check it and reload. Ordinary requests in flight are not dropped. Open WebSockets are: once the app uses the Supabase host, a reload closes every live-update connection at once and each client reconnects by itself, so reload at a quiet moment.

```bash
sudo docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
```

```bash
sudo docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

## 10. The Inngest dashboard

The dashboard has no login, so it is not on the internet. Reach it through SSH from your own machine:

```bash
ssh -N -L 8288:172.30.0.10:8288 deploy@<server>
```

Leave that running and open <http://localhost:8288>. `172.30.0.10` is the Inngest container's fixed address on the `ni-edge` network; it is reachable from the server itself and from nowhere else. Stop the tunnel with Ctrl-C.

## 11. Backups

What you need first:

1. **A B2 bucket.** Private. B2 bucket names are unique across all of B2, so `native-intelligence-backups`, or that plus a short suffix if it is taken.
2. **A B2 application key** limited to that bucket, with read and write access. B2 shows the `keyID` and `applicationKey` once.
3. **Two encryption secrets.** Run this twice; the first output is the password, the second the salt. Both go in the password manager: without them nobody can read the backups, you included.

   ```bash
   openssl rand -base64 32
   ```

4. **A dead-man check** that expects a request once a day and alerts after about 26 hours of silence. It gives you a URL.

Then:

```bash
cd /opt/native-intelligence/deploy/backup
```

```bash
sudo install -m 600 -o root -g root .env.example .env
```

```bash
sudo nano .env
```

Fill in the B2 values, `BACKUP_PASSWORD`, `BACKUP_SALT`, `BACKUP_INNGEST_PGPASSWORD` (the Postgres password from step 8) and `BACKUP_INNGEST_PING_URL`.

```bash
sudo docker compose up -d --build
```

Do not wait for the night. Take one backup now and look at it:

```bash
sudo docker compose exec backup backup-postgres inngest
```

```bash
sudo docker compose exec backup rclone lsf -R --files-only --format tsp vault:inngest/
```

The first must end in `[inngest] done`, the second must list one file, and the dead-man check must show a first ping. From then on it runs every night at 07:17 UTC.

Restoring, reading a backup away from the server, and adding a second database are in [`backup/README.md`](backup/README.md). Do one test restore now, while nothing depends on it.

## 12. Pruning Inngest's history

Inngest never deletes the history of finished runs, so its Postgres grows for ever. [`inngest/prune-history.sh`](inngest/prune-history.sh) deletes what belongs to runs that **ended** more than 30 days ago and never touches a run that is still going, however old. The rules are the Inngest server's own retention guide; they are written out at the top of [`inngest/prune-history.sql`](inngest/prune-history.sql).

Without `--apply` it only counts:

```bash
sudo /opt/native-intelligence/deploy/inngest/prune-history.sh
```

Once the server has run for a month, schedule it for the first of each month. The hour is 10:23 UTC on purpose: step 4 lets the server reboot itself at 08:30 UTC when an update needs it, and a prune that started just before would be cut off part-way.

```bash
sudo tee /etc/cron.d/ni-inngest-prune >/dev/null <<'EOF'
# Monthly prune of finished Inngest runs older than 30 days. See deploy/README.md.
23 10 1 * * root /opt/native-intelligence/deploy/inngest/prune-history.sh --apply 2>&1 | logger -t ni-inngest-prune
EOF
```

Its output goes to the system log: `sudo journalctl -t ni-inngest-prune`.

## 13. Pointing the app at this server

Until this step the server is idle and the app still uses Inngest Cloud. The switch is four environment variables on the app, the app-side pull request, and one line here. Do them in this order, in one sitting.

1. **Know what is left behind.** Nothing moves from Inngest Cloud to this server. Runs that are in flight there (sleeping, waiting, queued) will fail once the app's keys change: let them finish first or accept losing them.
2. **In the app's production environment**, set:

   | Variable | Value |
   | --- | --- |
   | `INNGEST_BASE_URL` | `https://inngest.nativeintelligence.dev` |
   | `INNGEST_DEV` | `0` |
   | `INNGEST_SIGNING_KEY` | the signing key from step 8 |
   | `INNGEST_EVENT_KEY` | the event key from step 8 |

   If the Inngest integration is installed on the hosting account, remove it from this project first: it manages the last two variables and would put the Inngest Cloud values back. The new values only take effect in the next deployment.
3. **Merge the app-side pull request** (the one that renames the Inngest app to `native-intelligence` and removes the old sync cron). Production starts building with the new variables.
4. **While it builds, turn on the sync loop here.** In `/opt/native-intelligence/deploy/inngest/.env`, uncomment `COMPOSE_PROFILES=sync`, then:

   ```bash
   cd /opt/native-intelligence/deploy/inngest && sudo docker compose up -d
   ```

   Until the new deployment is live the loop reaches the old one, which answers by registering with Inngest Cloud, as it always has. That is harmless for a few minutes, and it means the new deployment is asked within a minute of going live.
5. **The moment the new deployment is live, make it register**, without waiting for that minute. Until the app has registered here, the events it sends arrive and start nothing, and they are not replayed.

   ```bash
   curl -sS -X PUT https://<the app's production domain>/api/inngest
   ```

   It must answer `"Successfully registered"` (with `"modified":false` if the loop got there first). Then look in the dashboard (step 10): the app `native-intelligence` must show its functions and no error, at the address in `INNGEST_SDK_URL`. The dashboard is the proof. The answer above, and the sync loop's log, only say that the app registered somewhere.
6. **Archive the app in Inngest Cloud.** Otherwise its scheduled functions keep calling production on every tick and are refused, because the keys no longer match.
7. **Watch one real run** go through in the dashboard, and look at the sync loop once:

   ```bash
   sudo docker compose logs --tail 20 sync
   ```

   It logs its first answer, later changes to the function list, and failures. Silence after that is the normal state.

Why the sync loop exists: `inngest start` only asks an app for its function list while that app is in an error state. A deploy that adds or changes a function would otherwise never reach the server. The server is deliberately not started with the app's address (`--sdk-url`): given one, it sends the app a sync request at startup and then every minute until the app registers with it, and before this step each of those would make production re-register with Inngest Cloud. The loop sends the app the same request every 60 seconds (`SYNC_INTERVAL_SECONDS`); a registration that changes nothing is ignored. It is kept off before this step because the app registers with whichever Inngest *it* is configured for.

If the app's host puts a bot challenge or deployment protection in front of the production domain, `/api/inngest` has to be exempt: the server calls it from this machine's address, and so does the sync loop.

**Rolling the app back goes back to Inngest Cloud.** A deployment keeps the environment it was built with. Rolling production back to a deployment from before this step therefore also puts the Inngest Cloud keys back: the app sends its events there again and refuses this server's requests. That is the way to undo the cut-over on purpose (then comment `COMPOSE_PROFILES` again and run `sudo docker compose stop sync`, and restore the four variables so the next deployment matches). It is also what an "instant rollback" for an unrelated bug does without saying so: after this step, fix forward, or roll back only to deployments made after it.

## Day to day

Run these from the stack's own folder.

| To | Command |
| --- | --- |
| See what is running | `sudo docker compose ps` |
| Read logs | `sudo docker compose logs --tail 100 -f <service>` |
| Restart one service | `sudo docker compose restart <service>` |
| Pick up changes to this folder | `cd /opt/native-intelligence && git pull`, then `sudo docker compose up -d` in each stack that changed (`--build` for `backup/`) |
| Upgrade Inngest | Read the release notes, change the image tag in `inngest/compose.yaml`, then `sudo docker compose pull inngest && sudo docker compose up -d inngest` |
| Patch Postgres, Redis, Caddy | `sudo docker compose pull && sudo docker compose up -d` (they follow `17`, `7` and `2.11`) |

Stopping and starting is safe: Redis writes every change to disk within a second and Postgres is Postgres. `sudo docker compose down` keeps the volumes. **`down -v` deletes them.**

## What the Inngest host lets through

`inngest.nativeintelligence.dev` answers `404` for everything except five requests. They are the ones the app's SDK makes to an Inngest server, worked out from the SDK the app installs (`inngest` 4.0.0, files under `node_modules/inngest/`) and from the server's route table (`inngest/inngest` v1.51.0), then confirmed by running that SDK against that server through this Caddyfile: across checkpointed and plain functions, large state, batches, sleeps, waits, invokes, parallel steps, retries and a cron, these were the only paths requested and none was refused.

| Request | When the SDK makes it | In the SDK | On the server | The server checks |
| --- | --- | --- | --- | --- |
| `POST /e/<event key>` | `inngest.send()` and `step.sendEvent()` | `components/Inngest.js` | `pkg/api/api.go` | the event key in the path |
| `POST /fn/register` | Sync: after the server or the sync loop sends `PUT` to the app | `components/InngestCommHandler.js` | `pkg/devserver/api.go` | signing key |
| `GET /v0/runs/<run id>/actions` | A run whose saved steps are too big to send with the request (`use_api`) | `api/api.js`, called from `helpers/functions.js` | `pkg/coreapi/coreapi.go` | signing key |
| `GET /v0/runs/<run id>/batch` | Same, for the run's events | `api/api.js`, called from `helpers/functions.js` | `pkg/coreapi/coreapi.go` | signing key |
| `POST /v1/checkpoint/<run id>/async` | Checkpointing, on by default in SDK v4: each finished step is reported while the request is still running | `api/api.js`, called from `components/execution/engine.js` | `pkg/api/apiv1/checkpoint.go` | signing key |

Each rule matches the method and the exact shape of the path, and Caddy rebuilds the path it forwards from what matched, so Inngest never sees doubled slashes, dot segments or escapes. The event key is kept out of Caddy's access log.

**Closed on purpose.** The SDK can call these too, but the app does not use the features behind them. Each needs a new rule in [`edge/Caddyfile`](edge/Caddyfile) the day it does; until then a call fails with a `404` from Caddy in the app's logs.

| Request | Feature |
| --- | --- |
| `POST /v1/checkpoint`, `POST /v1/checkpoint/<run id>/steps`, `GET /v1/http/runs/<run id>/output` | Durable endpoints (`inngest.endpoint()`) |
| `POST /v1/signals` | `step.sendSignal()` / `step.waitForSignal()` |
| `POST /v1/realtime/publish`, `POST /v1/realtime/token`, the `/v1/realtime/connect` WebSocket | Inngest Realtime |
| `POST /v1/runs/<run id>/metadata` | Run metadata |
| `POST /v1/traces/userland` | The extended traces middleware |
| `POST /v0/connect/start`, `POST /v0/connect/flush`, and port 8289 | `connect()` workers instead of `serve()` |

**Never to be opened.** These have no authentication on a self-hosted server: the dashboard (`/` and its assets), GraphQL (`/v0/gql`), `/metrics`, `/debug` (the Go profiler), `/mcp`, `/dev/traces`, `/health`. Use the tunnel.

## What was tested, and what was not

Tested, on a throwaway Docker host with the real images (Inngest v1.51.0, Postgres 17, Redis 7, Caddy 2.11, rclone 1.75.2) and a test app on the same SDK build as the web app:

- All three compose files (`docker compose config`), the Caddyfile (`caddy validate`, `caddy fmt`), and the scripts (ShellCheck).
- Inngest starts healthy from `inngest/compose.yaml`, migrates Postgres, uses the external Redis, and publishes nothing.
- The allowlist: the five requests work, everything else is a `404` that never reaches Inngest, including path tricks. No key in the access log, nor in the error Caddy logs when Inngest is down.
- A full sync and every kind of run listed above, through Caddy, with checkpointing on and with it switched off for the whole client.
- The server as `inngest/compose.yaml` runs it, without `--sdk-url`: it sends the app nothing while the sync loop is off, and with the loop on the app registers and its functions run. The loop picks up a changed function list by itself; without it the server did not, for as long as it was watched.
- The shared network created with `--ip-range` as in step 7: the Inngest server keeps `172.30.0.10` and every other container is given an address from `.128` up.
- The pass-through host: `Host` rewritten, forwarded headers set and not spoofable, server-sent events and chunked bodies delivered chunk by chunk, a WebSocket held open, a 150-second response delivered.
- The backup job on its real schedule into a local folder: encrypted at rest, read back, retention, the ping, and the failure paths (no ping, nothing half-written). A restore into the running database (and one cut off half way, which left the database untouched), and reading a backup with a second, hand-made rclone config.
- The prune, applied with a zero-day window on a test database: finished runs deleted, a sleeping run and a waiting run untouched, and the waiting run finished normally afterwards.
- The SSH drop-in against Ubuntu 24.04's sshd, the apt snippets and `daemon.json` (parsed by their own tools).
- The whole stack killed without warning (the test machine restarted): every container came back by itself with its data, and the next function ran.

**Not tested, because there is no server yet:**

- Steps 2 to 7 as a whole on a real machine: the provider's image, `ufw`, the reboot after upgrades, Docker's install from its repository, the `sysctl` line, and `sudo nano` on the `.env` files as the `deploy` user.
- Certificates: Caddy has only run over plain HTTP here. Issuance needs the real DNS names.
- Anything involving the real app on its real host: the server reaching `/api/inngest`, the 91 real functions, request sizes and timing under load, and whether a bot challenge sits in front of that path.
- Backblaze B2: uploads, the application key's permissions and deletes for retention ran against a local folder, not B2.
- The pass-through against the real hosted Supabase project.
- The monthly cron line and the prune at real table sizes.

**Open items:**

- **Runs in flight are not backed up.** They live in Redis. See [`backup/README.md`](backup/README.md).
- **One kind of row is never pruned.** Inngest writes a small `traces` row for every received event and every cron tick under an all-zero run id. The server's retention guide does not mention them, so the prune script leaves them and prints their count and size each time it runs. If that number becomes large, decide then.
- **The sync loop is a workaround** for `inngest start` not re-syncing a healthy app in v1.51.0. If a later version does it itself, remove the `sync` service.
- **A Caddy reload closes open WebSockets.** Fine today, when nothing uses the `sb.` host. Once Supabase Realtime goes through it, `stream_close_delay` in the Caddyfile is the setting to look at.
- **Postgres has no tuning.** It runs with the image's defaults, which is fine to start with on this machine.

# The server

Everything Native Intelligence runs on its own server lives in this folder. It is being moved there from managed services one piece at a time. The first piece (steps 1 to 13) is the server itself and a self-hosted [Inngest](https://www.inngest.com/docs/self-hosting) that the app (still on Vercel) sends its background work to. The second (steps 14 to 19) is [Supabase](https://supabase.com/docs/guides/self-hosting/docker): the app's database, sign-in, live updates and files.

| Folder | What it runs | Public? |
| --- | --- | --- |
| [`edge/`](edge) | Caddy on ports 80 and 443, with automatic certificates. An allowlist in front of Inngest, and a pass-through host for Supabase. | Yes, the only thing that is |
| [`inngest/`](inngest) | The Inngest server, its own Postgres 17 and Redis 7, and a small loop that keeps the app's function list in sync. | No ports on the host |
| [`supabase/`](supabase) | Supabase's own self-hosted stack (Postgres 17, Auth, the data API, Realtime, Storage, edge functions, Studio), and the scripts that move the hosted project onto it. | No ports on the host |
| [`backup/`](backup) | Encrypted backups to Backblaze B2: Inngest's Postgres nightly, the Supabase database hourly, the stored files nightly. | No |

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
├── edge/       compose.yaml  compose.supabase.yaml  Caddyfile        .env
├── inngest/    compose.yaml  sync.sh  prune-history.sh  prune-history.sql  .env
├── backup/     compose.yaml  compose.supabase.yaml  Dockerfile  crontab  bin/  .env
└── supabase/   compose.override.yaml  postgres/  gateway/  check-env.sh  .env.example
    ├── stack/      Supabase's own files, never edited            .env
    └── migrate/    the move from the hosted project              .env

Docker volumes   ni-inngest-postgres   ni-inngest-redis
                 ni-edge-caddy-data    ni-edge-caddy-config
                 ni-supabase-db        ni-supabase-storage
                 ni-supabase-db-config ni-supabase-deno-cache
Docker networks  ni-edge      shared by Caddy and whatever it proxies to (172.30.0.0/24;
                              fixed addresses below .128, Docker hands out the rest)
                 ni-inngest   Inngest, its Postgres and Redis, and the backup container; no route out
                 ni-supabase  the Supabase stack and the backup container (172.31.0.0/24,
                              split the same way)
                 ni-supabase-edge  Caddy and the Supabase gateway, and nothing else
```

**The `.env` files.** Each folder has a `.env.example` that lists every setting with a comment. The real `.env` sits beside it, on the server only (for Supabase it sits in `supabase/stack/`, where Supabase's own tools look for it):

- owned by root and readable by root alone (`-rw------- root root`);
- never in git (`deploy/.gitignore` refuses them);
- a copy of each, filled in, in the password manager. They are the only thing you need to rebuild the server.

Each one is created the same way, shown in the steps below: `sudo install -m 600 -o root -g root .env.example .env`, then `sudo nano .env`. (Not `sudoedit`: it refuses to edit a file in a folder your own user can write to, which this checkout is.)

**The shared network.** Create it once. Caddy and Inngest both join it by name, and the fixed range is what gives the Inngest dashboard a fixed address for the tunnel in step 10. `--ip-range` makes Docker hand out addresses from the upper half only (`.128` and up), so the lower half is free for fixed addresses such as Inngest's `172.30.0.10`. Without it, any container that joined first could be given that address, and Inngest would then fail to start.

```bash
sudo docker network create --subnet 172.30.0.0/24 --ip-range 172.30.0.128/25 ni-edge
```

**The network between Caddy and Supabase.** Create this one as well. It will hold two containers and no more: Caddy and the Supabase gateway. They do not meet on `ni-edge`, because the gateway answers on every network it is attached to, with Studio and its SQL endpoint on one of its ports, and `ni-edge` is where every other stack sits. Nothing joins this network until step 14, so making it now costs nothing.

```bash
sudo docker network create ni-supabase-edge
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

## 14. Supabase: the stack

This brings up an empty Supabase. Nothing uses it and nothing public reaches it until step 18. [`supabase/README.md`](supabase/README.md) explains what is in the folder; in short, `supabase/stack/` is Supabase's own release, with not one of its files edited, and everything of ours is layered on top of it.

**Two more folders of the repository.** The stack serves the app's email templates and runs its Stripe function straight from where they already live, so the server's checkout needs them:

```bash
cd /opt/native-intelligence && git sparse-checkout add web/supabase/functions web/supabase/templates
```

**The settings.**

```bash
cd /opt/native-intelligence/deploy/supabase
```

```bash
sudo install -m 600 -o root -g root .env.example stack/.env
```

Supabase's own script generates the secrets that are new here (the database password, the Studio password, the internal keys):

```bash
cd stack && sudo sh utils/generate-keys.sh --update-env && sudo rm -f .env.old
```

It prints what it generated. Then fill in the rest, starting with `DASHBOARD_USERNAME`, the one line of section 1 the script leaves empty (the Studio login; choose any name):

```bash
sudo nano .env
```

Most of what comes from the hosted project (groups 1 and 3 below) does not have to be typed. From your own machine, [`supabase/pull-hosted-settings.sh`](supabase/pull-hosted-settings.sh) reads it from the hosted project with your Supabase login and writes it into this file, without showing a secret anywhere. It says what it wrote and what the hosted project has that this stack has no setting for:

```bash
deploy/supabase/pull-hosted-settings.sh <project ref> <user>@<server>
```

[`supabase/.env.example`](supabase/.env.example) describes every line. Three groups matter most:

1. **Copied from the hosted project** (section 2): `JWT_SECRET`, `ANON_KEY` and `SERVICE_ROLE_KEY`, **replacing** what the script just generated for those three, and `JWT_EXPIRY`. With the hosted project's own secret and keys, the keys compiled into the apps and every signed-in session keep working after the switch. The six "new key" settings below them stay empty.
2. **Where the stack is** (section 3): `SUPABASE_PUBLIC_URL=https://sb.nativeintelligence.dev` and `API_EXTERNAL_URL=https://sb.nativeintelligence.dev/auth/v1`, from the start. That name keeps pointing at the hosted project until step 18; inside the server, the scripts reach this stack under it already.
3. **Auth settings that exist only in the hosted dashboard** (section 4): Google, Apple, SMTP, the site URL, the redirect allow-list, the email subjects. Leave `HOOK_BEFORE_USER_CREATED_ENABLED=false` for now: the function it calls arrives with the database.

Then let the checker read it. It verifies, among other things, that the two keys really are signed with the secret:

```bash
cd .. && sudo ./check-env.sh
```

**Start it.** The stack joins the network `ni-supabase-edge` from step 7 and will not start without it. On a server that was set up before that network was part of step 7, make it now (this prints nothing if it is already there):

```bash
sudo docker network inspect ni-supabase-edge >/dev/null 2>&1 || sudo docker network create ni-supabase-edge
```

The first start downloads several gigabytes of images.

```bash
cd stack && sudo sh run.sh start
```

```bash
sudo sh run.sh status
```

Every service must be `healthy` (`mail-templates` has no health check and says `Up`). If one is not: `sudo sh run.sh logs <service>`.

Check that nothing of it is on the internet. This must print only Caddy's two ports:

```bash
sudo docker ps --format '{{.Names}}  {{.Ports}}' | grep -E '0\.0\.0\.0|\[::\]'
```

**Put Caddy on the gateway's network.** Until now Caddy has no way to reach this stack, which is right for a server without one. In `/opt/native-intelligence/deploy/edge/.env`, add this line (a file made from a newer `.env.example` has it commented out: uncomment it):

```text
COMPOSE_FILE=compose.yaml:compose.supabase.yaml
```

```bash
cd /opt/native-intelligence/deploy/edge && sudo docker compose up -d
```

Caddy is replaced by a new container on both networks, which interrupts both public names for a few seconds; pick a quiet moment. Nothing else changes: the Supabase name still goes to the hosted project until step 18. Then, from inside Caddy, the gateway must answer `401` (it is there and wants a key):

```bash
sudo docker compose exec caddy wget -q -S -O /dev/null http://ni-supabase-gateway/auth/v1/health 2>&1 | head -n 1
```

> **Never run `sudo docker compose down -v` in `supabase/stack`, and never run `reset.sh` there.** `-v` deletes the database, every stored file, and the key Postgres encrypts with. To stop the stack: `sudo sh run.sh stop`. Nothing else is needed, ever.

## 15. Studio

Studio is Supabase's dashboard: tables, SQL, users, files. It is not on the internet. Like the Inngest dashboard it is reached through SSH, from your own machine:

```bash
ssh -N -L 8000:172.31.0.10:8000 deploy@<server>
```

Leave that running and open <http://localhost:8000>. It asks for `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` from `stack/.env`. `172.31.0.10` is the gateway's fixed address on the Supabase network.

What Caddy will forward to (in step 18) is a second door on that same gateway that only lets the API through: `/auth/v1/`, `/rest/v1/`, `/graphql/v1`, `/realtime/v1/`, `/storage/v1/` and `/functions/v1/`. Studio, and everything else, answers `404` there. Both doors can be reached from the server itself, from the stack's own containers and from Caddy, and from nowhere else. From the server:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://172.31.0.10/
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://172.31.0.10/auth/v1/health
```

The first must print `404`, the second `401` (the API is there and wants a key).

## 16. Rehearse the move

A full run of the move into this stack, while production stays exactly where it is. The copy is private: it is reachable only through an SSH tunnel. Do this at least once, days before the switch. It is where you find out how long the move takes and what does not fit.

Set up the scripts as [`supabase/migrate/README.md`](supabase/migrate/README.md#before-you-start) says (the Supabase CLI, an S3 key on the hosted project, `migrate/.env`). Then, from `/opt/native-intelligence/deploy/supabase/migrate`, in this order. Each one ends by naming the next.

```bash
sudo ./00-preflight.sh
```

```bash
sudo ./01-dump.sh
```

```bash
sudo ./02-restore.sh dumps/<the folder 01-dump.sh named>
```

```bash
cd ../stack && sudo sh run.sh restart && cd ../migrate
```

```bash
sudo ./03-copy-storage.sh
```

```bash
sudo ./04-verify.sh
```

Every line the scripts print starts with the time. Write down how long the dump, the restore and the file copy each took: their sum, plus the verification, is how long the apps will be down in step 18.

If `02-restore.sh` stops with a list of tables or columns that "do not exist here", the hosted project's Auth or Storage is a version ahead of this release's. Nothing has been loaded at that point. [When the data does not fit](supabase/migrate/README.md#when-the-data-does-not-fit) has one flag for each case; write down the ones you needed, because the real switch needs the same ones.

`04-verify.sh` compares the two sides and prints every difference. In a rehearsal some are expected (the hosted project kept working after the dump; cron jobs are paused on the copy on purpose); [the runbook lists them](supabase/migrate/README.md#reading-the-verification). What must be the same even now: `functions`, `table grants`, `publication tables`, every policy (a line that differs in nothing but its brackets aside), and the files of each bucket, byte for byte.

**Use the copy.** Turn the sign-up check on now that its function is there (`HOOK_BEFORE_USER_CREATED_ENABLED=true` in `stack/.env`, then `sudo sh run.sh recreate auth`). From your own machine:

```bash
ssh -N -L 8080:172.31.0.10:80 deploy@<server>
```

and run the web app locally with `NEXT_PUBLIC_SUPABASE_URL=http://localhost:8080` and the usual keys. Sign in with your own account and password, open a workspace, open an attachment, change something and watch it appear in a second window. Use your own account only: the copy holds every real user's address, and it can send real email.

What a tunnel cannot show: sign-in with Google or Apple (they send the browser back to the public address, which is still the hosted project) and anything that needs HTTPS. Both are first seen for real at the switch.

Write down how long `01-dump.sh`, `02-restore.sh` and `03-copy-storage.sh` took. Their sum, plus a few minutes, is how long writes will be paused in step 18.

Leave the copy in place for step 17.

## 17. Backups, and the restore drill

Turn on the two Supabase jobs: an hourly dump of the database (the newest 48 are kept, and the newest of each of the last 30 days) and a nightly copy of the stored files.

First, two more dead-man checks: one that expects a request every hour, one every day.

```bash
cd /opt/native-intelligence/deploy/backup
```

```bash
sudo nano .env
```

Uncomment `COMPOSE_FILE=compose.yaml:compose.supabase.yaml` and fill in the `BACKUP_SUPABASE_*` lines; [`backup/.env.example`](backup/.env.example) says where each value comes from (all of them are in `supabase/stack/.env`).

```bash
sudo docker compose up -d --build
```

```bash
sudo docker compose logs --tail 10 backup
```

It must list three jobs. Run the two new ones now instead of waiting:

```bash
sudo docker compose exec backup backup-postgres supabase
```

```bash
sudo docker compose exec backup backup-storage supabase-storage
```

Each must end in `done`, and each check must show its first ping.

**The drill.** A backup that has never been restored is a guess, and right now the stack holds a copy that nothing depends on. Destroy it and bring it back from the backups.

First put one secret in the vault, so that the drill also proves the vault's key comes back, and take a backup that has it:

```bash
cd /opt/native-intelligence/deploy/supabase/stack
```

```bash
sudo docker compose exec db psql -U postgres -d postgres -c "select vault.create_secret('only a drill', 'ni-drill')"
```

```bash
cd ../../backup && sudo docker compose exec backup backup-postgres supabase
```

Now destroy the copy: the database, the stored files, and the volume that holds the vault key.

```bash
cd ../supabase/stack && sudo sh run.sh stop
```

(It ends by saying the network `ni-supabase` is still in use. The backup container is on it; that is as it should be.)

```bash
sudo docker volume rm ni-supabase-db ni-supabase-storage ni-supabase-db-config
```

```bash
sudo docker compose up -d --wait db
```

That is a new, empty database with a new vault key. Now follow [`backup/README.md`](backup/README.md#restore-the-database), "Restore the database" from its step 3 (everything but `db` is already stopped) and then "Restore the files". The restore must say that it put the backup's vault key in place, and its step 4 restarts the database so that the key is read.

Afterwards the copy must be what it was:

```bash
sudo docker compose exec db psql -U postgres -d postgres -Atc "select decrypted_secret from vault.decrypted_secrets where name = 'ni-drill'"
```

must print `only a drill` (then remove it: `delete from vault.secrets where name = 'ni-drill'`, the same way). Sign in through the tunnel again, open an attachment, and run `sudo ./04-verify.sh` in `supabase/migrate` once more: it must print what it printed before the drill (whatever you changed while using the copy shows as a difference from the hosted project both times).

These volumes are deleted on purpose only while what is in them is a copy: the two data volumes in "Starting again" between rehearsals and once more to empty the stack at the start of step 18, and all three here. After the switch, never.

## 18. The switch

Production moves here. For everything that reaches Supabase through `sb.nativeintelligence.dev`, the switch is one changed line in Caddy's `.env`. The rest of this step is making sure that the data is all here first, and that nothing is still writing to the place it came from.

**That second part is where data gets lost.** The hosted project keeps running after the switch: it is the undo. Anything that still talks to it directly, at its own `supabase.co` address, would go on working against it, and every change made there after the final dump is gone on the day the project is retired. Two things prevent that, and both are part of this step: nothing is left that uses the old address (the first gate below), and from the moment of the final dump the hosted project refuses changes, so that whatever was missed fails in front of the person instead of quietly succeeding (step 2).

**Gate 1, days before: every client uses `sb.nativeintelligence.dev`.** Do not start step 18 until all of this is true.

- **The web app.** Every Supabase URL in its production environment (`NEXT_PUBLIC_SUPABASE_URL`, and any other that names the project, such as `PROD_SUPABASE_URL`) is `https://sb.nativeintelligence.dev`, and a deployment built with them is live.
- **The desktop app.** A release that takes its Supabase address from the same setting is what people run. As this repository stands, `desktop/src-tauri/src/commands/auth_session.rs` only lets a sign-in start on the hosted project's own host; a build that still has that list cannot sign in with Google through Supabase after the switch.
- **The iOS app.** As this repository stands, `ios/Core/Config/SupabaseConfig.swift` builds the hosted project's own address into the app. Every copy of such a build goes on talking to the hosted project whatever is done here. A build that uses `sb.nativeintelligence.dev` has to be in the App Store, and old builds have to be gone or made to update, before this step.
- **The repository agrees.** From a full checkout (not the server's), this must print nothing but tests and comments:

  ```bash
  git grep -nE '[a-z0-9]{20}\.supabase\.co' -- web desktop ios
  ```

  Today it prints the two files above.
- **The hosted project agrees.** This is the proof, because it sees what people actually run. Everything that comes through Caddy reaches the hosted project from one address, this server's. In the hosted dashboard, under Logs, look at the API gateway's requests (`edge_logs`) for as many days back as the plan keeps, by the request header `cf-connecting-ip` ([their field list](https://supabase.com/docs/guides/observability/log-field-reference)): every request must come from this server's address. The header `x-client-info` on any that do not says which client library sent it. Expect Stripe's own addresses on `/functions/v1/stripe-webhook` until step 2 moves that.

**Gate 2, days before: the rest.**

- A rehearsal (step 16) and a drill (step 17) that both ended well, and the minutes the rehearsal took.
- **The freeze, rehearsed on the dev project.** Step 2 makes the hosted project refuse changes with [`freeze-hosted.sh`](supabase/migrate/freeze-hosted.sh). Part of what it does is documented by Supabase for hosted projects; part of it depends on rights this repository cannot see from here. [The runbook](supabase/migrate/README.md#freezing-the-hosted-project) says which is which. Run it `on` and then `off` against the dev project, and look at the dev app in between, before trusting it with production.
- `https://sb.nativeintelligence.dev/auth/v1/callback` is on the list of authorized redirect URIs of the Google OAuth client, and on the list of return URLs of the Apple Services ID. The hosted project used its own `supabase.co` address there; this stack uses this one. Adding it early does no harm, and without it nobody can sign in with Google or Apple after the switch.
- Every setting of [section 4 of `.env.example`](supabase/.env.example) is filled in and `sudo ./check-env.sh` says `no problems`.
- **The hosted project's other Auth settings, compared one by one** with what this stack will run with: rate limits, password rules, refresh token rotation and reuse interval, OTP expiry and length, session limits. [`supabase/README.md`](supabase/README.md#auth-settings) has where to read them all at once and how one is set here. One difference is deliberate: sign-in and refresh attempts are limited per client address here from the start.
- **Storage's upload limit.** `FILE_SIZE_LIMIT` in `stack/.env` is 50 MB. Compare it with the hosted project's limit (Storage settings) and with the largest file it holds (`00-preflight.sh` lists the buckets; `select max((metadata->>'size')::bigint) from storage.objects` gives the size).
- You know the hosted project's URL (it is `SUPABASE_UPSTREAM` in `edge/.env` today). It is the undo.

**1. Empty the stack.** The rehearsal copy is in it, and a restore wants an empty database. [Starting again](supabase/migrate/README.md#starting-again): stop, remove the two data volumes by name, start. Then `sudo ./00-preflight.sh` must say `empty, ready for a restore`.

**2. Pause writes.** From here until step 5, nothing may change in the hosted project, or it is left behind. Four things, in this order:

- Whatever the app has for a maintenance mode: turn it on.
- **The Stripe webhook.** In the Stripe dashboard (Developers, Webhooks), open the existing endpoint and change its URL **in place** to

  ```text
  https://sb.nativeintelligence.dev/functions/v1/stripe-webhook
  ```

  Editing the endpoint keeps its signing secret, which is the `STRIPE_WEBHOOK_SECRET` already in `stack/.env`; a new endpoint would get a new one. This is done now and not after the switch on purpose: an event that Stripe delivered to the old address during the move would be written to the hosted database after the dump was taken, and lost. Sent to the new address it gets a `502` for now, and Stripe sends it again later, for up to three days. If the endpoint already has this address, there is nothing to do.
- Close the door. In `/opt/native-intelligence/deploy/edge/.env`, point the Supabase host at nothing:

  ```text
  SUPABASE_UPSTREAM=http://127.0.0.1:9
  ```

  ```bash
  cd /opt/native-intelligence/deploy/edge && sudo docker compose up -d
  ```

From this moment every Supabase request through `sb.nativeintelligence.dev` answers `502`: the web app, the desktop app and the iOS app are down, for as long as the three scripts took in the rehearsal. (Caddy restarts to read the new line, which also interrupts Inngest's address for a second or two.) Background jobs that touch the database fail and retry while it lasts; look through the Inngest dashboard afterwards for runs that gave up.

- **Freeze the hosted project.** Closing the door stops what comes through it. This stops everything else: from here on the hosted project itself refuses changes, whoever asks and by whatever address.

  ```bash
  cd /opt/native-intelligence/deploy/supabase/migrate && sudo ./freeze-hosted.sh on
  ```

  It asks you to type `freeze`, then lists four parts, which must all say `on`: the data API, Storage for signed-in users, Storage for everyone, and accounts. If one says `off`, the lines above it say why and what is still accepted because of it. Then check from outside, from your own machine, at the hosted project's own address with its `anon` key. The first must print `503`, the second `200`:

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "apikey: <anon key>" -H "Content-Type: application/json" -d '{}' "https://<project ref>.supabase.co/rest/v1/member"
  ```

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -H "apikey: <anon key>" "https://<project ref>.supabase.co/rest/v1/member?select=user_id&limit=1"
  ```

  (The first asks to insert an empty row. Frozen, the answer is `503` before the database is asked. Not frozen, the answer is a refusal of another kind, `401` or `400`, and still nothing is inserted.) **The project stays frozen from now on**, through the switch and after it. The copy made in step 3 does not arrive frozen: the restore takes the freeze off this stack.

What the freeze does not reach is what runs inside the hosted database itself, and reads. An app that still uses the old address can still read, and sees data that stops changing; when it tries to save, sign in or upload, it is told the project has moved. That is the point: it fails where the person sees it. `04-verify.sh` in step 4 is the check that nothing got in before the freeze: it reads both sides after everything has been copied.

The cron jobs inside the hosted database are what neither the door nor the freeze stops: they run in the database itself. `00-preflight.sh` lists them, under "pg_cron jobs".

- The app has one of its own, `workspace-merge-runner`. It exists only while a workspace merge is waiting or running, works every 2 seconds, and removes itself when the merge is done. If it is listed, a merge is under way: wait, and run the preflight again until it is gone. Do not dump in the middle of one.
- Any other job: one that only reads or tidies up can be left alone. One that writes rows the app needs would write after the dump; pause it in the hosted project's SQL editor first (`select cron.alter_job(<jobid>, active := false);`, the ids are in `select jobid, jobname from cron.job;`). A job paused there arrives here paused, `--final` or not, so turn each one back on here in step 7.

**3. The final dump and restore.** In `supabase/migrate`, the same scripts as the rehearsal, with one flag: `--final` leaves the cron jobs running. If the rehearsal needed `--skip-column` or `--skip-table`, add the same ones after `--final`.

```bash
sudo ./00-preflight.sh
```

```bash
sudo ./01-dump.sh
```

```bash
sudo ./02-restore.sh dumps/<the new folder> --final
```

```bash
cd ../stack && sudo sh run.sh restart && cd ../migrate
```

```bash
sudo ./03-copy-storage.sh
```

**4. Verify.**

```bash
sudo ./04-verify.sh
```

With writes paused, `rows`, `accounts`, `sequences`, `file records`, `functions`, `table grants` and `publication tables` must each say `the same`, and each bucket's files `the same`. [The few differences that are still expected](supabase/migrate/README.md#reading-the-verification) are listed in the runbook: a table left out on purpose, a policy or constraint that differs in nothing but its brackets, the columns of a newer Auth or Storage. Under `not moved by any step`, the line for the freeze must read `Data API, Storage policies, Storage trigger, accounts` for the hosted side and `off` for this one. If anything else differs, do not go on: undo step 2 (`sudo ./freeze-hosted.sh off`, then the hosted URL back in `edge/.env`) and find out why with production running.

**5. Switch.** In `/opt/native-intelligence/deploy/edge/.env`, the one line:

```text
SUPABASE_UPSTREAM=http://ni-supabase-gateway
```

```bash
cd /opt/native-intelligence/deploy/edge && sudo docker compose up -d
```

`ni-supabase-gateway` is the Supabase gateway's name on the network it shares with Caddy, and the missing port means 80: its public door from step 15. Nothing else in Caddy changes.

**6. Check, from your own machine.** The first must print `401`, the second `404`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://sb.nativeintelligence.dev/auth/v1/health
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://sb.nativeintelligence.dev/
```

Then turn maintenance mode off and go through this list with the real apps. A doubt on any line is a reason to go back (step 19) now, not later.

| Check | What it must show |
| --- | --- |
| The web app, where you were signed in before | Still signed in, and your data is there. The session came over with the database. |
| The desktop app and the iOS app | The same. Each is a build from Gate 1; an older one is talking to the frozen project and says so when it tries to save. |
| Sign out, then sign in with Google | A full round trip: to Google, back to `sb.nativeintelligence.dev/auth/v1/callback`, into the app. Then the same with Apple. |
| Open an attachment; upload a new one | Both work. If the app allows large files, try one of 20 MB or more on a slow connection: a transfer may take as long as it needs. |
| Change something in one window with a second one open | It arrives in the second window. Leave both open for two minutes and do it again: the live connection (a WebSocket through Caddy and the gateway) must still be delivering well past 30 seconds. |
| In Stripe, "Send test event" to the endpoint | `200`. This is also the first time the function runs with its real imports. |
| The Inngest dashboard (step 10) | Runs that touch the database succeed again. Look for runs that gave up while the door was closed. |
| On the server: `cd /opt/native-intelligence/deploy/supabase/stack && sudo sh run.sh logs auth` | Sign-ins, no errors. |
| The hosted dashboard, Logs, a few minutes later | No new requests but the ones the freeze refused. Each of those is a client that Gate 1 missed. |

**7. Afterwards.**

- If you paused a cron job in the hosted project in step 2, it arrived here paused. Turn it on in Studio's SQL editor (step 15): `select cron.alter_job(<jobid>, active := true);`. The ids here are not the hosted ones: `select jobid, jobname, active from cron.job;`.
- Take a backup now rather than at the next hour: `sudo docker compose exec backup backup-postgres supabase` and `backup-storage supabase-storage` in `deploy/backup`.
- Delete the dumps and the migration settings ([when the move is over](supabase/migrate/README.md#when-the-move-is-over)): they are every user's data in plain text, and production credentials.
- **Leave the hosted project running and frozen** until you are sure. Running, because it is the undo. Frozen, because a client that was missed must not be able to write to it. Do not take the freeze off for any reason but going back. Look at its logs again after a day and after a week: requests there are apps that still need updating.

## 19. The undo

Going back is three things, in this order.

1. **Take the freeze off the hosted project.** Until this is done it refuses everything the apps would write, and going back would only move the outage.

   ```bash
   cd /opt/native-intelligence/deploy/supabase/migrate && sudo ./freeze-hosted.sh off
   ```

   All four parts must say `off`. If `migrate/.env` has already been deleted, paste [`sql/thaw.sql`](supabase/migrate/sql/thaw.sql) into the hosted project's SQL editor instead: it is the same statements, and it needs nothing stored on this server.
2. **The one line, the other way.** In `edge/.env` put the hosted project's URL back in `SUPABASE_UPSTREAM`, then `sudo docker compose up -d` in `deploy/edge`.
3. **What was paused.** A cron job paused in the hosted project in step 18.2 has to be turned on there again. The Stripe endpoint can keep its new address: the door passes `/functions/v1/` on to the hosted project's function again. Sign-in with Google and Apple works on both sides as long as both redirect addresses stay registered.

What the undo cannot do is carry back what happened here in the meantime. From the moment of the switch, new accounts, rows and files exist only on this server; the hosted project is as it was when it was frozen. Going back minutes after the switch loses minutes. Going back after a day loses a day, unless that day is moved by hand. So decide early: the checks in step 18.6 are there to be done at once, and a doubt in the first hour is a reason to go back, not to wait.

Once you are sure: pause or delete the hosted project (its dashboard), delete the S3 access key made for the move, and from then on never remove the data volumes again.

## Day to day

Run these from the stack's own folder. The Supabase stack has its own commands (`sudo sh run.sh …` in `supabase/stack`) and its own way of taking a new release: [`supabase/README.md`](supabase/README.md#day-to-day).

| To | Command |
| --- | --- |
| See what is running | `sudo docker compose ps` |
| Read logs | `sudo docker compose logs --tail 100 -f <service>` |
| Restart one service | `sudo docker compose restart <service>` |
| Pick up changes to this folder | `cd /opt/native-intelligence && git pull`, then `sudo docker compose up -d` in each stack that changed (`--build` for `backup/`) |
| Upgrade Inngest | Read the release notes, change the image tag in `inngest/compose.yaml`, then `sudo docker compose pull inngest && sudo docker compose up -d inngest` |
| Patch Postgres, Redis, Caddy | `sudo docker compose pull && sudo docker compose up -d` (they follow `17`, `7` and `2.11`) |

Stopping and starting is safe: Redis writes every change to disk within a second and Postgres is Postgres. `sudo docker compose down` keeps the volumes. **`down -v` deletes them.** In `supabase/stack` that is the app's whole database and every stored file: never run it there.

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

### Steps 1 to 13: the server, Inngest, Caddy, backups

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

### Steps 14 to 19: Supabase

Tested, on a throwaway Docker host (4 CPUs, 16 GB) with the real images of Supabase's release 0.8.4, everything run from a sparse checkout made the way steps 7 and 14 make it:

- Every compose file and combination (`docker compose config`): ours, theirs, theirs with ours on top, and the backup overlay. The merged Supabase stack publishes no port. All seventeen scripts pass ShellCheck.
- The stack from nothing, with `stack/.env` made from our `.env.example`, their key generator and `check-env.sh`: every service healthy, nothing published, Postgres running with the memory settings of `ni-memory.conf`, three restarts in a row.
- The public listener: the six API prefixes pass, Studio and `/pg/` and everything else answer `404`. Every printable character was tried around `..` in the path, raw and percent-encoded, against the listener and through the edge Caddyfile: none reaches Studio or `/pg/`. (The same test against a Caddy allowlist in front of the gateway found two that do, `;` and `\`, which is why the allowlist is inside the gateway.)
- Through the edge Caddyfile (plain HTTP), the listener and the gateway, with the Supabase client library: sign-up, sign-in, refresh, the data API under row-level security, upload, download and signed URLs (a file name with a space, `;`, `&`, `+` and brackets), Realtime broadcast and database changes over a WebSocket. The client's address arrives first in `X-Forwarded-For`, and forwarded headers sent by a client are dropped.
- Studio through the gateway's own port, in a real browser: the table editor, the users, the buckets. No request left that address.
- **Who can reach the gateway.** From a container that is only on `ni-edge`, its name does not resolve and neither of its ports answers at any address. From Caddy, over the network the two share, the API answers and Studio is `404`.
- **Slow transfers.** Before the fix, a 40 MB download read at 500 KB/s through the public listener was cut off after 25 MB. With it, a 40 MB upload and a 40 MB download at that speed each took 81 seconds through Caddy and the gateway and arrived whole. The gateway refuses to start, and says why, when the route it changes is not where it expects it (tried with a moved route and with a changed entrypoint).
- **Sign-in attempts per address.** Before: 80 wrong passwords in a row from one address, all answered. After: 30 answered, then `429`; a different made-up `X-Real-IP` and `X-Forwarded-For` on each request made no difference.
- A Realtime connection through Caddy and the gateway held open for 77 seconds, delivering at the start and at the end.
- Taking a release: their `update.sh` on this layout from 0.8.3 to 0.8.4, then `after-update.sh`. No conflicts, the folder ended file for file as this repository holds 0.8.4, and a setting present in their example and missing from ours was reported.
- The repository's own leak check (`.github/guard.sh`, gitleaks 8.30.1) on the result: clean. With Supabase's `.env.example` and `tests/` left in, it found seven of their demo keys, which is why those two are not kept.
- **The move.** A second, stock Supabase stack stood in for the hosted project, with the app's real schema built by `web/scripts/db-bootstrap.sh` (251 tables, 447 policies, 49 tables in the publication, the six extensions, both buckets), three accounts with live sessions, 14 files uploaded by those accounts, two cron jobs (one without a name), a vault secret, the `service_role` timeout, and an Auth made to look a version ahead: one table the self-hosted Auth does not have, and a column more on `auth.users`, `auth.sessions` (9 rows) and an empty table. The five scripts ran against it with the real Supabase CLI (3.1.0), as a rehearsal and again as the switch with `--final`, with "Starting again" in between. With that table left out (`--skip-table`) and that column left out (`--skip-column`), the verification says every row arrived, sessions included, and ends with the differences it should: the extra table and columns, named; one constraint written back with different brackets; the vault secret; in the rehearsal, the cron jobs paused (they were never active on the copy). Leaving out all of `auth.sessions` instead was refused and rolled back, naming the 9 refresh tokens that would have pointed at nothing.
- **The freeze.** `freeze-hosted.sh on` against the stand-in: every write through its data API answered `503` with the message (insert, update, delete, a function call, GraphQL), reads still `200`; an upload refused with a user's token and with the service-role key, downloads still served; sign-in and sign-up refused. Then the whole move with the stand-in frozen: the files copied, the verification showed the freeze on that side and `off` on this one and nothing else new, and the new stack accepted a write, a sign-in, an upload and a sign-up through Caddy. `off`: all four parts gone and the stand-in accepting everything again. Also tried and found not to work: `default_transaction_read_only` on the API role and on the database, after which writes through the data API still succeeded. A job on a `2 seconds` schedule, which is what the app's `workspace-merge-runner` uses, runs on the self-hosted database when scheduled by the `postgres` role.
- **What existing clients hold keeps working** on the new stack: an access token issued by the stand-in (a different issuer), the refresh token, the password, the `anon` and `service_role` keys. A new sign-up runs the app's triggers on `auth.users`. A user reads their own file and is refused someone else's.
- The sign-up hook on and off (a free-mail address refused with the app's own message), and three of the five email templates fetched from `web/supabase/templates` and delivered to a mail catcher, with a subject from `.env`.
- `stripe-webhook`: mounted from `web/`, reached with no Supabase key, and its own logic on the self-hosted runtime: no signature and a wrong signature refused, a correctly signed subscription event written to `subscriptions` and the plan assigned. **With one substitution:** see below.
- **Backups.** The hourly job and its retention (with older backups planted: the right ones survive), the roles file, the nightly file job over three runs (everything, nothing, one deletion and one replacement of the same size), and the container without the overlay scheduling only Inngest. An empty bucket, both retention numbers at 0 (everything is kept), a file from January deleted today (still held; a folder of removed files 60 days old is expired), and the restore refusing to start while any other service is connected. **The read-back check:** with one stored file overwritten on disk at the same size, and again with it gone, while the database still listed it, the nightly job failed and named the file; before the check existed the same job reported success. **The drill:** the backup restored over the running database as it is, and then with the database, the files and the volume holding the vault key deleted and everything restored from the backups, each time with the partitions Realtime makes for itself already there. On the new volume Postgres had made a new key; the restore put the backup's in its place, the secret stored in the vault beforehand could not be read until the database was restarted and could afterwards, and the database was identical in all 4,686 lines of its description (every table's content checksum, every grant, function, policy, sequence and file record), every file byte for byte.
- **The switch and the undo**, through the edge Caddyfile: the public name passing through to the stand-in, closed (`502`), pointed at the local gateway (served by the new stack, Studio `404`), back to the stand-in, and forward again.

**Not tested, and why:**

- **The freeze on a hosted project.** It was run against a stock self-hosted stack, which has the same data API, Auth and Storage and the same Postgres image, and not against the platform. One of its four parts is documented by Supabase for hosted projects; the other three depend on rights the platform may or may not grant. That is what the rehearsal on the dev project in step 18 is for.
- **Anything against the real hosted project.** It could not be reached from where this was written, by design. So: whether its Auth and Storage are ahead of release 0.8.4 (the restore checks and says so), how long 926 MB and 275 files take (the rehearsal data was 35 MB and 14 files), its S3 endpoint, and its session pooler from this server.
- **The real server.** The sandbox differs from Ubuntu 24.04 in two ways that were worked around in the test only: it forbids raising the open-files limit (the pooler asks for 100,000), and it uses the older cgroup layout (the functions service's memory monitor switched itself off). The 4 GB of shared buffers were allocated but never filled.
- **HTTPS**, and with it sign-in with Google and Apple end to end. The settings reach Auth (it reports Google as enabled); no real redirect was made.
- **`stripe-webhook` with its own imports.** It imports from `deno.land` and `esm.sh`, which the sandbox blocks, so for the test those three imports were mapped to the same libraries (Stripe 22.1.0, supabase-js 2) on npm and jsr. On the server it downloads the real ones on its first call. Stripe's own "Send test event" is the real test (step 18.6).
- A real SMTP provider, and the invite and email-change templates (nothing in the test triggered them).
- Backblaze B2 (a local folder stood in), and the cron lines firing by themselves (each job was run by hand).
- The real web, desktop and iOS apps. Everything was exercised with the Supabase client library from scripts.
- Taking a new release on a stack that holds data: the file merge was tested, the restart onto new images was not.
- A file larger than 200 MB (rclone switches to multipart uploads there). The largest today is far below that.

**Open items:**

- **The iOS and desktop apps do not use `sb.nativeintelligence.dev` yet**, as this repository stands (`ios/Core/Config/SupabaseConfig.swift`, `desktop/src-tauri/src/commands/auth_session.rs`). Nothing under `deploy/` can change that. Step 18 does not start until they do (its Gate 1), and the freeze is what limits the damage from a copy that was missed.
- **The gateway cuts every data API request at 30 seconds**, and the hosted project's `service_role` may run a statement for 120. A call that takes longer than 30 seconds gets a `504` here. Only Storage's limit was lifted ([why](supabase/README.md#the-storage-time-limit)).
- **Supabase's `postgres` role cannot write to every table their own dump contains** (`storage.buckets_vectors`, `storage.vector_indexes`). Both are empty on a project that does not use vector buckets, and the restore leaves empty ones out. If the hosted project has rows in them, the restore stops and says so.
- **Storage's S3 endpoint accepts a request only for the host name in `SUPABASE_PUBLIC_URL`.** The backup and the migration depend on that, by calling the gateway under that name inside Docker. It is how release 0.8.4 behaves; it is not documented by them. If a release changes it, the nightly file backup fails and its dead-man check says so.
- **Auth settings beyond the ones listed** in [`supabase/README.md`](supabase/README.md#auth-settings) (rate limits, password rules, CAPTCHA) fall back to defaults unless they are carried over by hand.

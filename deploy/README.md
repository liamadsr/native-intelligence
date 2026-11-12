# The server

Everything Native Intelligence runs on its own server lives in this folder. It has been moved there from managed services one piece at a time. The first piece (steps 1 to 13) is the server itself and a self-hosted [Inngest](https://www.inngest.com/docs/self-hosting) that the app (then still on its earlier host) sends its background work to. The second (steps 14 to 19) is [Supabase](https://supabase.com/docs/guides/self-hosting/docker): the app's database, sign-in, live updates and files. The third (steps 20 to 22) is the app itself: the web app, its eight agents and its scheduled jobs, from the container image in [`app/`](app). The fourth (step 23) is new rather than moved: [LiveKit](https://docs.livekit.io/home/self-hosting/), the media server for audio and video calls.

| Folder | What it runs | Public? |
| --- | --- | --- |
| [`edge/`](edge) | Caddy on ports 80 and 443, with automatic certificates. An allowlist in front of Inngest, a pass-through host for Supabase, the app's names, and LiveKit's signalling. | Yes: everything that is HTTP |
| [`livekit/`](livekit) | LiveKit and its own Redis, and its Egress (recordings; off until asked for). Keeps nothing on disk. | Its two media ports, UDP 7882 and TCP 7881 (step 23); its signalling only through Caddy |
| [`inngest/`](inngest) | The Inngest server, its own Postgres 17 and Redis 7, and a small loop that keeps the app's function list in sync. | No ports on the host |
| [`supabase/`](supabase) | Supabase's own self-hosted stack (Postgres 17, Auth, the data API, Realtime, Storage, edge functions, Studio), and the scripts that move the hosted project onto it. | No ports on the host |
| [`backup/`](backup) | Encrypted backups to Backblaze B2: Inngest's Postgres nightly, the Supabase database hourly, the stored files nightly. | No |
| [`app/`](app) | The app: web, a worker for background jobs, the eight eve agents and the scheduler, from one image built on the server, behind the stack's own proxy. | No ports on the host |
| [`server/`](server) | Not a container: [`setup.sh`](server/setup.sh), which does steps 3 to 7 below on a fresh server in one go. | |
| [`move/`](move) | Not a container: [`move.sh`](move/move.sh), which moves everything here to another server. | |

Everything runs on one server, and is kept movable: [`move/README.md`](move/README.md) is how the whole of it goes to another machine.

Follow this page top to bottom on a fresh server. Steps 3 to 7 are also available as one script, [`server/setup.sh`](server/setup.sh), which does what those steps describe and can be run again: it only adds what is missing, and restarts nothing that has not changed. Every command is meant to be pasted as written, except where a value in `<angle brackets>` is yours to fill in. [What was and was not tested](#what-was-tested-and-what-was-not) is at the end. Steps 1 to 13 have since run on two real servers, the second time through `server/setup.sh` and [`move/`](move). Steps 14 to 18 and the app's rehearsal (step 20) ran on the real server on 2026-11-10, and step 21 on 2026-11-11 (neither undo was needed): production is on the server since then, and [the record](#the-record) at the end says how each switch went.

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

Kernel fixes only take effect after a reboot, so let the server reboot itself when one is pending, at a quiet hour. The time is the server's clock, which is UTC: keep 08:37 or pick the hour that is the middle of the night for the people who use the product (step 12 schedules a job two hours after it). Keep it off the hour and the half hour: that is when scheduled jobs fire, and a reboot at that very second makes the ones that start a few seconds later skip a turn. The containers come back by themselves (step 6 makes Docker start at boot, and every service has a restart policy).

```bash
sudo tee /etc/apt/apt.conf.d/52ni-unattended-upgrades >/dev/null <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "08:37";
EOF
```

Check that it would run. The last lines should list the allowed origins and no error.

```bash
sudo unattended-upgrade --dry-run --debug 2>&1 | tail -n 20
```

This covers Ubuntu's own packages. Docker is upgraded by hand (`sudo apt-get install --only-upgrade docker-ce docker-ce-cli containerd.io`), because upgrading it restarts every container.

## 5. Firewall

Only SSH, 80 and 443 come in, and the two media ports of calls (step 23 says why those two).

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
sudo ufw allow 7882/udp comment 'LiveKit media (WebRTC over UDP)'
```

```bash
sudo ufw allow 7881/tcp comment 'LiveKit media (ICE over TCP)'
```

```bash
sudo ufw enable
```

```bash
sudo ufw status verbose
```

**One rule that the firewall cannot enforce for you.** A port published by a Docker container (`ports:` in a compose file) is reachable from the internet whatever ufw says, because Docker writes its own firewall rules ahead of ufw's. Caddy publishes 80 and 443 for everything that is HTTP. The one other container that publishes ports is LiveKit, and only its two media ports (UDP 7882 and TCP 7881): the media of a call is not HTTP, so it cannot go through Caddy, and goes straight to LiveKit, encrypted between the browser and LiveKit (DTLS-SRTP). Its signalling and its API do go through Caddy. Never add `ports:` to anything else in this folder. To reach a service from your own machine, use an SSH tunnel as in step 10.

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
├── supabase/   compose.override.yaml  postgres/  gateway/  check-env.sh  .env.example
│   ├── stack/      Supabase's own files, never edited            .env
│   └── migrate/    the move from the hosted project              .env
├── app/        compose.yaml  deploy.sh  proxy/  Dockerfile  entrypoint.sh  .env
└── livekit/    compose.yaml  make-keys.sh  .env

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
                 ni-livekit   LiveKit and its Redis; no route out
                 ni-livekit-edge  Caddy, LiveKit and its Egress, and nothing else; their way out
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

**The network between Caddy and LiveKit.** The same idea, for calls: Caddy and the LiveKit stack (LiveKit, and its Egress when that runs), and no one else. LiveKit takes traffic from the internet on its media ports, so it is kept off `ni-edge`, where it could reach the other stacks' doors. Unlike the two above it is that stack's only way out (to a STUN server, to the app's public name for the webhooks, to Storage's public name for recordings), so it is an ordinary network, not an internal one. Nothing joins it until step 23.

```bash
sudo docker network create ni-livekit-edge
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

The three B2 values can also be entered without ever appearing on screen or in your shell history: [`backup/set-b2-key.sh`](backup/set-b2-key.sh) asks for them with hidden input, writes them into `.env`, and checks that Backblaze accepts them.

```bash
sudo /opt/native-intelligence/deploy/backup/set-b2-key.sh
```

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

Once the server has run for a month, schedule it for the first of each month. The hour is 10:23 UTC on purpose: step 4 lets the server reboot itself at 08:37 UTC when an update needs it, and a prune that started just before would be cut off part-way.

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

Most of what comes from the hosted project (groups 1 and 3 below) does not have to be typed. From your own machine, [`supabase/pull-hosted-settings.sh`](supabase/pull-hosted-settings.sh) reads it from the hosted project with your Supabase login and writes it into this file through a pipe, without showing a secret anywhere:

```bash
deploy/supabase/pull-hosted-settings.sh <project ref> <user>@<server>
```

It lists what it is sending, and the server answers with how many settings it wrote. Three things it cannot bring, because the hosted project only ever gives out their fingerprint: the Google and Apple client secrets and the SMTP password. For those, and for any other secret, [`supabase/set-secret.sh`](supabase/set-secret.sh) asks with the typing hidden and writes the answer into the file:

```bash
deploy/supabase/set-secret.sh <user>@<server> GOOGLE_SECRET
```

The first runs without a terminal, so it needs `sudo` without a password on the server; the comment at the top of the script has the one line that allows that for a while. The second runs in a terminal, where `sudo` can ask. The first also names a few things the hosted project has switched on that this stack has no setting for (other sign-in providers, other hooks, CAPTCHA, session limits). It does not compare rate limits or password rules, which are listed under "Settings this list does not cover" in [`supabase/README.md`](supabase/README.md#auth-settings), nor the MFA switches.

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

Check that nothing of it is on the internet. This must print only Caddy's two ports (and, once step 23 is done, LiveKit's two):

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

- **The desktop app, before the web app.** The web decides where a Google sign-in starts, and the desktop app only opens its sign-in window on the hosts in `desktop/src-tauri/src/commands/auth_session.rs` (`SIGN_IN_PAGES`). That list has both of the project's addresses, the hosted one and `sb.nativeintelligence.dev`. A build from before it had the second refuses a Google sign-in that starts on the new address, which is every one from the day the web app moves, for as long as the web signs in with Google through Supabase (it does unless the app's own Google sign-in, `/auth/google`, has been switched on). So a release with the new list has to be what people run first.
- **The web app, in two settings, in this order.** First `NEXT_PUBLIC_SUPABASE_PROJECT_REF`, set to the hosted project's ref, **in the Production environment only**. The session cookie is named after the first label of the Supabase address (`sb-<label>-auth-token`); move the address without the pin and the cookie is renamed, which signs every person out at once, and production's cloud browsers start sharing a name with every development machine ([`web/src/lib/supabase/project.ts`](../web/src/lib/supabase/project.ts)). With the pin, the name stays what it was, in the app and in the two agents that read the session cookie. Setting it while the address is still the hosted one changes nothing: it gives the name the cookie already has. **Get that deployment live, and check that you are still signed in on it, before touching the address.** This is the only moment a wrong pin can be caught, because the hosted address still says which project it is: the production build stops on a pin that names another project than the address does (a mistyped ref), and on a value that could not be the start of an address at all. Once the address is ours nothing can tell a wrong pin from a right one, it is used, and everyone is signed out. So never set the pin and the address in one deployment. (What counts as a production build: a production deployment on Vercel, and off Vercel any `next build`, so the container image and a build on your own machine stop in the same way. In a Vercel preview or development build, and under `next dev`, a pin that names another project than a `supabase.co` address is production's pin having leaked there, so it is ignored with an error in the log. On a local address it is ignored everywhere.) Then every Supabase URL in the production environment (`NEXT_PUBLIC_SUPABASE_URL`, and any other that names the project, such as `PROD_SUPABASE_URL`) becomes `https://sb.nativeintelligence.dev`, and a deployment built with all of them is live. The pin stays for good. It keeps the cookie's name; that the sessions under it are still valid after the switch is the migration's doing, which brings the signing secret and the session tables across.
- **The iOS app.** As this repository stands, `ios/Core/Config/SupabaseConfig.swift` builds the hosted project's own address into the app. Every copy of such a build goes on talking to the hosted project whatever is done here. A build that uses `sb.nativeintelligence.dev` has to be in the App Store, and old builds have to be gone or made to update, before this step. The iOS client names its stored session after the first label of the address in the same way the web does, so that build also has to pin the old name (the `storageKey` option where `ios/Core/Services/SupabaseManager.swift` makes the client), or everyone on iOS is signed out by the update.
- **The repository agrees.** From a full checkout (not the server's), this must print nothing but tests, comments, and the desktop's sign-in list:

  ```bash
  git grep -nE '[a-z0-9]{20}\.supabase\.co' -- web desktop ios
  ```

  Today, apart from tests, it prints four files. Two are comments in the web app. One is `auth_session.rs`, where the hosted address is code and stays on purpose: builds that are already installed, and any deployment not yet moved, still start a sign-in there, so it is taken out only when the hosted project is retired. The fourth is the iOS configuration, which is the one that has to change.
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

## 20. The app: the stack, and a rehearsal

This puts the app on the server next to the copy that serves today, with production's settings and on production's database, at a test address. It touches nothing the people using the app reach: the real names keep pointing where they point, and the copy here is kept from doing anything nobody asked it to (the scheduled jobs, and taking production's background work from Inngest). [`app/README.md`](app/README.md) says how each part works.

**What it costs the server.** Twelve containers using about 1.6 GB of memory when idle, two images of about 5 GB each (the running one and the one before it), and up to 12 GB of Docker's build cache. [What was tested](#steps-20-to-22-the-app) has the measurements.

**1. The whole repository on the server.** The image is built here from `web/`, so the checkout needs it (about 110 MB):

```bash
cd /opt/native-intelligence && git sparse-checkout add web
```

**2. The settings file.**

```bash
cd /opt/native-intelligence/deploy/app && sudo install -m 600 -o root -g root .env.example .env
```

From your own machine, fill it from the app's current host. Its command-line tool must be logged in there; `PULL_PROJECT` and `PULL_TEAM` are the project and team ids the app runs under. The last argument is the test address, here `test.nativeintelligence.dev`:

```bash
PULL_PROJECT=<project id> PULL_TEAM=<team id> PULL_GENERATE=1 PULL_REHEARSAL=1 deploy/app/pull-settings.sh <user>@<server> NEXT_PUBLIC_APP_URL=https://test.nativeintelligence.dev
```

It writes every production setting the current host gives out, copies the Inngest keys from `inngest/.env`, checks the two Supabase keys against `supabase/stack/.env`, makes new values for the three internal secrets that may be new (`PULL_GENERATE`), puts stand-ins starting with `rehearsal-` into the two the app cannot start without (`PULL_REHEARSAL`), and ends with what is still missing, by name, in the groups `check_settings.py` uses (below, step 21). Nothing in the first group ("must be the value the earlier host has") is needed for a rehearsal. `AI_GATEWAY_API_KEY` is, for any agent to answer: make a key for the server in the AI Gateway's settings and enter it, and the rest when you have them, with hidden typing:

```bash
PULL_ENV_FILE=/opt/native-intelligence/deploy/app/.env deploy/supabase/set-secret.sh <user>@<server> AI_GATEWAY_API_KEY
```

Leave `NI_LIVE` empty: that is what makes this a rehearsal.

**3. Build and start.** About ten minutes the first time.

```bash
cd /opt/native-intelligence/deploy/app && sudo ./deploy.sh
```

It ends with the twelve containers and their state; every one must be `healthy`.

The build also decides where the coding agent's sandbox runs. With `SANDBOX_ACCESS_TOKEN`, `SANDBOX_TEAM_ID` and `SANDBOX_PROJECT_ID` in `.env` (step 21, Gate 1), `deploy.sh` hands the three to the build as BuildKit secrets, never as build arguments, and the coding agent's snapshot is prepared on the hosted sandbox service: the build log says `== eve build: coding-agent (sandbox: vercel)`. Without them it says `just-bash`, and the coding agent cannot run a coding run. The coding agent's container refuses to start on an image built for the other kind of sandbox than `.env` asks for (the hosted service, or none), so after entering or removing the three, build again (`sudo ./deploy.sh`); `--no-build` and `--rollback` stop at that container. A change of the team or project id alone is caught by the build (it rebuilds that step, and stops when the secrets name another project), not when the container starts: build again after that too, or the first coding run fails.

**4. The test address.** A DNS record, `A test.nativeintelligence.dev` pointing at `<server>`, and the name in `edge/.env`:

```text
APP_HOSTS=test.nativeintelligence.dev
```

Several names go on that line separated by spaces. Never a comma alone between two names: Caddy then refuses its whole configuration and the names it already serves go down with it. Check before every change takes effect; this runs beside the live Caddy and changes nothing:

```bash
cd /opt/native-intelligence/deploy/edge && sudo docker compose run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile
```

It must end in `Valid configuration`. Then:

```bash
sudo docker compose up -d
```

Caddy is replaced by a new container to read the new line: both public names it already serves are interrupted for a few seconds, and every Supabase live-update connection reconnects. Pick a quiet moment. Then, in `supabase/stack/.env`, add `https://test.nativeintelligence.dev/auth/callback` to `ADDITIONAL_REDIRECT_URLS` (comma-separated) and `cd ../supabase/stack && sudo sh run.sh recreate auth`: without it, a sign-in on the test address is sent back to the site URL instead. Auth restarts in a few seconds.

**5. Check.** From your own machine:

| Check | What it must show |
| --- | --- |
| `https://test.nativeintelligence.dev/` and `/login` | The pages, over HTTPS. |
| `curl -sI https://test.nativeintelligence.dev/sign-out` | `location: https://test.nativeintelligence.dev/login`, not `0.0.0.0` or `localhost`. |
| `curl -s https://test.nativeintelligence.dev/api/version` | `{"buildId":"<the first 8 characters of the commit>"}`. |
| Sign in with Google on the test address | Google, then `sb.nativeintelligence.dev/auth/v1/callback`, then back on the test address, signed in. |
| A chat message to the agent there | A reply streams in. |
| A message that makes the agent search the web | The search's result comes back into the reply. That is a helper agent calling back into the session, through the public address (`EVE_CALLBACK_BASE_URL`). |
| On the server: `sudo docker compose logs --tail 20 cron` | One line per job each time one is due, each saying it was skipped: nothing is called. |

Everything you do on the test address is real: it is production's database. What it does not do is the scheduled jobs, and it is never given production's background work. Leave it running as long as it is useful; it costs the server memory and nothing else.

Do not, on the test address: connect a mail account, get a phone number, or open the cloud browser. The first two register a webhook address with Microsoft, Google or Twilio, built from the address the copy runs under, and production's mail and texts would then arrive at the test name. The cloud browser uses the same sandbox names as production's.

## 21. The app: the switch

Done on 2026-11-11 ([the record](#the-record)); what that night found is written in at the steps it belongs to. "The current host" in this step and the next is the one the app left, the earlier host.

The app's names move here from its current host. For the people using it, the switch is a DNS change per name; the rest of this step is making sure that, from the first minute, exactly one copy of the app runs the scheduled jobs and takes Inngest's calls, and that this one has every setting production needs.

**Gate 1, days before: the settings.** Do not start until all of this is true.

- **Every setting is in `app/.env`, and the right one.** From your own machine:

  ```bash
  deploy/app/check-settings.sh <user>@<server>
  ```

  It says, for each setting, whether it is set and, where that can be told from the server, whether it is the right value, without showing one; it ends with `Gate 1, the settings: met`, or with what is in the way. Its first group, "must be the value the earlier host has", may hold nothing empty or wrong: what those sign or encrypt is already stored, or a provider holds the other copy. The current host shows none of them to anyone. They came over once, sealed, from a production build of the current host ([`app/README.md`, "Sealed copy"](app/README.md#sealed-copy-done-once-then-removed)); a value changed since comes from the password manager or from the provider that issued it (a Twilio token can be read in Twilio's console). Three can be proven against production's own data, and the check does: `CREDENTIAL_ENCRYPTION_KEY` must open every stored token ciphertext (connected accounts, connected apps, flow actions), `RUN_SKILL_INTERNAL_SECRET` must reproduce a stored phone code's hash, and the public half of `CLOUD_BROWSER_SIGNING_KEY` must be the one pinned in the desktop app. With `--fill` it also brings `GPT_LIVE_TRUNK_SECRET` from the Twilio trunk's origination address, once the Twilio settings are in. `STRIPE_SECRET_KEY` may be any secret key of the account and mode the stored customers are in; the check reads three of them with it, and the payment function's key (`supabase/stack/.env`) is one. [`app/README.md`](app/README.md#settings) says why each must be the same. Enter what is missing with hidden typing, several names at once (an empty answer leaves that one as it is):

  ```bash
  PULL_ENV_FILE=/opt/native-intelligence/deploy/app/.env deploy/supabase/set-secret.sh <user>@<server> NAME ...
  ```

  A new value takes effect when the containers start again: `sudo ./deploy.sh --no-build` in `app/`.
- **Values that were stored with a line break.** Two of the readable ones end in one (`OAUTH_STATE_SECRET`, `OUTLOOK_WEBHOOK_SECRET`), almost certainly added with `echo … |`, and the app uses them with it. A write-only one added the same way has one too, and `set-secret.sh` trims what is typed: give such a name as `NAME+nl` to keep the line break (`RUN_SKILL_INTERNAL_SECRET+nl`). For `RUN_SKILL_INTERNAL_SECRET` the check says which form production's is. For the others nothing stored can tell; whoever added the value knows.
- **No stand-ins left.** The check names any value still starting with `rehearsal-`. The containers refuse to start live with one. `BROWSER_INTERNAL_SECRET` may be a new value: only cloud browsers running at the moment of the switch hold tokens made with it (for at most six hours), and they have to be opened again.
- **The cloud browser's sandboxes.** They stay on the current host's sandbox service, logged in with `SANDBOX_ACCESS_TOKEN`, `SANDBOX_TEAM_ID` and `SANDBOX_PROJECT_ID`: an access token of that account (its settings, Tokens), scoped to the team the app's project is in, and the ids of that team and project. A token narrowed to the project is refused by the sandbox service and by the connector below: scope it to the team. The check lists the project's sandboxes with them. `CLOUD_BROWSER_RELAY_ORIGIN` is what the current host works out for itself: `https://browser-relay.` and the domain of `NEXT_PUBLIC_APP_URL` (`https://browser-relay.dial8.ai` with `https://dial8.ai`). `CLOUD_BROWSER_BASE_SNAPSHOT_ID` is the base snapshot's id; base snapshots never expire, so it is the one among the project's snapshots without an expiry that browsers have started from since it was set. Without them the cloud browser does not start. The same three also run the coding agent's sandboxes ([step 20](#20-the-app-the-stack-and-a-rehearsal), "Build and start"), and the image is built with them: after entering or changing any of them, `sudo ./deploy.sh`, not `--no-build`.
- **Slack.** It stays on the current host's connector service, which there knows the app by that host's own deployment token; here there is none, so the app uses settings instead (`web/src/lib/slack/config.ts`). `CONNECT_ACCESS_TOKEN` is an access token of that account (its settings, Tokens), scoped to the team the connector is in. Measured from this server: the connector refuses that token itself when asked for a Slack login ("Token subject is not accessible to this requester"), so the app uses it only to make a short-lived project token, the same request the host's own token library makes to refresh one, and sends that with every call to the connector (a Slack login, a new install, a removal; `web/src/lib/slack/connect-auth.ts`). `CONNECT_PROJECT_ID`, the id of the project the connector is attached to, names the project the token is made for; `CONNECT_TEAM_ID`, that project's team, goes with the request when set; it may stay empty (the request was measured working both with and without the team named). That token is for the project's development environment, valid for hours, so the connector must stay enabled for the project's development environment as well as production. This was seen working end to end from the server: a Slack login came back, and Slack accepted it for the right workspace. A forwarded event or button click carries a token naming `CONNECT_PROJECT_ID`, and the app takes only those. `CONNECT_ENVIRONMENT` may stay empty (production); a `*` in it or in the project id makes the app refuse every forwarded event, and the check calls it wrong. The check makes the same requests as the app, in order, and says at which step it stopped: it makes the project token exactly as the app does (the team named only when `CONNECT_TEAM_ID` is set), reads the connector with it (it must forward its events to `CONNECT_PROJECT_ID` at `/api/slack/events`), asks it for a Slack login for its default installation, and has Slack confirm that login is for that workspace. It shows no token, at most a length; trouble on the network, too many requests or the other side's failure is "cannot tell", not wrong. Where the connector delivers what it forwards is known: to the app's production domain, the name people use, not the host's generated address. The current host's request log of one forwarded event shows it, and it is what the vendor's documentation describes (the connector "resolves the target to a domain" of the project). So events follow that name here once its DNS points here, on two conditions. That domain stays assigned to the project on the current host, even after its DNS points here, so the connector keeps resolving to it; what happens if it is removed there is not known, so it is not removed. And the first forwarded event after the switch is the proof (step 5). Should events ever be unable to reach this server through a domain, they come here directly from Slack (the Slack app's event address pointed here), never passed on by anything left running on the current host; that is not built.
- **The rehearsal (step 20) ended well**, including the Google sign-in and a chat reply.

**Gate 2, the day before.**

- **The DNS records, at 60 seconds.** The app's names (`nativeintelligence.dev`, `www`, `dial8.ai`, `www`, both `browser-relay` names) need a TTL of 60 seconds, so that the switch and the undo each take about a minute to reach people. Look first at what each name really has. On the night they had no records of their own at the DNS host: they resolved through the current host's own catch-all (alias) records, whose answers carry a 30-minute timer that cannot be lowered. What works:
  1. Find the one address each name answers with today, and check that this one address serves every name as before (`curl --resolve <name>:443:<that address> -sI https://<name>/` for each).
  2. Add an explicit `A` record for each name, TTL 60, pointing at that address. Nothing changes for anyone yet.
  3. Ask the DNS host's own name servers (`dig +short <name> @<one of its name servers>`) and check that the explicit record is what they answer.
  4. Wait out the old timer, 30 minutes, before step 21.4.

  At step 4 these same records are changed to `<server>`. A name that never worked on the current host needs no preparation.
- Know the current values of those records: they are the undo. Changing a record gives it a new id at that DNS host, so list the records again before an undo rather than using ids written down before.
- `https://sb.nativeintelligence.dev/auth/v1/callback` and the app's redirect URLs are what they were: nothing in this step changes sign-in.

**1. Build for production.** With the app still serving from its current host. Run the pull again with production's address (the value `NEXT_PUBLIC_APP_URL` has on the current host, given here so that nothing of the rehearsal can stay behind), then build only:

```bash
PULL_PROJECT=<project id> PULL_TEAM=<team id> deploy/app/pull-settings.sh <user>@<server> NEXT_PUBLIC_APP_URL=https://dial8.ai
```

```bash
cd /opt/native-intelligence/deploy/app && sudo ./deploy.sh --build-only
```

**2. Switch off the current host's scheduled jobs.** In its project settings, under Cron Jobs: disable. Its command-line tool has no command for this, but its API does: `PATCH /v1/projects/<project id>/crons` with the body `{"enabled": false}`, after which the project shows `crons.disabledAt`. The same call with `true` is the undo. Its jobs and this server's must never both run: they would send the same texts and mails twice. From here until step 4 no scheduled job runs anywhere; a job that was due runs at its next turn.

**3. Live.** In `app/.env`:

```text
NI_LIVE=1
```

```bash
sudo ./deploy.sh --no-build
```

The containers start with production's address and start the schedule. Every image is labelled with the address it was built for, and `deploy.sh` refuses one that is not the address in `.env`. So the image before this one, the rehearsal's, cannot be gone back to with `--rollback`: until the next production build, going back is step 22. Nothing reaches them from outside yet: the names still point at the current host, which goes on serving, and Inngest still calls the app there.

**4. The names: the first on its own, then a few at a time.** The name in `NEXT_PUBLIC_APP_URL` goes first. The containers here reach each other through it: web calls the agents at that address, the agents call web and each other back at it, and Inngest calls the worker there. Until it points here, those calls from this server land on the current host, which knows nothing of this server's sessions. So, with `https://dial8.ai` there: `dial8.ai`, `www.dial8.ai`, `browser-relay.dial8.ai`, `nativeintelligence.dev`, `www.nativeintelligence.dev`, `browser-relay.nativeintelligence.dev`. For each:

1. Point its DNS record at `<server>`: change the `A` record made in Gate 2 to this address.
2. Check that the DNS host's own name servers answer with it: `dig +short <name> @<one of its name servers>` prints `<server>`.
3. Add it to `APP_HOSTS` in `edge/.env`, separated from the others by a space, right away. Check (`sudo docker compose run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile` in `deploy/edge`, as in step 20.4), then `sudo docker compose up -d`. Caddy gets the name's certificate within seconds; check with `curl -sI https://<name>/api/version`.

The certificate does not wait for resolvers such as `1.1.1.1` to catch up: the certificate authority asks the DNS host's own name servers. Between the record changing and step 3, anyone whose resolver already has the new address gets a certificate error, so step 3 follows step 1 at once. (Adding the name to Caddy first does not help: the certificate authority checks the name against this server, and before the record changes it finds the current host.) Each `up -d` interrupts the server's other public names for a few seconds. Once the first name works, the rest can be done a few at a time, one `up -d` for each batch. Your own machine can keep an old answer for some minutes after the change: try from elsewhere, or with `curl --resolve`, before deciding a name does not work.

Inngest calls the app at the address in `INNGEST_SDK_URL` (`inngest/.env`), today `https://dial8.ai/api/inngest`. From the moment that name answers from here, its calls come to this server's worker: they are the same functions with the same keys, so a call that still reaches the current host during the change works there too. The sync loop on this server makes the app register again within a minute; the answer is `modified: false` as long as that address's origin is `NEXT_PUBLIC_APP_URL`, which the app gives Inngest as its own (`INNGEST_SERVE_ORIGIN`). If the two differ, the app registers its own address instead, which also works, since both names reach a live copy.

**5. Check.** Every one at once; a doubt is a reason for step 22.

| Check | What it must show |
| --- | --- |
| The web app on both names, where you were signed in | Still signed in. The session cookie keeps its name, and the database did not move. |
| The desktop app | Loads, and is still signed in (it loads the same names). |
| Sign out, sign in with Google | A full round trip, back on the name you started from. |
| A chat message, and one that makes the agent search the web | Replies stream; a helper's result comes back into the chat. |
| The Inngest dashboard (step 10) | The app with its functions and no error, and runs finishing. |
| `sudo docker compose logs --tail 50 cron` in `app/` | Jobs called, each with a `2xx`. |
| `sudo docker compose ps` in `app/` | Every container `healthy`. |
| A connected Gmail or Outlook account | New mail still arrives (the push webhooks reach this server). |
| A Slack message to the bot | Answered, by this server: the reply arriving in Slack is the check, not only the `/api/slack/events` request in web's log. The current host's log has nothing for it. |
| The current host's logs, a few minutes later | No requests but from resolvers that have not caught up. |

**Stored agent sessions.** Every conversation stores the id of its agent session, and before the switch those sessions were made by the agents on the current host. The server's agents do not have them. The in-app chat makes a fresh session by itself when an agent refuses one. Turns the server starts (a Slack message to the bot, a text, a background update) were refused at first: on the night the Slack row above found it, a request arrived and no reply came. The app has since learned the same as the chat (`web/src/lib/chat/home-turn-server.ts`: when the agent refuses an unknown session, the turn moves once to a fresh one). On the night the stored ids were cleared once, after a backup; with that change in place no manual step is needed, and the Slack row is the test for it.

**6. Afterwards.** Take the test name out: from `APP_HOSTS` (check and `up -d` as in step 4), from `ADDITIONAL_REDIRECT_URLS` in `supabase/stack/.env` (then `sudo sh run.sh recreate auth` there), and its DNS record. Otherwise a second production address stays open. Leave the current host's deployment running, with its cron jobs off, for a week: it is the undo. If builds there cost money, disconnect the repository from its project: its last deployment keeps running and stays the undo, frozen at that code, and a merge to `main` then builds nothing anywhere. Add `:compose.app.yaml` to `COMPOSE_FILE` in `backup/.env` and `sudo docker compose up -d --build` in `backup/` to back the agents up. Then retire it: remove the names from that project (they already point here), except the production domain Slack's connector forwards to (step 21, Gate 1), and keep the team only for the cloud browser's sandboxes, the AI Gateway and Slack's connector, which stay there.

**Later, each on its own: the app's address, then the forward.** This step keeps `NEXT_PUBLIC_APP_URL=https://dial8.ai`. Moving it to `https://nativeintelligence.dev` is a build here (step 1's pull with that value, then `sudo ./deploy.sh`) and the list in the pull request that made the address one setting ("When the setting moves"). Only after that, and after a sign-in on the new domain has been tried, can `NI_FORWARD_OLD_DOMAIN=307` in `app/.env` and `sudo ./deploy.sh --no-build` send people who open a `dial8.ai` page to the new domain (`web/src/lib/old-domain-forward.ts` has what it never touches; it does nothing while the address is still on `dial8.ai`). Emptying the value and the same command turn it off.

## 22. The undo

The names go back, in the reverse order of step 21.4, and the scheduled jobs with them.

1. **The DNS records back** to the values written down in Gate 2. List the records at the DNS host first: a changed record has a new id there. The current host still has every name attached, and its deployment has production's settings.
2. **The scheduled jobs.** Wait one TTL (a minute) for resolvers to catch up. Then in `app/.env`, `NI_LIVE=` (empty), and `sudo ./deploy.sh --no-build`: the copy here stops calling them, and can no longer register with Inngest. Then enable the current host's cron jobs again (the API call of step 21.2 with `true`). (Until then, a call from Inngest that still reaches this server's worker is served correctly: it is signed with the same key.)
3. **Inngest** follows the name `dial8.ai` back by itself: the sync loop asks that address every minute and the app there registers the same address.
4. **The edge.** Take the names out of `APP_HOSTS` (check and `up -d` as in step 21.4); otherwise Caddy keeps trying to renew certificates for names that no longer point at it.

Nothing is lost by going back: the database is the same for both copies. What a person did on the server's copy stays done. Agent conversations started on this server stay in its agents' volumes and do not exist on the current host: the app starts a new one there, as it does after any change of agents.

## 23. Calls: LiveKit

Audio and video calls run on [LiveKit](https://docs.livekit.io/home/self-hosting/), a media server, on this server: [`livekit/`](livekit). This step brings it up and proves it from outside. Nothing in the app uses it yet; the calls feature itself comes later and only needs the three settings this step writes. Doing this step changes nothing people use today, except a few seconds' interruption of the other public names when Caddy restarts (part 6).

**Merging it, and the automatic deploys.** Merging the change that brought this step starts nothing: LiveKit runs only once part 5 is done by hand. The app needs no new build for it either; its four settings take effect when its containers next start. The automatic deploys ([`app/README.md`](app/README.md#automatic-deploys)) are off today. If they are on when such a change arrives, they hold it, and a person does this, in this order:

1. The new lines in `app/.env.example` (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_EGRESS`) hold it until `app/.env` has them: copy them in, empty, as part 3 says. The next run sees them.
2. The files of other stacks (`edge/`, `livekit/`) and of the deploy tooling (`app/check_settings.py`) hold it until someone has read them: read the change, then `sudo ./auto-deploy.sh acknowledge <commit>` in `app/`, with the commit the hold names. The edge change is safe to have in the checkout before part 6: with `LIVEKIT_HOST` unset and `compose.livekit.yaml` not in `COMPOSE_FILE`, the new LiveKit site serves a name no request carries, so a reboot that restarts Caddy on the new `Caddyfile` changes nothing.
3. The next run then moves the checkout and rolls the app out as usual.
4. Parts 1 to 8 below are by hand, as always: no automatic deploy brings LiveKit up, restarts Caddy or runs `make-keys.sh`.

A later change to `livekit/` holds the automatic deploys in the same way (read it, `acknowledge`); it takes effect at the next `sudo docker compose up -d` in `livekit/`, which a person runs.

**How a call reaches the server.** Two kinds of traffic, on different doors:

| What | Where | Port |
| --- | --- | --- |
| Signalling: joining, who is in the room, the app's calls to LiveKit's API | Through Caddy, over TLS, on its own name (`livekit.nativeintelligence.dev`) | TCP 443 (LiveKit's own 7880 is not published) |
| LiveKit's webhooks to the app | Out to the app's public name, and back in through Caddy like any other caller's request | TCP 443 |
| The media itself, over UDP: the normal path | Straight to LiveKit, every call on one port | UDP 7882 |
| The same media over TCP, when the network blocks UDP | Straight to LiveKit | TCP 7881 |

The media cannot go through Caddy: it is not HTTP. It is encrypted between each browser and LiveKit (DTLS-SRTP), so these two ports carry nothing readable. They are the one exception to "only Caddy publishes ports" (step 5). LiveKit tries UDP first and falls back to TCP by itself.

**What is left out, and who that leaves out.** LiveKit has a TURN server built in, and it stays off:

- TURN over UDP (3478) adds almost nothing here: a network that lets UDP out to 3478 nearly always lets it out to 7882 too, and this server has a public address of its own, so there is no NAT on its side to get around.
- TURN over TLS would have to be on port 443 to help the networks it is for, and 443 on this server's one address is Caddy's. LiveKit can share it only behind something that routes by name before TLS ends (below).

So, with UDP 7882 and TCP 7881:

- **Can call:** any network that lets UDP out (homes, mobile data, most offices), and any network that blocks UDP but lets TCP out to ports other than 80 and 443.
- **Cannot call:** networks that let out only TCP 80 and 443 (strict company firewalls, some hotel, airport, school and guest Wi-Fi), and networks that send everything through a company's web proxy. People on them get as far as joining (that is HTTPS on 443) and then have no sound or picture, and the app sees the connection fail.

Covering them later means TURN over TLS on port 443, by one of: a **second IP address** on the server, with LiveKit's TURN (`turn.enabled`, `tls_port: 443`) on that address and Caddy on the first, and a DNS name for it; or **layer-4 routing** in front of Caddy on the one address (a TLS router such as Caddy built with its layer-4 module, or HAProxy, sending one name, say `turn.nativeintelligence.dev`, to LiveKit's TURN with `external_tls` and the PROXY protocol, and everything else to Caddy as today); or a TURN service bought from someone else, named in LiveKit's `rtc.turn_servers`. Each is a change to this step, not to the app.

**Its own networks, not `ni-edge`.** LiveKit faces the internet directly on its media ports, so it is kept away from the other stacks' doors. It is on two networks: `ni-livekit`, with its Redis and no route out, and `ni-livekit-edge`, shared with Caddy and nothing else, the way the Supabase gateway has `ni-supabase-edge` (step 7). It is not on `ni-edge`, where it could reach Inngest's dashboard (no login) and the app's own proxy (which trusts the forwarded headers of any private address, because only Caddy is meant to call it). For the same reason its webhooks do not go to the app's proxy by its Docker name: they go to the app's public name and come back in through Caddy, like any other caller's. `ni-livekit-edge` is an ordinary bridge with a way out, which LiveKit needs for that and for the STUN request below.

**Bridge networking, not host.** LiveKit's container is on Docker networks like every other container here, with its two media ports published. With host networking Caddy would have to reach port 7880 on the host (another firewall rule, and the port open on the host for anything else on it), and Redis would have to be on the host too. The cost of the bridge is small at this size: each media packet goes through Docker's address translation in the kernel, and LiveKit cannot see the server's public address from inside, so it asks a public STUN server at startup which address its packets leave from (`use_external_ip`). That answer is the server's address here and after any move. `LIVEKIT_NODE_IP` in `livekit/.env` sets it by hand if it is ever wrong. If calls ever grow to hundreds of people at once, measure the CPU and revisit host networking then.

**One UDP port, for now.** All media shares UDP 7882. LiveKit recommends a range of at least as many ports as the machine has vCPUs once it is busy, so that the work spreads over several sockets. When calls reach that point (LiveKit's CPU near one core), widen it: in `livekit/compose.yaml`, `udp_port: 7882-7889` (eight ports for eight vCPUs) and the published ports `"7882-7889:7882-7889/udp"`; in the firewall, `sudo ufw allow 7882:7889/udp` (and the same range in `server/setup.sh`); then `sudo docker compose up -d` in `livekit/`.

**What it keeps: nothing.** Rooms exist while people are in them, in LiveKit's memory and in its own Redis (no snapshots, no volume). Restarting LiveKit ends the calls in progress; the people in them join again. There is nothing to back up, and a move ([`move/`](move)) carries only the folder and its `.env`. The `.env` holds the key pair: it goes in the password manager like the others. Memory is capped at 4 GB for LiveKit and 1 GB for its Redis, far more than either uses, so that a fault cannot take memory from the database and the app.

**1. The DNS record.** One `A` record, added by the owner of the domain:

| Name | Type | Value |
| --- | --- | --- |
| `livekit.nativeintelligence.dev` | A | `<server>` |

```bash
dig +short livekit.nativeintelligence.dev
```

It must print `<server>` before part 6, or Caddy cannot get the name's certificate.

**2. The firewall.** On a server set up before this step. (Running [`server/setup.sh`](server/setup.sh) again does the same: it now has these two lines.)

```bash
sudo ufw allow 7882/udp comment 'LiveKit media (WebRTC over UDP)'
```

```bash
sudo ufw allow 7881/tcp comment 'LiveKit media (ICE over TCP)'
```

```bash
sudo ufw status
```

As step 5 says, Docker opens a published port whatever ufw says, so these two lines do not open anything by themselves: they make the firewall's own list match what is open. To close the media ports, stop LiveKit (the undo, below).

Every part from here to 8 can be run again as it is written: nothing in it replaces what an earlier run made.

**3. The files.** In the server's checkout, as its owner (not root):

```bash
cd /opt/native-intelligence && git pull
```

The settings file, made only if it is not there yet: `install` alone would replace a filled-in one, and with it the key pair.

```bash
cd /opt/native-intelligence/deploy/livekit
```

```bash
[ -e .env ] || sudo install -m 600 -o root -g root .env.example .env
```

The app's settings file needs four new lines before the keys are made, so that they are written there in the same go. This counts the ones it has; `4` means they are there already:

```bash
sudo grep -c '^LIVEKIT_' /opt/native-intelligence/deploy/app/.env
```

If it prints less, copy the four `LIVEKIT_` lines it lacks (with their comments) from [`app/.env.example`](app/.env.example) into it, empty:

```bash
sudo nano /opt/native-intelligence/deploy/app/.env
```

The network LiveKit shares with Caddy. [`server/setup.sh`](server/setup.sh) makes it on a new server; on this one, once (it prints nothing when it is already there):

```bash
sudo docker network inspect ni-livekit-edge >/dev/null 2>&1 || sudo docker network create ni-livekit-edge
```

**4. The keys.** Made on the server, written into `livekit/.env` and the same pair into `app/.env`, with `LIVEKIT_URL=wss://livekit.nativeintelligence.dev`. Neither is shown or typed. Running it again keeps the pair (`--new` makes another, and ends every call and token made with the old one).

```bash
sudo ./make-keys.sh
```

It also fills in `LIVEKIT_WEBHOOK_URL` in `livekit/.env` while that is empty: the app's public address (`NEXT_PUBLIC_APP_URL` in `app/.env`) and the route the calls feature will add, `/api/calls/livekit/webhook`. It says which address it wrote. Until the app has that route, a webhook gets a `404` and is dropped; nothing else happens. When the app's address moves, change this line too, and `sudo docker compose up -d`.

LiveKit reads `.env` only when its container is made. Whenever the keys or another value in it change, `sudo docker compose up -d` here recreates it with them (ending the calls in progress); when nothing changed, the same command does nothing. Part 5 is that command the first time.

`docker compose config` in this folder prints LiveKit's whole configuration, the secret included (it is in the `LIVEKIT_CONFIG` variable). To look at it, hide the secret on the way:

```bash
sudo docker compose config | sed -E 's/[A-Za-z0-9]{32,}/<hidden>/g'
```

**5. Start it.**

```bash
sudo docker compose up -d
```

```bash
sudo docker compose ps
```

After about half a minute both (`ni-livekit`, `ni-livekit-redis`) must say `healthy`. Then the address LiveKit tells browsers to send media to; this must print the server's public address:

```bash
sudo docker compose logs livekit | grep -m1 -o '"nodeIP": "[^"]*"'
```

If it prints another address, put the right one in `LIVEKIT_NODE_IP` in `.env` and `sudo docker compose up -d` again. And what is published: this must print Caddy's two ports and LiveKit's two, nothing else.

```bash
sudo docker ps --format '{{.Names}}  {{.Ports}}' | grep -E '0\.0\.0\.0|\[::\]'
```

**6. The name in Caddy.** In `/opt/native-intelligence/deploy/edge/.env`, two things (a file made from an older `.env.example` has no `LIVEKIT_HOST` line: add it). Caddy joins the network it shares with LiveKit: add `compose.livekit.yaml` at the end of the `COMPOSE_FILE` line, which on this server already names the Supabase file. And the name:

```text
COMPOSE_FILE=compose.yaml:compose.supabase.yaml:compose.livekit.yaml
LIVEKIT_HOST=livekit.nativeintelligence.dev
```

Caddy needs the network `ni-livekit-edge` (part 3) to start with that file named, and does not need LiveKit to be running: the name only answers `502` while LiveKit is down.

Check, then restart Caddy. As in step 20.4, the restart interrupts the other public names for a few seconds and makes every live connection reconnect: pick a quiet moment. Later on, a `caddy reload` (step 9) leaves calls alone: the LiveKit site keeps the WebSockets open at a reload for up to 4 hours (`stream_close_delay`). An `up -d` that replaces Caddy's container, like this one, still closes them; each browser reconnects its signalling within seconds, and the media, which does not pass through Caddy, keeps flowing meanwhile.

```bash
cd /opt/native-intelligence/deploy/edge && sudo docker compose run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile
```

```bash
sudo docker compose up -d
```

From your own machine, LiveKit's health over the new name must print `OK`:

```bash
curl -s https://livekit.nativeintelligence.dev/
```

**7. The app's settings.** They are in `app/.env` from part 4. Nothing in the app reads them yet, so no restart is needed now; they take effect the next time its containers start. From your own machine, the settings check proves them together with everything above:

```bash
deploy/app/check-settings.sh <user>@<server>
```

Under "May stay empty" it must say `LIVEKIT_URL  ok  LiveKit accepts a token made with the key and secret`. That is a token made as the app's server makes one, sent to LiveKit's API through the public name: the DNS record, the certificate, Caddy, LiveKit and the key pair, in one request. `WRONG ... refused` is a pair that is not LiveKit's (run `sudo ./make-keys.sh` again, then `sudo docker compose up -d` in `livekit/`); `cannot tell` is the name or Caddy not answering yet.

**8. A real call, from outside.** LiveKit makes no room for a token (`room.auto_create` is off: the app makes each call's room through the server API before it hands out tokens, so a token alone cannot open one), and a token for a room that does not exist is refused with "requested room does not exist". So `test-token.sh` makes the room `check` first, through LiveKit's API at the public name, the same way the app does, and then prints a token for it. On the server, a token for each of two test participants. Each is good for 15 minutes and for that room only, and is printed so that it can be pasted; the key pair stays on the server. The room stays 15 minutes while it is empty and 5 minutes after the last person leaves; after that, running the script again makes it again.

```bash
cd /opt/native-intelligence/deploy/livekit && sudo ./test-token.sh laptop
```

```bash
sudo ./test-token.sh phone
```

- **The whole path.** On your own machine, open LiveKit's connection test, <https://livekit.com/connection-test> (a page that runs in your browser; it is given the address and a token, never the secret), with `wss://livekit.nativeintelligence.dev` and the first token. It connects, publishes, and tries UDP and TCP one after the other ("Connection via UDP vs TCP"): both must pass. It asks for the camera and microphone, as a call would.
- **Two people, sound both ways.** In <https://meet.livekit.io>, on its "Custom" tab, the same address with the first token on the laptop, and with the second on a phone (on mobile data, so that it comes in from outside). Each must hear and see the other.
- **UDP, on its own.** In Chrome on the laptop, during that call, open `chrome://webrtc-internals`: the selected candidate pair must be `udp`, to `<server>` port `7882`.
- **TCP, on its own.** A second Chrome that may not use UDP for WebRTC at all (the policy Chrome applies when told that UDP may not leave without a proxy, and there is none), with a profile of its own so that your usual Chrome is not touched:

  ```bash
  open -na "Google Chrome" --args --user-data-dir="$HOME/.lk-tcp-test" --force-webrtc-ip-handling-policy=disable_non_proxied_udp https://meet.livekit.io
  ```

  Join with a third token (`sudo ./test-token.sh tcp`): sound and picture must work, and `chrome://webrtc-internals` in that window must show the pair as `tcp`, to port `7881`. Close that window and delete `~/.lk-tcp-test` afterwards.
- **Webhooks.** `sudo docker compose logs --tail 50 livekit | grep 'sent webhook'` in `livekit/` lists each one LiveKit sent during the call, with its event and the address. LiveKit does not log the answer, so check separately that the address answers from LiveKit's own container, out and back in through Caddy. Put in the address `make-keys.sh` wrote (`LIVEKIT_WEBHOOK_URL`); this prints the first answer's status line only, so a redirect shows as itself and is not followed:

  ```bash
  sudo docker compose exec livekit wget -S -O /dev/null --post-data '{}' https://<the app's public name>/api/calls/livekit/webhook 2>&1 | grep -m1 'HTTP/'
  ```

  Before the calls feature adds its route, `HTTP/1.1 404 Not Found` is the right answer: the request left LiveKit, came in through Caddy and was answered by the app, which has no such page yet. Once the route exists, this unsigned request should be refused by it instead (another `4xx` than `404`). A `301`, `307` or `308` means the address is not the app's own: put the address it points to in `LIVEKIT_WEBHOOK_URL` and `sudo docker compose up -d`. Nothing printed, or `bad address` or a timeout, means the request never got there: look at DNS and at `ni-livekit-edge`'s way out.

**The undo.** Stop it, which also closes the two media ports (Docker removes what it published):

```bash
cd /opt/native-intelligence/deploy/livekit && sudo docker compose down
```

Then take `LIVEKIT_HOST` and `:compose.livekit.yaml` out of `edge/.env` (check and `up -d` as in part 6), and, if they should not stay, the network (`sudo docker network rm ni-livekit-edge`, once Caddy has left it), the two ufw rules (`sudo ufw delete allow 7882/udp`, `sudo ufw delete allow 7881/tcp`) and the DNS record. The three settings in `app/.env` may stay; with LiveKit gone, the settings check says `cannot tell` for them. There is no data to lose or bring back.

### Egress: recordings and call notes (off until asked for)

[LiveKit Egress](https://github.com/livekit/egress) records a call into a file: one participant's sound (a "track" recording, `.ogg`), which is what call notes use, or the whole room with video (a "room composite", `.mp4`), which runs a Chrome and a video encoder and is by far the heaviest thing in this stack. It is in `livekit/compose.yaml` behind a Compose profile, so plain `sudo docker compose up -d` does not start it. Turn it on only when call notes are being rolled out.

**How it fits.** Egress takes its jobs from LiveKit through LiveKit's own Redis, and joins the room it records like a participant, over the private network `ni-livekit` (`ws://livekit:7880`). It publishes no port. Its files go to Storage on this server's Supabase stack, through Storage's S3 protocol at the public name (`https://sb.nativeintelligence.dev/storage/v1/s3`), in through Caddy like any other caller's request, into a private bucket, `team-call-recordings`. That is why Egress is also on `ni-livekit-edge`, the stack's way out: the other road to Storage would be a network shared with the Supabase gateway, which answers there with Studio and its SQL endpoint as well (step 7), and Egress runs a browser. Storage checks the signature of each S3 request against the host name in `SUPABASE_PUBLIC_URL` whatever `Host` arrives (Storage's `signature-v4.ts`), so Caddy rewriting `Host` on the way to the gateway does not matter. The app gives Egress only a file path; the storage settings are Egress's own, and the app reads, signs and deletes the files through Storage with its service key, as it does with every other file.

**What that costs in trust.** Supabase Storage has one S3 key pair, and it reads and writes every bucket. Egress holds it, so `livekit/.env` is as secret as `supabase/stack/.env`. Chrome runs inside Egress without its own sandbox (Egress's default, `--no-sandbox`): Docker's default seccomp profile and capabilities still apply, and Egress gets no extra capability. Room composites are therefore off for every call until part E5 says they may be on, and track recordings, which need no Chrome, are the main use.

**What it may use.** At most 4 CPUs and 4 GB (`deploy.resources.limits`). Egress reads that CPU quota from its cgroup and refuses a job that would take it over 80 % of it: with the costs in `compose.yaml` that is one room composite at a time and nothing beside it, or about six track recordings at once. No recording runs longer than 4 hours.

Recordings are files in Storage like any other, so the nightly file backup (step 17) takes them too.

**E1. The bucket, and Storage's upload limit.** The bucket `team-call-recordings` comes with the call notes feature, as the database migration `web/supabase/migrations/566_team_call_notes.sql`: private, a 2 GB limit per file, the types `audio/ogg`, `audio/opus`, `video/mp4`, `audio/mp4` and `application/octet-stream`, and who may read what. Apply it as every migration is applied ("Day to day", on the owner's word), before Egress is turned on. Do not make the bucket by hand: the migration sets all of that, and running it after a hand-made bucket only overwrites it.

That 2 GB does not apply as it stands. Storage takes the smaller of a bucket's own limit and its global one, and the global one is `FILE_SIZE_LIMIT`, fixed at 50 MB in Supabase's own compose file (`supabase/stack/docker-compose.yml`, never edited here; Storage's `limits.ts`, `getFileSizeLimit`, and its S3 upload path refuse anything larger with `EntityTooLarge`). Estimated from usual bit rates (speech in Opus about 32 kbit/s, a 720p composite about 2 Mbit/s), not measured: one microphone's notes stay under 50 MB for about three hours, but a room composite passes 50 MB after three or four minutes. So before room composites (E5), the global limit has to go up, in `supabase/compose.override.yaml`, under `storage:` → `environment:`:

```yaml
      FILE_SIZE_LIMIT: 2147483648
```

then `cd /opt/native-intelligence/deploy/supabase/stack && sudo sh run.sh recreate storage` (Storage restarts in a few seconds). That is a decision of its own: every bucket without a limit of its own then takes files of up to 2 GB, so give the app's other buckets their own limits first if they should keep 50 MB. It is not in this change.

**E2. The storage settings.** `make-keys.sh` copies them, unseen, from `supabase/stack/.env` into the four empty `LIVEKIT_EGRESS_S3_` lines of `livekit/.env` (a `.env` made before Egress existed has no such lines: copy them, empty, from `livekit/.env.example` first, with `sudo nano .env`). Then check that all four are filled in, by length only:

```bash
cd /opt/native-intelligence/deploy/livekit && sudo ./make-keys.sh
```

```bash
sudo awk -F= '/^LIVEKIT_EGRESS_/ { print $1, length(substr($0, length($1) + 2)) }' .env
```

Each must print a number above 0 (the bucket's name is 20 characters).

**E3. Turn it on.** In `livekit/.env`, uncomment `COMPOSE_PROFILES=egress`, then:

```bash
sudo docker compose up -d
```

```bash
sudo docker compose ps
```

`ni-livekit-egress` must say `healthy` within a minute. LiveKit itself is not restarted by this, unless its settings changed too. Its log should say it connected to Redis and is waiting for requests: `sudo docker compose logs --tail 30 egress`.

**E4. One audio-only recording.** Make the room and join it from your own machine with the microphone on, as in part 8 (`sudo ./test-token.sh laptop`, then LiveKit Meet). Then, on the server:

```bash
sudo ./test-egress.sh track
```

It finds the first participant who publishes sound, records it for 20 seconds as `checks/check-<identity>-<time>.ogg`, stops, and waits for Egress to say where the file went. It must end with `Status: EGRESS_COMPLETE` and a `File:` line with a size of some kilobytes. In Studio (step 15), the bucket `team-call-recordings` must have that file under `checks/`, and it must play. `503 ... no response from servers` means no Egress took the job (E3); `EGRESS_FAILED` with an upload error points at E2. Delete the file afterwards.

**E5. Before room composites for every call: measure one.** With two people in the room, with cameras on:

```bash
sudo ./test-egress.sh composite check 120
```

and while it runs, in a second terminal:

```bash
sudo docker stats ni-livekit-egress
```

Write down the CPU column (100 % is one core) and the memory over the two minutes, and look at `top` for the whole machine meanwhile. Expect two to three cores for a 720p composite. The cap of 4 CPUs holds whatever it shows; the question is whether the machine can spare that while the database and the app are busy. Only then may the app record whole rooms for every call (the app's own switch for that, `TEAM_CALL_RECORDING`, which comes with the feature). Whatever the measurement shows, Egress takes one composite at a time and refuses the next while it runs (the costs in `compose.yaml`), so the cap protects the machine; the measurement decides whether one at a time is worth its share.

**E6. The app.** `LIVEKIT_EGRESS=on` in `app/.env` (its line comes from `app/.env.example`), then `sudo ./deploy.sh --no-build` in `app/`. The app then offers call notes. Egress's own events (`egress_started`, `egress_ended`) reach the app through LiveKit's webhooks, at the same address as the others.

**The undo.** Set `LIVEKIT_EGRESS=` (empty) in `app/.env` and `sudo ./deploy.sh --no-build` there, so that the app stops asking. Then comment `COMPOSE_PROFILES=egress` again in `livekit/.env`, so that the next `up -d` leaves it out, and stop it. `--profile egress` is what reaches it now that the profile is off in `.env`; LiveKit is not touched:

```bash
sudo docker compose --profile egress rm -sf egress
```

Egress finishes what it is recording first (up to two minutes). Recordings already made stay in the bucket. To remove the storage key from this stack as well, empty the four `LIVEKIT_EGRESS_S3_` lines.

### The call recorder: call notes as people speak (off until asked for)

The call recorder ([`../recorder`](../recorder)) takes a call's notes instead of Egress: one process joins each of our calls whose notes are on as a hidden participant that publishes nothing, subscribes to microphones and nothing else (no camera, no screen share), sends each to Deepgram's streaming API as it is spoken, and delivers the words to the app, where the call's one capture fills in live; when the call ends the app locks it and runs the end-of-meeting pass on it, as on any recorded meeting. One track is one known person, so every line is said by whom it says. It is the service `recorder` in `livekit/compose.yaml`, behind a Compose profile like Egress, so plain `sudo docker compose up -d` does not start it. Recordings of a whole call stay Egress's.

**How it fits.** Nothing calls the recorder, and it publishes no port: it asks the app for its work every few seconds (`/api/internal/team-call-recorder/work`: the live calls with notes on that nobody is hearing, each with a LiveKit token for that room alone, hidden, subscribe only), so it holds no LiveKit key, and a recorder that restarts finds its calls again by itself. It joins rooms over `ni-livekit` (`ws://livekit:7880`), and reaches the app at its public name and Deepgram through `ni-livekit-edge`, the stack's way out, as Egress does: the app's requests come in through Caddy like LiveKit's webhooks. Every request carries `CAPTURE_FEED_SECRET`, a secret of its own (the app turns the routes off when it equals any other internal secret). Every few seconds it also says which calls it is hearing (the heartbeat): that is how the app knows it is alive (a feed quiet for 90 s is marked lost at the sweeper's next run, every 5 minutes, and the notes say what they missed), and the answer tells it to stop when notes go off, the call ends, the 3 hours are spent, its capture was ended by hand, or the app's switch is off (`feed_off`). Each time it leaves a call it delivers its last words, then says so (`end`): the notes' finish waits for that, two minutes at most, before it locks the capture. On SIGTERM it delivers every call's last words and leaves without ending anything, so the next process (the same name, `recorder`) takes the calls up at once. The room closes as it does without it: LiveKit does not count a hidden participant, and it leaves a room nobody else has been in for 30 s.

**Who it hears, and from when.** Every member's microphone, from the moment the recorder is in the room (a few seconds after notes go on): a member who joins a call whose notes someone else turned on holds their microphone until they have seen the notice (web, desktop and iPhone apps), so nothing of theirs is published, and so nothing reaches the recorder or Deepgram, before that; a member already in the call when the notes go on is heard from then on, with the "Notes are on" badge in front of them, as with Egress's notes. A meeting link's guest is heard only once the app says they said go to this round's notes (the answer to its start, then every heartbeat, every 5 s): until then their microphone is not even subscribed to, and no Deepgram socket is opened for them.

**Out of the room.** Whenever a feed ends or goes quiet (notes off, the call over, its capture ended by hand, marked lost), the database puts the recorder's LiveKit identity (`notes-recorder-<RECORDER_ID>`) on the calls' eject outbox, and the app takes it out of the room, whatever the recorder does; the sweeper puts it there again for any live call that no longer wants it.

**One recorder process.** Run one `recorder` service per deployment: its identity in every room is `notes-recorder-<RECORDER_ID>`, so two processes with the same `RECORDER_ID` would push each other out of a room. A second one, for more calls, needs an id of its own, and that has not been tried.

**What it may use.** At most 2 CPUs and 1 GB. Each call costs a WebRTC subscription and one Deepgram socket per microphone; `RECORDER_MAX_CALLS` (default 10) caps how many calls it hears at once. Deepgram bills the recorder's audio as it bills the browser's live transcription: every unmuted minute of every person heard in a call with notes on (nothing is sent while someone is muted, or for a guest who has not said go). Its words reach the app every 4 s or so, in one request per call: one write to the capture each time, whose row holds the whole transcript (about 160 KB of text after three hours of steady talk, under Realtime's default 1 MB per record; the server's Realtime setting was not checked).

**R1. The database.** Migrations `web/supabase/migrations/587_capture_feed.sql` and `588_capture_feed_functions.sql`, in that order, as every migration is applied ("Day to day", on the owner's word), before the app that needs them is rolled out. Each says `notify pgrst, 'reload schema';` itself. To tell whether they are applied: `select to_regclass('public.capture_feed_session')` is not null after 587, and `select count(*) from pg_proc where proname = 'capture_feed_append'` is 1 after 588.

**R2. The settings.** In `livekit/.env`, the recorder's lines come from `livekit/.env.example` (a `.env` made before the recorder existed has none: copy the block "The call recorder", empty, with `sudo nano .env`); in `app/.env`, the two lines `TEAM_CALL_RECORDER` and `CAPTURE_FEED_SECRET` from `app/.env.example`, empty. Then `make-keys.sh` fills in what it can, never shown: `RECORDER_APP_URL` from `NEXT_PUBLIC_APP_URL`, a new `CAPTURE_FEED_SECRET` into both files (or the app's copied, if only it has one), and `RECORDER_DEEPGRAM_API_KEY` from the app's `DEEPGRAM_API_KEY`. Check them by length only:

```bash
cd /opt/native-intelligence/deploy/livekit && sudo ./make-keys.sh
```

```bash
sudo awk -F= '/^(RECORDER_|CAPTURE_FEED_)/ { print $1, length(substr($0, length($1) + 2)) }' .env
```

`RECORDER_APP_URL`, `CAPTURE_FEED_SECRET` (48) and `RECORDER_DEEPGRAM_API_KEY` must each print a number above 0 (`RECORDER_MAX_CALLS` may stay empty).

**R3. Build it and start it.** In `livekit/.env`, uncomment `COMPOSE_PROFILES=recorder` (with Egress on as well: `COMPOSE_PROFILES=egress,recorder`), then build it on the server and start it; LiveKit itself is not restarted by this unless its own settings changed:

```bash
sudo docker compose up -d --build recorder
```

```bash
sudo docker compose ps
```

`ni-livekit-recorder` must say `healthy` within a minute. Its log says `[recorder] started as recorder`, then, until the app's switch is on (R4), `work not read (404): the recorder is off in the app`, every 30 s or so: that is right.

```bash
sudo docker compose logs --tail 30 recorder
```

**R4. The app.** `TEAM_CALL_RECORDER=on` in `app/.env`, then the app rolled out (`sudo ./deploy.sh` in `app/` when the code that has the recorder's routes is not live yet; `--no-build` when it is). The recorder's log then stops saying 404. The settings check reads the two lines and says `WRONG` for a value that cannot work (the switch on without LiveKit or the secret; a secret shorter than 32 characters, or equal to another internal secret's):

```bash
deploy/app/check-settings.sh <user>@<server>
```

**R5. A real call, from outside.** Two people in a channel's call, on two machines; one turns the notes on. Within a few seconds the recorder's log says `call=<id> … joined` and `track=… hearing` once per microphone; the call's message and panel say "Notes on" and open the capture, whose transcript fills in as each person speaks, under their name. Then: mute one person and speak (nothing of theirs appears); turn the notes off (the log says `stop: notes_off`, and nothing said after appears); turn them on again, and hang up. Within a minute or so of the call's end the capture is ended, its transcript in the order things were said, its summary and actions written as any meeting's. A meeting link's guest is in the notes only once they have said go to the notice. A call where nobody spoke leaves no capture.

**What only this server can prove** (none of it could be run off it): the image building and starting on the server (its native library on linux/amd64), its health check, its media path to LiveKit from inside Docker (as for Egress, LiveKit offers its address on `ni-livekit` and its public one), its way out to the app's public name and to Deepgram through `ni-livekit-edge`, the app's routes behind Caddy, real people's microphones from a browser, the desktop app and the iPhone app, Deepgram's latency and accuracy on real calls, and its CPU and memory with several calls at once (`sudo docker stats ni-livekit-recorder`).

**The undo.** `TEAM_CALL_RECORDER=` (empty) in `app/.env` and `sudo ./deploy.sh --no-build` in `app/`: the app stops handing out work, its heartbeat answer tells the running recorder to stop every call it is in (`feed_off`: it delivers what it holds and leaves the rooms within seconds), and the next notes are Egress's (if `LIVEKIT_EGRESS` is on) or there are none. Then comment `COMPOSE_PROFILES` again in `livekit/.env` (or take `recorder` out of it) and stop it; LiveKit is not touched:

```bash
sudo docker compose --profile recorder rm -sf recorder
```

It delivers what it still holds first (up to 40 s). Captures it filled in stay; a call that was live then is finished by the app as usual, with what was said until then.

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
| Upgrade LiveKit | Read the [release notes](https://github.com/livekit/livekit/releases), change the image tag in `livekit/compose.yaml`, then `sudo docker compose pull livekit && sudo docker compose up -d livekit` in `livekit/`. Calls in progress end; people join again. Egress the same way ([its notes](https://github.com/livekit/egress/releases), service `egress`); it finishes its recordings first. |
| Take a change to the call recorder (`recorder/`) | After `git pull`: `sudo docker compose up -d --build recorder` in `livekit/` (with its profile on in `.env`). The old process delivers its calls' last words and leaves; the new one takes the calls up within seconds (what was said in between is not in the notes). |
| Ship the app | In `app/`: `git pull` in the checkout as its owner, then `sudo ./deploy.sh` ([`app/README.md`](app/README.md#deploysh)) |
| Go back to the app's previous image | `sudo ./deploy.sh --rollback` in `app/` |
| Automatic deploys of `main` (off unless switched on) | `sudo ./auto-deploy.sh status` in `app/` says what serves and what holds them; `on`, `off` and the rest in [`app/README.md`](app/README.md#automatic-deploys). While they deploy, `deploy.sh` by hand stops at once (one deploy at a time). |
| Apply a database migration | After `git pull` has brought the file: `sudo docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 --single-transaction < /opt/native-intelligence/web/supabase/migrations/<file>`, before the code that needs it is rolled out. This is the command production's migrations have been applied with since the move, with `--single-transaction` added so that a failing file changes nothing; a migration that cannot run inside a transaction (one that says `CONCURRENTLY`; none in `web/supabase/migrations` does today) is applied without it. Then, as the second step, make the data API read the new tables and functions: `echo "notify pgrst, 'reload schema';" \| sudo docker exec -i supabase-db psql -U postgres -d postgres`. Skip it only when the file itself contains that line; most do not. Nothing records which migrations have been applied: to tell, look in the database for what the file creates (a function, a table, a policy). With the automatic deploys on, a migration holds them: apply it this way, or from the commit without pulling ([`app/README.md`](app/README.md#automatic-deploys)), then `sudo ./auto-deploy.sh acknowledge <commit>` in `app/`. |

Stopping and starting is safe: Redis writes every change to disk within a second and Postgres is Postgres. `sudo docker compose down` keeps the volumes. **`down -v` deletes them.** In `supabase/stack` that is the app's whole database and every stored file: never run it there.

Three things that catch people out:

- **ssh is rate-limited.** The firewall's `limit` rule (step 5) refuses a new ssh connection after about six in 30 seconds. A script that opens several in a row can then fail with exit code 255; wait a minute and run it again.
- **`git pull` says "Permission denied"** when files in the checkout are owned by root: something was copied in, or run, as root. Find them with `sudo find . ! -user <owner>` in `/opt/native-intelligence`, give them back (`sudo chown <owner>:<owner> <file>`), and never run git as root.
- **No tool adds a line to an existing `.env`.** They only change values of lines that exist, and `set-secret.sh` refuses a name the file has no line for. A new setting's line is copied from that folder's `.env.example` by hand (`sudo nano .env`), then filled in.

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

### Steps 20 to 22: the app

Tested on the real server, 2026-11-10, with production's settings and on production's database, in rehearsal mode (`NI_LIVE` empty), the app's names still on its current host:

- The image built on the server from the checkout in 6 to 7 minutes (4.9 GB). All twelve containers healthy. Idle they used about 1.6 GB of memory together (each agent 105 to 120 MB, web and worker about 330 MB each); everything on the server together used 4.9 GB of 64.
- **Disk:** from 19 to 41 GB used, mostly the image and Docker's build cache (19 GB after two builds; `deploy.sh` now keeps it to 12 GB). A roll-out keeps a second image (`ni-app:previous`), about 5 GB more.
- **Pages and roles** through the stack's proxy, with the test address as the host: `/` and `/login` `200`, `/api/version` gives the commit, an agent's health `200` from that agent's own container, `/api/inngest` from the worker.
- **Redirects.** Before the fix in `web/patches/next+16.1.1.patch`, the sign-in callback, sign-out and admin sign-out sent the browser to `https://0.0.0.0:3000/login`. After it, each goes to `https://<the public name>/login`; a forged `X-Forwarded-Host` carrying a path is ignored.
- **Inngest.** A signed request to the worker, signed inside the container with the server's key, as Inngest signs them: accepted, production mode, 97 functions, events to the self-hosted server, registration pointed at a closed port (rehearsal). An event sent from the copy's web container through the app's own client reached the self-hosted server and started its function, which completed (run by the copy that is registered, the current host's).
- **The scheduler.** Every job fired on its minute and was skipped. One job (`browser-command-reaper`, which only expires commands nobody can still use) was called by hand: `200` in 0.2 s.
- **Roll-out without a gap.** `deploy.sh` replaced all twelve containers in about 45 seconds while web, the worker and a page were asked every 0.2 seconds through the proxy: 402 requests, every one `200`.
- **The app's own calls** to `sb.`, `inngest.` and its own public name leave the container and come back in through the edge (Docker sends a container's request for the server's own address to the published ports). They arrive from one address, `ni-edge`'s gateway.
- **Backups.** The agents' job ran on the server: packed, encrypted, uploaded to B2, read back, retention applied.
- **Over HTTPS at `test.nativeintelligence.dev`** (a DNS record, the name in `APP_HOSTS`, the callback in Auth's redirect list): a Let's Encrypt certificate within seconds; pages `200`, plain HTTP `308` to HTTPS, sign-out and `/account` redirect to the test name's `/login`, an agent's health `200`, and no `X-NI-Upstream` header outside. Restarting Caddy for the new name interrupted `sb.` and `inngest.` for about 6 seconds, restarting Auth for the redirect list about 6 more.
- **Sign-in with Google** on the test name, by a person: Google, `sb.nativeintelligence.dev/auth/v1/callback`, the test name's `/auth/callback`, the code exchange (PKCE, `200`), then the account pages.
- **A chat reply**, by a person: the browser opened a session on the server's chat agent (`202`) and streamed it (`200`); the agent called the app back through the public name (spec, memory, reply, usage, all `200`); the conversation was saved. A conversation started on the earlier host was refused by the server's agent (`409`: the session lives in the other host's store) and the app opened a fresh one, as it should.
- **The AI Gateway key** made for the server works from inside an agent's container.
- **The settings check** (`check-settings.sh`), read-only, against the server's file: every setting in its group, names and lengths only; the Stripe key read three stored customers, the embeddings key reached the app's model, the sender's domain is verified with the mail service. A key that is not production's opens nothing: the earlier host's development copy of `CREDENTIAL_ENCRYPTION_KEY`, tried the same way, opened none of the 33 stored ciphertexts.
- Within minutes of its certificate being issued, the new name was probed for `.env`, `.git` and the like (certificates are public). Every such request was answered `404`.

**Not tested yet, and why:**

- **A helper agent calling back into a chat** (`EVE_CALLBACK_BASE_URL`): the chat that was sent used no helper.
- **Connections** (Gmail, GitHub and the like) on the rehearsal: their stored logins are encrypted with `CREDENTIAL_ENCRYPTION_KEY`, one of the values that must come from the earlier host, and not yet entered when the rehearsal ran: listing a connector's tools failed ("is not set" in web's log). It was copied over later on 2026-11-10, and the settings check proves it opens the stored credentials.
- **The undo** (step 22). The live switch itself ran on 2026-11-11 ([the record](#the-record)); before it, by design, nothing here took production's traffic, scheduled jobs or background work.
- **The cloud browser:** needs the access token, team and project ids for its sandboxes. Not started on the rehearsal on purpose either: it would share production's sandbox names. After the switch, the sandbox service accepts the access token from inside the app's container; no cloud browser session has been started on the server yet.
- **The coding agent.** Off its earlier host every agent's shell is eve's `just-bash`, an emulated shell in the container, not a VM: no network policy, no git. So the coding agent's sandbox now runs on the earlier host's sandbox service, logged in with `SANDBOX_ACCESS_TOKEN`, `SANDBOX_TEAM_ID` and `SANDBOX_PROJECT_ID` (the cloud browser's three, above), when all three are set at the build and in the running container (`web/agents/coding-agent/sandbox.ts`, `app/build-agents.sh`). There the run's network policy is set when the sandbox is created. The sandbox is not handed the person's GitHub token: its clone, fetches, LFS requests and pushes all go through the app's git gate, which adds the token on the app's side and refuses an LFS answer that contains it (GitHub's own short-lived LFS storage links in those answers are not checked), and that service's firewall rules add only the run's gate token, on the gate's endpoints (before the read gate, those rules added the GitHub token on GitHub's read paths: that was the "broker", not a separate service). Written and tested without a live call; **not yet proven by a live run.** Before relying on it, in this order: the build's line `== eve build: coding-agent (sandbox: vercel)` followed by a `sandbox:` line ending in `=vercel`; a `restricted` run that clones a private repository and opens its pull request (the push goes through the app's git gate); in that run, `git push https://github.com/<repo>.git` and a push to another branch both refused; a request to a host outside the restricted list (`curl -sI https://example.com`) refused; an `isolated` run that cannot reach `registry.npmjs.org`; and the agent's log and the run's events with no token in them. Without the three settings, restricted and isolated runs refuse to start, as before, and a trusted run says which settings are missing.
- **Slack:** needs `CONNECT_ACCESS_TOKEN` and `CONNECT_PROJECT_ID` in the server's file (a Slack login through the connector was seen working from the server with them); its forwarded events go to the production domain, so they reach this server only after the switch (step 21, Gate 1 and step 5). After the switch a Slack message was answered by this server.

**Not done:**

- **Deleting the finished runs of utility and web-research.** They set `experimental.workflow.retention: 0` so that the mail text in their runs is kept nowhere; eve's file store here does not honour it, so the runs stay on their volumes. They are left out of the backup; a job that deletes their finished runs is still to be written, once the store's layout has been looked at with real runs in it.
- **Every server-side call to Supabase arrives from one address**, so Auth's per-address limits (token refresh: 150 an hour by default) count all of the app's own refreshes and sign-ins together. On the earlier host they came from a handful of addresses, so this is not new, but it is tighter. The fix is for the app to pass the person's address along on its server-side Auth calls.
- **Deploys are by hand:** merging to `main` does not deploy here. A workflow that runs `deploy.sh` over SSH after a merge would need a deploy key on the server and in GitHub.
- **An agent's live stream is cut when that agent is replaced** (eve's store allows one process per agent), and a phone call older than two minutes is cut when web is.

### Step 23: calls

Tested on a Mac, 2026-11-11, without Docker (Docker was not running there), with the same release LiveKit's image is built from (1.13.11, LiveKit's own binary), a local Redis 7 and the configuration exactly as `livekit/compose.yaml` renders it (`docker compose config`), changed only to find Redis on that machine:

- **Both renderings start:** with `LIVEKIT_NODE_IP` set (`node_ip`, discovery off) and empty (discovery through STUN, up in 8 seconds with the discovered address as `nodeIP`; LiveKit's own check that the address reaches back to it failed behind that Mac's home router, and it used the address all the same, as its code says it does); with webhooks and with `LIVEKIT_WEBHOOK_URL` empty (`urls: []`). Without the keys, `docker compose config` stops and names `make-keys.sh`.
- **Two participants in one room**, in two headless Chromium pages using the browser SDK (livekit-client 2.23), each with a token made by the server SDK (livekit-server-sdk 2.19): one published a synthetic tone and a canvas video (no microphone or camera), the other was subscribed to both and received the audio (about 50 KB in 4 seconds).
- **UDP, then TCP, each on its own.** With UDP allowed, the selected candidate pair was UDP to port 7882. With Chromium told that WebRTC may not use UDP without a proxy (`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, as in part 8), it was TCP to port 7881, and the audio arrived just the same.
- **Through the edge Caddyfile.** The same two runs with the signalling going through a copy of `edge/Caddyfile` (plain HTTP on a local port, `ni-livekit` replaced by the local address): the WebSocket and the API calls passed, and the join token in the WebSocket's address was `REDACTED` in Caddy's log. The Caddyfile is formatted (`caddy fmt`) and valid (`caddy validate`, Caddy 2.11.9) with `LIVEKIT_HOST` unset and set.
- **Webhooks**, sent to a local listener and checked with the server SDK's `WebhookReceiver`: `room_started`, `participant_joined`, `track_published`, `track_unpublished`, `participant_left`, every one's signature valid. With the listener answering `404`, LiveKit logged `sent webhook` all the same: its log does not show the answer, which is why part 8 checks the address separately.
- **The settings check's proof** against that server: the right pair `ok`; a wrong secret, a wrong key and an expired token each `WRONG` (`401`); nothing listening `cannot tell`; a web server that is not LiveKit `WRONG`. Its unit tests run in CI with the others.
- **An edge reload and restart during a call**, through that copy of the Caddyfile, with the receiving side's audio bytes counted each second: a `caddy reload --force` in the middle of the call left both participants' signalling connected (no reconnect at all) with `stream_close_delay`, and without it made both reconnect in 2 seconds. A full restart of Caddy, what replacing its container does, made both reconnect in about 3.5 seconds. In all three the audio kept arriving at the same rate throughout (about 12 KB a second; one second at about 8 KB during the restart).
- **`make-keys.sh` and part 3, run twice** on a copy of the folders: the guarded `install` left a filled-in `.env` untouched; a pair made once and kept on every later run; the app's copy written once its three lines existed; the same pair in both files; both files still mode 600; a run with everything in place changed neither file; `LIVEKIT_WEBHOOK_URL` filled in from `NEXT_PUBLIC_APP_URL` while empty, and left alone when set by hand or commented out; `--new` replacing the pair; a pair that is not letters and digits refused; no secret in anything it printed. `test-token.sh`'s token was accepted by the server SDK's verifier, for that room and 15 minutes.
- **The image's contents**, read from the registry without Docker (`livekit/livekit-server:v1.13.11`, linux/amd64, the index digest Docker Hub lists for the tag): `/usr/bin/wget` for the health check and part 8's check, `ssl_client` and the CA bundle for its `https://`, and the server binary. LiveKit's own log printed neither the key nor the secret in any of the runs above.

**Not tested, and why:**

- **The containers themselves**, on Docker: the read-only file system, the health check, the two networks and the published ports. Docker was not running on the machine this was written on. `docker compose config` was.
- **Discovery from `ni-livekit-edge`** on the server, and the server's own address in the `nodeIP` line: part 5 checks it.
- **From outside**: a real network, UDP and TCP through Docker's published ports, the certificate for the name, a phone on mobile data. Part 8 is that test.
- **Webhooks to the app's public name** from LiveKit's container, out and back in through Caddy: the address exists only on the server, and the app has no route for it yet. Part 8's `wget` is the check.
- **Networks that allow only 443**: not covered by design (above).

Egress (added later the same day) could not be run at all off the server: it is a Linux image with GStreamer, PulseAudio and Chrome. What was checked instead:

- **Its configuration** as `compose.yaml` renders it, with made-up values: valid YAML, and every key one that Egress v1.15.0 reads (the `yaml` tags in its `pkg/config` and in `livekit/storage`'s S3 settings, at the commits that release builds with), taken from its README and source rather than memory. The image tag exists on Docker Hub for amd64 and arm64.
- **The profile**: `docker compose config --services` lists `redis` and `livekit` without it, and `egress` too with `COMPOSE_PROFILES=egress`; without the profile the file renders even with every Egress setting missing. Egress publishes no port and is on `ni-livekit` and `ni-livekit-edge` only.
- **That LiveKit hands out the work**: with no Egress running, `test-egress.sh track` against the local LiveKit found the room's audio track and got `503 no response from servers` for the job, the answer of a LiveKit with no Egress on its Redis.
- **`room.auto_create: false`**, on the local LiveKit: a token for a room that does not exist was refused ("requested room does not exist") and no room appeared; after `CreateRoom` the same kind of token joined; `test-token.sh` made its room and a participant joined with the token it printed.
- **`make-keys.sh` copying the storage settings** from a made-up `supabase/stack/.env` (a secret with quotes and spaces in it): the four lines filled, the secret read back exactly, nothing copied a second time.

Not tested, and only the server can: Egress starting, its health check, its media path to LiveKit (LiveKit offers its address on `ni-livekit`, which its STUN request cannot leave and so stays as it is, and its public one, which Egress reaches through `ni-livekit-edge`; either will do, and with `LIVEKIT_NODE_IP` set only the public one is offered), the upload to Storage through Caddy (Storage's signature check against `SUPABASE_PUBLIC_URL` was read in its source, v1.89.12, not run), a track recording (E4) and a room composite's CPU (E5).

The call recorder (added 2026-11-11) was run on a Mac against LiveKit's own 1.13.11 binary, configured as `livekit/compose.yaml` renders it, with the end-to-end kit in [`../recorder/e2e`](../recorder/e2e) (a fake app speaking the feed's contract, fake participants publishing tones, Deepgram replaced by a fake that names each tone by its pitch):

- **Who said what, when.** Two members and a late meeting guest: every segment was its own speaker's tone, every burst spoken was heard within 0.9 s of when it was said, and nothing said while muted (muted from the server, as a person's mute reaches LiveKit) was heard. The guest, before saying go: no Deepgram socket opened and nothing heard; after: heard. A screen share's sound published beside a microphone: never heard. Two people speaking at once: their words reached the app in one request.
- **Things going wrong.** Every Deepgram socket dropped mid-sentence: reconnected, and the sentence heard. The app refused two requests (`503`): sent again, nothing taken twice. Someone left and came back on a new track: heard again under the same speaker. The recorder restarted (SIGTERM, then a new process with the same name): the session was taken up again (`resumed`) and words kept coming. Notes off: the recorder was told at its heartbeat, ended the session, and nothing said after was kept. The room emptied: it left and said `end`. 25 checks, all passed.
- **Hidden, and the room still closes.** No participant ever saw it; once everyone else left, the room closed 15 s later (LiveKit's departure timeout) with the recorder still in it: a hidden participant does not hold a room open.
- **Real Deepgram**, one short pass: two people each speaking a sentence (macOS's `say`): both sentences came back word for word, each under its own speaker.
- The compose file renders with and without the profile (`docker compose config`); `make-keys.sh`'s recorder part was run on a copy of the folders (secret made once into both files, kept on a second run, the app's copied when only it had one, a mismatch reported). The database functions were run on the development database in transactions that were rolled back (`web/supabase/tests/587_capture_feed.sql`, 79 checks, among them a capture of 1,505 lines written whole in the order said, and the eject outbox filled on notes off, a lost feed and a capture ended by hand). That file is not run by CI, which has no Postgres; the text of 587-588 is pinned by `src/lib/capture-feed/__tests__/migration-587-588.test.ts`, which is.

Not tested, and only the server can: the recorder's image built and started there (its native library on linux/amd64), its health check, its media path to LiveKit and its way out to the app and Deepgram through `ni-livekit-edge`, real people on browsers, the desktop app and the iPhone, and its load with several calls (R5 and "What only this server can prove" above).

## The record

**The database, 2026-11-10** (steps 14 to 18). The door closed at 18:42:18 UTC and the switch was made at 18:47:40: 5 minutes 22 seconds without the database. 931 MB, 255 tables. Every table's rows, the accounts, the files and the permissions compared equal on both sides.

**The app, 2026-11-11** (step 21; the rehearsal, step 20, was on 2026-11-10). The earlier host's scheduled jobs off at 04:01 UTC, the server live at 04:02, the six names moved from 04:05 to 04:07. Checked afterwards: sessions kept (still signed in), the scheduled jobs called, background jobs arriving, mail push messages arriving, and a Slack message answered by the server. The earlier host keeps its last deployment as the undo; the repository is no longer connected to it, so a merge to `main` deploys nothing until `deploy.sh` runs on the server.

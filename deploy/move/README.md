# Moving to another server

Everything in `deploy/` is meant to run on one server and to be movable to another one in a single sitting: a bigger machine, a different provider, or a replacement after a hardware fault. [`move.sh`](move.sh) does the move. This page is the procedure around it.

Nothing on a server is set up by hand, which is what makes this possible:

| What | Where it lives | How it gets to the new server |
| --- | --- | --- |
| The system setup (SSH, firewall, updates, Docker, networks) | [`../server/setup.sh`](../server/setup.sh) | `prepare` runs the script there |
| What runs, and at which version | the compose files in this repository | `prepare` checks out the same commit the old server is on |
| The settings and secrets | one `.env` file per folder, on the server only | `prepare` copies them across; their contents are never shown |
| The data | Docker volumes whose names start with `ni-` | `sync` and `cutover` copy them, server to server |
| The public names | DNS records | you change them, after `cutover` |

## What it costs

The platform is down from the moment `cutover` stops the old containers until the DNS names answer from the new server. With the data already copied by `sync`, that is the time to copy what changed since, start the containers, and for DNS to catch up: a few minutes when the records have a short lifetime (60 seconds here).

Avoiding that pause altogether needs two servers running the databases at the same time, which this setup deliberately does not have.

Scheduled jobs that would have fired during the pause skip that turn. Jobs that were in flight carry on from where they were: their state is part of the data that moves.

## Before you start

- **The new server**: a fresh Ubuntu 24.04, reachable over SSH with your key as an ordinary user who can run `sudo` without a password. Not `root`: the setup turns root logins off, so if the provider only gave you `root`, make a user first. Nothing else needs to be on it.
- **The old server**: still running, same kind of login. If its user was made the way step 2 of [`../README.md`](../README.md) describes, `sudo` asks for a password there; give that user password-free `sudo` for the length of the move (`echo '<user> ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/90-ni-move`) and remove that file afterwards.
- **Your own machine**: a checkout of this repository and `ssh`. Nothing is installed on it. Log in to the new server once by hand first (`ssh <user>@<new server>`), so that its host key is known: the script never answers that question for you.
- **DNS**: the records that point at the old server should have a short lifetime (TTL) before the day of the move. Lower them a day ahead if they are long.
- Pick a quiet moment, and start `cutover` just after a five-minute mark rather than just before one, so the fewest scheduled jobs are skipped.

Every command below starts the same way. `OLD` and `NEW` are the two logins; the host part of `OLD` has to be an address the new server can reach as well, so use the IP address or a DNS name, not an alias from your own SSH config.

```bash
export OLD=<user>@<old server> NEW=<user>@<new server>
```

If your key is not the default one, say which, once:

```bash
export MOVE_SSH_OPTS="-i $HOME/.ssh/id_ed25519 -o IdentitiesOnly=yes"
```

## 1. Look

Changes nothing. It lists what the old server runs and how much data there is, and confirms both servers answer.

```bash
deploy/move/move.sh check
```

## 2. Prepare the new server

Runs `setup.sh` there, checks out the commit the old server is on, copies the `.env` files, pulls and builds the images, and creates the containers without starting them. The old server is not touched and keeps serving. It can be run again.

```bash
deploy/move/move.sh prepare
```

Two things it may tell you:

- **Files that are not in git.** If someone edited a file in the old server's checkout by hand (the `Caddyfile`, say) and never committed it, that edit would not move. `prepare` lists such files and stops. Commit them and update the old server. If that is not possible, run `prepare` again with `MOVE_ALLOW_DIRTY=1` and copy those files to the new server yourself afterwards, in that order: the checkout has to exist there first.
- **A reboot is waiting.** A fresh server usually installs a kernel update during setup. Reboot it when `prepare` says so, before the next step; otherwise it reboots itself at its nightly time, which could be in the middle of the move.

## 3. Copy the data

Copies every `ni-` volume straight from the old server to the new one. The old server keeps running, so this copy is not consistent yet; its only purpose is to make the next step short. Run it as often as you like, and once more shortly before the cutover if the data is large. With a database running underneath, some files vanish or change while they are being copied. `sync` then shows what rsync said and carries on, and the cutover copies those files again. Read that list once: a line about permissions or an unreadable file is a real error, and it would stop the cutover too.

```bash
deploy/move/move.sh sync
```

The copy travels between the two servers, not through your machine. For that, `sync` makes a temporary key on the new server and allows it on the old one: no terminal and no forwarding, and only from the new server's IPv4 address when `NEW` is one or a name that resolves to one. It is still a login, and that user can `sudo`: until step 6 removes the key, whoever controls the new server controls the old one. Do not leave a move half done for days.

Only one copy runs at a time. If your connection drops during a copy, it keeps running on the new server; the next `sync` or `cutover` waits to be run until it has ended, and says so.

## 4. Cut over

Before it stops anything it checks that the new server is prepared and has nothing running, and it asks. Then it stops the containers on the old server, makes sure none is left running, copies what changed since the last `sync`, and starts everything on the new server, waiting until each container reports healthy.

This last copy compares the contents of every file, not just its size and time. That is slower, and it is the point: a database file rewritten in place within the same second as the earlier copy looks unchanged otherwise, and a database started on it would be corrupt.

```bash
deploy/move/move.sh cutover
```

It prints how long that took. The certificates came along with the data, so the new server answers on HTTPS as soon as a request reaches it.

If it stops half-way, it says what state things are in and what to do. Before anything was started on the new server, running `cutover` again carries on. If it stopped while starting the containers there, some of them are running: look at why, stop them, and run `cutover` again, or go back. `rollback` starts the old server again in either case.

A finished cutover leaves a marker on the new server (`/root/.ni-move-live`). While it is there, `prepare`, `sync` and `cutover` refuse to run against that server: copying onto it again would replace everything it has written since with the old server's data.

## 5. Point the names at the new server

Change every DNS record that pointed at the old server's address so it points at the new one. Then check from your own machine that each name answers from the new server:

```bash
dig +short inngest.nativeintelligence.dev sb.nativeintelligence.dev
```

Then check the platform itself, the same way as after the first installation: the checks at the end of step 9 in [`../README.md`](../README.md), the Inngest dashboard (step 10) showing the app with its functions and no error, and one backup taken by hand (step 11).

## 6. Finish

Removes the temporary key from both servers.

```bash
deploy/move/move.sh finish
```

The old server still holds its stopped containers and its copy of the data. Keep it for a few days: it is the way back. Then cancel it with the provider. Do not start its containers again while the new server is live: two copies of the job server would both run the scheduled work.

## Going back

Within minutes of a cutover that went wrong:

```bash
deploy/move/move.sh rollback
```

It shows since when the new server has been live and always asks first, even with `MOVE_YES=1`. Then it stops the new server's containers and starts the old one's, with the data as it was at the cutover, removes the marker, and tells you to point the DNS records back. Whatever was written on the new server in between is left behind, which is why this is only for the first minutes. Later than that, fix the new server instead, or move again in the other direction with `OLD` and `NEW` swapped.

If you are giving up on the move rather than trying again, run `finish` as well: the temporary key is still in place after a rollback.

## What it does not cover

- **Anything outside `deploy/`.** A package installed by hand, a file edited outside the checkout, a cron job that does not start with `ni-`: none of it moves. Put such things in `setup.sh` or in this folder instead.
- **Things held by the provider or by other services**: the DNS records themselves, reverse DNS for the new address, the provider's own monitoring or backups, and any allowlist somewhere else that names the old address.
- **Containers that are not started with Docker Compose.** Every stack here is a Compose project today. A stack run another way needs its own lines in `move.sh` before it can move.
- **A different version.** The new server starts on the commit the old one was on, so the compose files are the same. Images named by a moving tag (`postgres:17`, `redis:7-alpine`) are pulled fresh, so the new server may run a newer patch release than the old one did; within one major version the data is compatible. Change versions on purpose afterwards, as a separate step.
- **Files in the checkout that are not in git**, as step 2 explains. That includes folders a stack fills at run time and git ignores, such as the SQL snippets Supabase Studio saves.

## What was tested

One real move, on 2026-11-10: from a 2-core virtual server to a 6-core dedicated one in the same region, carrying three stacks (Inngest with its Postgres and Redis, Caddy, the backups), four volumes and 144 MB of data.

| Step | What happened |
| --- | --- |
| `prepare` | Set the new server up from nothing, copied three settings files, pulled and built the images, created six containers stopped. |
| `sync` | 1,379 files, 144 MB, server to server, with the old server running. |
| `cutover` | 21 seconds from the first container stopping to the last one healthy on the new server. The content-comparing copy re-sent 60 files (96 MB). |
| DNS | Two records with a 60-second lifetime, changed two seconds after the cutover finished. |
| Back in service | The app registered with the new server 78 seconds after the cutover began. |
| `finish` | Temporary key gone from both servers. |

Afterwards: HTTPS answered on the first request with the certificates that came along, the job server showed the app with all its functions and no error, the next scheduled jobs ran on the new server, and a backup taken there landed beside the old server's.

The first run also found two bugs that reading had not: the setup script stopped silently at the firewall step, and the check for running containers could not fail. Both are fixed here, and the fixed script is what did the move.

Not tested:

- `rollback`. It has never been run.
- A large database. The content-comparing copy at cutover reads every file on both servers, so its time grows with the data; nothing here measures that beyond 144 MB.
- The Supabase stack, which was not installed yet. It is a Compose project like the others, so it should be picked up by name, and the extra folders of the repository it reads are carried over to the new checkout, but none of that has been run.
- A copy interrupted half-way, and a cutover that failed while starting containers. The guards for both are written and reviewed, not exercised.
- `NEW` given as a DNS name rather than an address, and an old server whose user needs a password for `sudo`.

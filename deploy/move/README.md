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

- **The new server**: a fresh Ubuntu 24.04, reachable over SSH with your key as a user who can run `sudo` without a password (the provider's default user is fine). Nothing else needs to be on it.
- **The old server**: still running, same kind of login.
- **Your own machine**: a checkout of this repository and `ssh`. Nothing is installed on it.
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

## 3. Copy the data

Copies every `ni-` volume straight from the old server to the new one. The old server keeps running, so this copy is not consistent yet; its only purpose is to make the next step short. Run it as often as you like, and once more shortly before the cutover if the data is large.

```bash
deploy/move/move.sh sync
```

The copy travels between the two servers, not through your machine. For that, `sync` makes a temporary key on the new server and allows it on the old one, for that one address only. Step 6 removes it.

## 4. Cut over

Stops the containers on the old server, copies what changed since the last `sync` (now consistent, because nothing is writing), and starts everything on the new server, waiting until each container reports healthy. It asks before it does anything.

```bash
deploy/move/move.sh cutover
```

It prints how long that took. The certificates came along with the data, so the new server answers on HTTPS as soon as a request reaches it.

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

It stops the new server's containers and starts the old one's, with the data as it was at the cutover, and tells you to point the DNS records back. Whatever was written on the new server in between is left behind, which is why this is only for the first minutes. Later than that, fix the new server instead, or move again in the other direction with `OLD` and `NEW` swapped.

## What it does not cover

- **Anything outside `deploy/`.** A package installed by hand, a file edited outside the checkout, a cron job that does not start with `ni-`: none of it moves. Put such things in `setup.sh` or in this folder instead.
- **Things held by the provider or by other services**: the DNS records themselves, reverse DNS for the new address, the provider's own monitoring or backups, and any allowlist somewhere else that names the old address.
- **Containers that are not started with Docker Compose.** Every stack here is a Compose project today. A stack run another way needs its own lines in `move.sh` before it can move.
- **A different version.** The new server starts on the commit the old one was on, because the data has to match the images. Update afterwards, as a separate step.

## What was tested

Nothing on this page has been run end to end yet. This section is replaced with the record of the first real move.

# Backups

One small container (`ni-backup`) that runs cron. Each line in [`crontab`](crontab) is a job. Today there is one: every night it dumps Inngest's Postgres, encrypts the dump and uploads it to a Backblaze B2 bucket, deletes backups older than 30 days, then requests a dead-man URL. Setting it up is step 11 of [`../README.md`](../README.md). This page is about what the backups are and how to get one back.

## What a backup is

- **Format.** `pg_dump --format=custom` of the whole `inngest` database: apps, functions and run history.
- **Encryption.** rclone's `crypt` layer, applied inside the container before upload. B2 only ever holds ciphertext. Reading a backup takes both `BACKUP_PASSWORD` and `BACKUP_SALT` from this folder's `.env`. Keep them in the password manager: without them the backups are unreadable, by you too.
- **Where.** `<bucket>/inngest/<year>/<month>/inngest-<UTC timestamp>.dump.bin`. File names are not encrypted, so a listing in the B2 console makes sense. Contents are.
- **Retention.** After each good upload, files older than `BACKUP_INNGEST_RETENTION_DAYS` (default 30) are deleted for good. Nothing is deleted when the upload failed.
- **Dead-man ping.** `BACKUP_INNGEST_PING_URL` is requested last, only when the dump, upload, read-back check and retention all worked. No request for a day means no fresh backup.

What it does **not** cover: Redis. The queue and the state of runs in flight live in Redis (an append-only file on the `ni-inngest-redis` volume), which survives restarts but not the loss of the disk. After a rebuild from backup, runs that were sleeping or waiting are gone and scheduled functions start again at their next tick. The app's functions do not need the backup at all: the server learns them again from the app within a minute.

## Everyday commands

Run from `/opt/native-intelligence/deploy/backup`.

```bash
sudo docker compose logs --tail 50 backup
```

```bash
sudo docker compose exec backup backup-postgres inngest
```

```bash
sudo docker compose exec backup rclone lsf -R --files-only --format tsp vault:inngest/
```

The first shows recent runs, the second takes a backup now (it also pings), the third lists what is held (time, size, path).

## Restore onto this server

This replaces the contents of the running Inngest database with one backup.

1. Pick the backup. The list is sorted, so the last line is the newest.

   ```bash
   cd /opt/native-intelligence/deploy/backup
   ```

   ```bash
   sudo docker compose exec backup rclone lsf -R --files-only vault:inngest/ | sort
   ```

2. Stop the Inngest server, so nothing writes while the tables are replaced. Postgres keeps running.

   ```bash
   cd /opt/native-intelligence/deploy/inngest
   ```

   ```bash
   sudo docker compose stop inngest
   ```

3. Restore. Put the path from step 1 in place of the example. The file is decrypted as it is read and goes straight into `pg_restore`; nothing is written to disk.

   ```bash
   cd /opt/native-intelligence/deploy/backup
   ```

   ```bash
   sudo docker compose exec backup sh -c 'rclone cat "vault:inngest/2026/11/inngest-20261109T071700Z.dump" | PGPASSWORD="$BACKUP_INNGEST_PGPASSWORD" pg_restore --host ni-inngest-postgres --username inngest --dbname inngest --clean --if-exists --no-owner --exit-on-error'
   ```

   No output and exit status 0 is success.

4. Start the server again and check it is healthy.

   ```bash
   cd /opt/native-intelligence/deploy/inngest
   ```

   ```bash
   sudo docker compose up -d
   ```

   ```bash
   sudo docker compose ps
   ```

If the server itself was lost, first rebuild it from [`../README.md`](../README.md) with the same `.env` files (from the password manager), let the Inngest stack start once so the empty database exists, then do steps 1 to 4.

## Read a backup anywhere else

On any machine with [rclone](https://rclone.org/install/) and the Postgres 17 client tools. This is also the way to test a backup without touching the server.

1. Describe the bucket and the encryption to rclone. The four values come from this folder's `.env`. `--obscure` is required: it is how rclone stores the two passwords.

   ```bash
   rclone config create ni-b2 b2 account "<B2_KEY_ID>" key "<B2_APPLICATION_KEY>"
   ```

   ```bash
   rclone config create ni-vault crypt remote "ni-b2:<B2_BUCKET>" filename_encryption off directory_name_encryption false password "<BACKUP_PASSWORD>" password2 "<BACKUP_SALT>" --obscure
   ```

2. Download one. It is decrypted on the way down.

   ```bash
   rclone lsf -R --files-only ni-vault:inngest/ | sort
   ```

   ```bash
   rclone copyto "ni-vault:inngest/2026/11/inngest-20261109T071700Z.dump" ./inngest.dump
   ```

3. Check it, or load it into a scratch database.

   ```bash
   pg_restore --list ./inngest.dump | head
   ```

   ```bash
   createdb inngest_check && pg_restore --dbname inngest_check --no-owner ./inngest.dump
   ```

4. Remove the two remotes when done. They hold the keys.

   ```bash
   rclone config delete ni-vault && rclone config delete ni-b2
   ```

Do this once after the first real backup, and again every few months. A backup that has never been restored is a guess.

## Try the whole job without B2

Useful right after writing `.env`, before trusting the schedule: it proves the database password and the encryption settings by running the real job against a folder inside a throwaway container. Nothing is uploaded and no ping is sent.

```bash
sudo docker compose run --rm -e BACKUP_TARGET=/tmp/try -e BACKUP_INNGEST_PING_URL= backup backup-postgres inngest
```

The last line should be `[inngest] done`.

## Add a second database

The layout is one job per line, so an hourly dump of another database is three additions and no restructuring:

1. [`crontab`](crontab): a line such as `43 * * * * backup-postgres supabase >/proc/1/fd/1 2>&1` (there is a commented one ready).
2. [`compose.yaml`](compose.yaml): a `BACKUP_SUPABASE_*` block beside the `BACKUP_INNGEST_*` one (host, user, database, password, retention, ping URL), and that database's Docker network under `networks`, the way `inngest` is there.
3. `.env`: `BACKUP_SUPABASE_PGPASSWORD` and `BACKUP_SUPABASE_PING_URL`.

Then `sudo docker compose up -d --build`. Its files land under `supabase/` in the same bucket, with their own retention and their own dead-man check.

## A stricter setup, if wanted

As shipped, the B2 key on the server can delete files, because retention is done from here. A stolen key could therefore delete the backups. To close that: give the key no delete permission, set `BACKUP_INNGEST_RETENTION_DAYS=0`, and let B2 expire files itself with a lifecycle rule on the bucket (hide after 30 days, delete a day later). Not set up here because it is a B2 console setting and could not be tested from the repo.

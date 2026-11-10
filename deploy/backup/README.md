# Backups

One small container (`ni-backup`) that runs cron. Each line in [`crontab`](crontab) is a job:

| Job | When | What |
| --- | --- | --- |
| `inngest` | Nightly | A dump of Inngest's Postgres. Kept 30 days. |
| `supabase` | Every hour | A dump of the whole Supabase database, and the cluster's roles. Kept: the newest 48, and the newest of each of the last 30 days. |
| `supabase-storage` | Nightly | Every file in Supabase Storage. A file deleted or replaced there is kept 30 days more. |

Everything is encrypted in the container and uploaded to one Backblaze B2 bucket, and each job requests its own dead-man URL after a good run. Setting it up is step 11 of [`../README.md`](../README.md), and step 17 for the two Supabase jobs, which stay off until then. This page is about what the backups are and how to get one back. The first half is Inngest; [Supabase](#supabase) has its own half below.

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

3. Restore. Put the path from step 1 in place of the example. The file is decrypted as it is read and goes straight into `pg_restore`; nothing is written to disk. It runs as one transaction: if anything fails part way (the download included), the database is left exactly as it was.

   ```bash
   cd /opt/native-intelligence/deploy/backup
   ```

   ```bash
   sudo docker compose exec backup sh -c 'rclone cat "vault:inngest/2026/11/inngest-20261109T071700Z.dump" | PGPASSWORD="$BACKUP_INNGEST_PGPASSWORD" pg_restore --host ni-inngest-postgres --username inngest --dbname inngest --clean --if-exists --no-owner --single-transaction --exit-on-error'
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

## Add another database

The layout is one job per line, so a dump of another database is three additions and no restructuring. The `supabase` job is the worked example:

1. [`crontab`](crontab): a line such as `43 * * * * backup-postgres supabase >/proc/1/fd/1 2>&1`.
2. A compose file: a `BACKUP_<NAME>_*` block (host, user, database, password, retention, ping URL), and that database's Docker network under `networks`. For a database that is always there, add it to [`compose.yaml`](compose.yaml) beside the `BACKUP_INNGEST_*` one. For one that arrives later, put it in a file of its own as [`compose.supabase.yaml`](compose.supabase.yaml) does, and switch it on with `COMPOSE_FILE` in `.env`: a job whose settings are missing is not scheduled, and the container says so when it starts.
3. `.env`: the password and the ping URL.

Then `sudo docker compose up -d --build`. Its files land under `<name>/` in the same bucket, with their own retention and their own dead-man check.

## Supabase

Two jobs, both switched on by one line in `.env` (step 17 of [`../README.md`](../README.md)).

### What is backed up

- **The database, every hour** (`supabase`). `pg_dump --format=custom` of the whole `postgres` database as `supabase_admin`, the one role that can read every schema: the app's tables, accounts and sessions (`auth`), the record of every stored file (`storage`), cron jobs, policies, grants. Beside each dump, a small `.roles.sql`: the cluster's roles and the settings stored on them (`ALTER ROLE service_role SET statement_timeout`, for one), which a dump of one database cannot hold. No passwords are in it; those come from `stack/.env`.
  `supabase/<year>/<month>/supabase-<UTC timestamp>.dump.bin`, and the same name ending in `.roles.sql.bin`.
- **The files, every night** (`supabase-storage`). Read through Storage's S3 endpoint, never from its folder on disk.
  `supabase-storage/current/<bucket>/<path>.bin` is every file as it is now.
  `supabase-storage/removed/<UTC timestamp>/<bucket>/…` is what a run found deleted or replaced. Nothing is erased for 30 days.
  `supabase-storage/manifest/<bucket>.tsv.bin` is what the last run saw, which is how the next one knows what changed.
- **Retention of the database.** After each good upload: the newest 48 dumps stay, and so does the newest dump of each of the last 30 days. Everything else is deleted, with its roles file.

**What is not in any backup, and has to be kept somewhere else:**

- `stack/.env`. Without `JWT_SECRET` every session and every app's key is invalid; without `POSTGRES_PASSWORD` the roles file cannot be made to match. It belongs in the password manager.
- The `ni-supabase-db-config` volume, which holds the key Postgres encrypts its vault with. The app keeps nothing in the vault today. The day it does, that key has to be saved too (`sudo docker compose exec db cat /etc/postgresql-custom/pgsodium_root.key`, from `../supabase/stack`).
- A file uploaded after the last nightly run. Its record comes back with the database; the file does not. `restore-supabase-storage` lists such records.

### Everyday commands

From `/opt/native-intelligence/deploy/backup`.

```bash
sudo docker compose exec backup backup-postgres supabase
```

```bash
sudo docker compose exec backup backup-storage supabase-storage
```

```bash
sudo docker compose exec backup rclone lsf -R --files-only --format tsp vault:supabase/
```

The first two run a job now (each also pings). The third lists the database backups held.

### Restore the database

This replaces the whole Supabase database with one backup. It is the same whether the database is damaged or brand new.

1. Pick the backup. The list is sorted, so the last line is the newest.

   ```bash
   cd /opt/native-intelligence/deploy/backup
   ```

   ```bash
   sudo docker compose exec backup rclone lsf -R --files-only vault:supabase/ | grep 'dump$' | sort
   ```

2. Stop every Supabase service except the database: they hold connections, and tables cannot be replaced under them.

   ```bash
   cd /opt/native-intelligence/deploy/supabase/stack
   ```

   ```bash
   sudo docker compose stop studio api-gw auth rest realtime storage functions meta supavisor mail-templates
   ```

3. Restore. Put the path from step 1 in place of the example. It asks you to type `yes`.

   ```bash
   cd /opt/native-intelligence/deploy/backup
   ```

   ```bash
   sudo docker compose exec backup restore-supabase-db 2026/11/supabase-20261110T074300Z.dump
   ```

   It applies the roles file, clears the database's default grants (so that tables and functions come back with their own permissions and no more), runs `pg_restore --clean --if-exists` and ends with the number of users and tables. Any error from `pg_restore` makes it fail and say so.

4. Start everything again.

   ```bash
   cd /opt/native-intelligence/deploy/supabase/stack
   ```

   ```bash
   sudo sh run.sh start
   ```

Whatever was written after that backup was taken is gone: at most an hour.

### Restore the files

Only when the stored files themselves were lost (the `ni-supabase-storage` volume). The database must be right first, and the stack running: the database holds the record of every file, and this puts the bytes back behind those records.

```bash
cd /opt/native-intelligence/deploy/backup
```

```bash
sudo docker compose exec backup restore-supabase-storage
```

Each file is uploaded through Storage with the content type and cache setting its record has, the records are set back to what they were, and every file is then read back and compared with the backup. A record whose file is not in the backup is listed at the end.

One file, or one that was deleted by mistake, is easier by hand. `current/` has what Storage has now and `removed/` what it used to have:

```bash
sudo docker compose exec backup rclone lsf -R --files-only vault:supabase-storage/removed/
```

```bash
sudo docker compose exec backup rclone copyto "vault:supabase-storage/removed/<timestamp>/<bucket>/<path>" /tmp/recovered
```

then `sudo docker compose cp backup:/tmp/recovered .` and upload it again through the app or Studio.

### If the server itself is lost

Rebuild it from [`../README.md`](../README.md) with the same `.env` files from the password manager, up to a running, empty Supabase stack (step 14) and this container (steps 11 and 17). Then "Restore the database", then "Restore the files". That is the drill of step 17, and it was rehearsed that way: database and files deleted, both restored, and the database afterwards identical to before, table for table and grant for grant.

### Try the jobs without B2

```bash
sudo docker compose run --rm -e BACKUP_TARGET=/tmp/try -e BACKUP_SUPABASE_PING_URL= backup backup-postgres supabase
```

```bash
sudo docker compose run --rm -e BACKUP_TARGET=/tmp/try -e BACKUP_SUPABASE_STORAGE_PING_URL= backup backup-storage supabase-storage
```

## A stricter setup, if wanted

As shipped, the B2 key on the server can delete files, because retention is done from here. A stolen key could therefore delete the backups. To close that: give the key no delete permission, set `BACKUP_INNGEST_RETENTION_DAYS=0`, and let B2 expire files itself with a lifecycle rule on the bucket (hide after 30 days, delete a day later). Not set up here because it is a B2 console setting and could not be tested from the repo. The two Supabase jobs do not fit that scheme as they are: "48 hourly and 30 daily" is decided here, and the file job moves files between folders.

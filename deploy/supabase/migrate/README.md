# Moving the hosted project onto this server

Scripts and runbook for the move itself: the database, then the stored files, then proof that both sides are the same. When to run them, and everything around them (the rehearsal, the switch, the undo), is steps 16 to 19 of [`../../README.md`](../../README.md). This page is what each script does and what to do when one stops.

They follow Supabase's two guides:

- [Restore a Platform Project to Self-Hosted](https://supabase.com/docs/guides/self-hosting/restore-from-platform): a three-file dump made by the Supabase CLI (roles, schema, data), never a raw `pg_dump`, restored with one `psql` run in one transaction.
- [Copy Storage Objects from Platform](https://supabase.com/docs/guides/self-hosting/copy-from-platform-s3): files copied with rclone over the S3 protocol on both sides, buckets first, never copied into the storage folder.

## Where the guides are not enough

Rehearsing both guides exactly as written, against a copy of this app's schema, went wrong in five places. Each is handled by a script here; the commands in the guides are otherwise used as they stand.

| Following the guide exactly | What happens | What the scripts do |
| --- | --- | --- |
| `rclone copy platform:bucket self-hosted:bucket` after the database restore | Copies nothing. The restore has already brought over the *record* of every file, so the self-hosted side lists them all, with the right sizes, before any file exists. rclone compares the listings and reports "nothing to transfer". The guide's check (`rclone size`) and `rclone check` both pass. Every download then fails. | `03-copy-storage.sh` copies with `--ignore-times`, then downloads every file from both sides and compares the bytes. |
| The restore, into a new self-hosted database | 129 tables and 220 functions end up open to roles the hosted project keeps them from. A new Supabase database grants `anon` and `authenticated` access to everything created in `public`; the dump only adds grants, so the ones the app revoked come back. | `02-restore.sh` clears those default grants inside the same transaction, before anything is created. The dump's last lines put the hosted project's own defaults back. |
| `supabase db dump` for the schema | Leaves out the `auth`, `storage` and `realtime` schemas, and with them everything the app added to their tables: the two triggers on `auth.users` that set up a new account, six policies on `storage.objects`, three on `realtime.messages`. New sign-ups would get no workspace; nobody could read a file. | `01-dump.sh` writes them to a fourth file, `extras.sql`, and `02-restore.sh` applies it. |
| `supabase db dump` for the data | Has no `pg_cron` jobs in it (the job table belongs to the extension). | Also in `extras.sql`. |
| The restore command | Fails on `storage.buckets_vectors`: the dump has a (empty) section for a table the `postgres` role may not write to on self-hosted. The same happens for any table the platform has and this release does not. | `02-restore.sh` checks every table and column in the data against the target first, leaves out empty sections that cannot be written, and stops with a list for anything that holds rows. |

Two things rclone does to the file records on the way are also undone: it leaves two timestamps of its own in each record's user metadata, and without `--metadata` every file loses its `Cache-Control` header.

## Before you start

On the server, as `deploy`:

1. **The stack is up and empty** ([step 14](../../README.md#14-supabase-the-stack)).
2. **The Supabase CLI.** `01-dump.sh` uses it; it runs `pg_dump` from Supabase's own Postgres image, in Docker. Version 3.1.0 is the one these scripts were rehearsed with, and what its dump leaves out is what `extras.sql` is built around, so that version is the one to install.

   ```bash
   curl -fsSL https://github.com/supabase/cli/releases/download/v3.1.0/supabase_linux_amd64.tar.gz | sudo tar -xz -C /usr/local/bin supabase
   ```

   ```bash
   supabase --version
   ```

3. **An S3 access key on the hosted project.** Dashboard: Storage, S3 Configuration, "New access key". The secret is shown once.
4. **The connection settings.**

   ```bash
   cd /opt/native-intelligence/deploy/supabase/migrate
   ```

   ```bash
   sudo install -m 600 -o root -g root .env.example .env
   ```

   ```bash
   sudo nano .env
   ```

   [`.env.example`](.env.example) says where each value is in the hosted dashboard. Nothing about the self-hosted side goes in it: that is read from `../stack/.env`.

Every script is run with `sudo`, from this folder. psql and rclone run in containers (the same two images the backup container is built from), so nothing else is installed.

## The scripts, in order

### `00-preflight.sh`

Read-only. Connects to both sides and says what will move, what no step moves, and what would stop the restore. Run it first, and again right before the real switch.

```bash
sudo ./00-preflight.sh
```

Read the section **NOT moved by any step**. Vault secrets are encrypted with a key that stays on the platform and have to be made again by hand (`select vault.create_secret('<value>', '<name>')`); roles made by hand come over without a password; a database webhook keeps calling whatever address it was given.

### `01-dump.sh`

Read-only on the hosted project. Writes four files into a new, root-only folder under `dumps/`:

```bash
sudo ./01-dump.sh
```

| File | From | Holds |
| --- | --- | --- |
| `roles.sql` | `supabase db dump --role-only` | Roles made by hand, and settings stored on roles. This is where `ALTER ROLE service_role SET statement_timeout = '120s'` travels. |
| `schema.sql` | `supabase db dump` | Every table, function, policy, index and grant of the app's own schemas, the extensions, and the tables in the `supabase_realtime` publication. |
| `data.sql` | `supabase db dump --use-copy --data-only` | Every row, including `auth` (accounts, identities, sessions, refresh tokens) and `storage` (buckets and file records). |
| `extras.sql` | [`sql/managed-schema-objects.sql`](sql/managed-schema-objects.sql) | What the CLI leaves out: the app's policies and triggers on `auth`, `storage` and `realtime` tables, and the cron jobs. |

`pg_dump` warns about circular foreign keys. That is expected; the restore loads the data with triggers off, as the guide says.

**The folder holds every user's email address, password hash and data, in plain text.** It is deleted when the move is over.

### `02-restore.sh <dump folder>`

```bash
sudo ./02-restore.sh dumps/<folder>
```

Refuses a database that is not empty. Then checks extensions and whether the data fits, then runs the guide's command:

```text
psql --single-transaction --variable ON_ERROR_STOP=1 \
     --file roles.sql --file schema.sql \
     --command 'SET session_replication_role = replica' \
     --file data.sql
```

with the default grants cleared in front and `extras.sql` behind, all in the one transaction, through the pooler as `postgres.<tenant>` as the guide has it. If anything fails, everything is rolled back and the database is empty again, and the whole log of the attempt is kept in the dump folder as `restore-failed-<time>.log`. Afterwards it runs `ANALYZE`.

Without `--final` it is a **rehearsal**: every cron job is paused, because a copy of production must not run production's jobs a second time. The pause is the last statement of that same transaction, so the jobs are never seen active here. At the real switch:

```bash
sudo ./02-restore.sh dumps/<folder> --final
```

Then restart the stack, so that every service re-reads the database:

```bash
cd ../stack && sudo sh run.sh restart && cd ../migrate
```

### `03-copy-storage.sh`

```bash
sudo ./03-copy-storage.sh
```

For each bucket: copy, set the records' user metadata and `updated_at` back to the hosted project's, then download every file from both sides and compare. It can be run again; every run sends every file. It ends with `done` or with the list of what differs.

### `04-verify.sh`

```bash
sudo ./04-verify.sh
```

Read-only on both sides. Describes each database in a few thousand lines (one per table, policy, function and so on) and prints every line that is not the same on the other side. It compares: the row count of every table and a checksum of each table's content; the columns of every Auth and Storage table; `auth.users` and `auth.identities`, spelled out; buckets, files per bucket, every file record, and the files themselves byte for byte; extension versions; the publications' table lists; the number of policies and every policy; row-level-security switches, triggers, columns, constraints, indexes, views, functions and who may call them, sequences, table grants, role settings and cron jobs.

`--fast` leaves out the content checksums, `--no-files` the downloads, `--keep` leaves the two descriptions on disk to look at.

## Reading the verification

It exits with `no differences` or a count. These differences are expected and are not errors:

| Section | Difference | Why |
| --- | --- | --- |
| `rows` | A table only on hosted | A table left out with `--skip-table`, or one the platform's Auth or Storage has and this release does not |
| `service table columns` | A column, or a whole table, only on hosted | The platform's Auth or Storage is a version ahead of this release's. This section lists the columns of each of their tables so that the difference is named. It is not a difference in data: the `rows` checksum of such a table is taken over the columns both sides have, so `rows` still says whether every row arrived. A column left out with `--skip-column` shows here. |
| `rows`, `accounts`, `sequences`, `file records` | Counts and checksums differ **in a rehearsal** | The hosted project kept working after the dump was taken |
| `constraints`, `policies` | Two lines that differ only in their brackets | Postgres writes an expression back in its own words when it is loaded. `((a AND b) AND c)` and `(a AND b AND c)` are the same rule. |
| `cron jobs` | `PAUSED` here | A rehearsal. With `--final` they match. |
| `cron jobs` | `as postgres` here, another role on hosted | The jobs are made again by the role the restore runs as. A job that has to run as another role is made again by hand, as that role. |
| `not moved by any step` | Vault secrets: a number on hosted, 0 here | Make them again by hand |
| `extensions` | A version differs | The two Postgres images are not from the same day. Read the extension's changelog if the first number differs. |
| `role settings` | A platform role has a setting this stack does not, or the reverse | Roles named `supabase_…` are each side's own |

At the real switch, with writes paused: `rows`, `accounts`, `sequences`, `buckets`, `files per bucket`, `file records`, `publication tables`, `functions` and `table grants` must all say `the same`, and each bucket's files `the same`. The only exceptions are the ones in the table above that do not say "in a rehearsal": a table left out on purpose under `rows`, and under `policies` a line that differs in nothing but its brackets. If `rows` differs in any other way then, something is still writing to the hosted project.

**`table grants` or `functions` differing by `anon` or `authenticated` is never expected.** It means objects are open to roles that should not reach them. Do not switch.

## When the data does not fit

`02-restore.sh` stops before loading anything and names what does not fit.

A table with no rows on the hosted side is never a problem: the script leaves its (empty) section out by itself and says so. What it stops for always holds rows.

- **`table X (N rows) does not exist here`.** The platform's Auth or Storage is newer than this release's. If the table belongs to a feature the app does not use, leave its rows behind:

  ```bash
  sudo ./02-restore.sh dumps/<folder> --skip-table auth.some_table
  ```

  If the app does use the feature, update the stack to a release that has the table ([updating](../README.md#updating-to-a-new-supabase-release)) and start again.
- **`column X does not exist here`.** The same cause, for one column of a table this release does have. Leave that column out; every row is still loaded, with its other columns:

  ```bash
  sudo ./02-restore.sh dumps/<folder> --skip-column auth.some_table.some_column
  ```

  The self-hosted service does not know the column, so nothing here reads it. What is lost is whatever the newer version on the platform kept in it.
- **`table X (N rows) cannot be written by the postgres role here`.** A table the services own and `postgres` may not fill. Look at what the rows are before choosing `--skip-table`.

Both flags can be given more than once, and together. Supabase's guide has the same two cases under "Version mismatches" and deals with both by cutting the table's section out of `data.sql` by hand. `--skip-table` does that; `--skip-column` keeps the rows.

**Leaving a whole table out can strand rows in another one.** The data is loaded with foreign keys unchecked, as the guide says. Leave out `auth.sessions`, say, and every refresh token is loaded pointing at a session that is not there. Nothing complains at the time, but that database can no longer be restored from its own backup. So the restore checks for exactly this before it commits, and rolls back with a line like `9 row(s) of auth.refresh_tokens point at rows of auth.sessions`. Then either leave that table out as well, or keep both and use `--skip-column` for the column that did not fit.

## Starting again

A restore needs an empty database, so a second rehearsal, and the real switch after a rehearsal, start by emptying the stack. This is the one place where data volumes are removed on purpose, by name:

```bash
cd /opt/native-intelligence/deploy/supabase/stack
```

```bash
sudo sh run.sh stop
```

```bash
sudo docker volume rm ni-supabase-db ni-supabase-storage
```

```bash
sudo sh run.sh start
```

`ni-supabase-db-config` and `ni-supabase-deno-cache` stay. **Never do this after the switch:** from then on these two volumes are production.

## When the move is over

```bash
sudo rm -rf /opt/native-intelligence/deploy/supabase/migrate/dumps /opt/native-intelligence/deploy/supabase/migrate/.env
```

and delete the S3 access key in the hosted dashboard.

## Settings for unusual cases

All optional, in `.env` or the environment. None is needed for the move as described.

| Setting | For |
| --- | --- |
| `SUPABASE_CLI` | The CLI under another name or path (default `supabase`) |
| `TARGET_DB_URL`, `TARGET_NETWORK`, `TARGET_S3_*` | A self-hosted stack other than the one in `../stack` |
| `SOURCE_NETWORK` | A source database that is not on the internet: the Docker network the `psql` container reaches it on |
| `MIGRATE_DOCKER_ARGS` | Extra `docker run` arguments for the `rclone` container only, for a source S3 endpoint it could not otherwise reach. The Supabase CLI (`01-dump.sh`) uses neither setting. |
| `PSQL_IMAGE`, `RCLONE_IMAGE` | Other versions of the two tools |

# Merge workspaces: verification scripts

The scripts the merge-workspaces work (docs/plans/merge-workspaces.md) was
verified with. None of them is run by the app or by CI; they are run by hand
against DEV (`edrjddsxjoigpbecqgfb`) or PROD (`bzfthjzyzevjokbuhqci`) with the
Supabase CLI. The probes are read-only; the end-to-end writes fixtures and rolls
everything back; `cron-timeout-probe.sql`, `job-scratch-fixtures.sql` and
`job-scratch-cleanup.sql` COMMIT on DEV (they refuse to run anywhere else).

## Running SQL against a project

The Supabase CLI (2.121 or newer) runs a file as ONE implicit transaction and
prints the last statement's rows as JSON. A `RAISE EXCEPTION` anywhere rolls the
whole file back and carries its message out, which is how the end-to-end stays
a dry run:

```bash
supabase db query --linked --project-ref edrjddsxjoigpbecqgfb -f scripts/merge-workspaces/export-probe.sql
```

(`--linked` with an explicit `--project-ref` is what worked; the CLI asks for a
login once. A migration file is applied the same way: `-f supabase/migrations/NNN_x.sql`,
DEV first, then PROD on Liam's word.)

The PostgREST probe needs the project's URL and service-role key from the
environment file (`.env.local` is DEV, `.env.production.local` is PROD; never
print them):

```bash
node scripts/merge-workspaces/postgrest-timeout-probe.mjs .env.local 12
```

## The files

| File | What it does |
|---|---|
| `e2e_body.sql` | The rolled-back end-to-end: two scratch workspaces with every collision class (people in both, teams that collide, a fold, labels by case, contacts by email, companies by domain, a mail account and thread copies, Linear on both sides and Jira on one, seeded Triage on both, home and bot threads, canon documents, views, a reminder, a device, a skill slug, plus migration 408's cases: enrollments on a folded and a moved contact, one the destination already runs for the same person, an action-only label meeting a universal one; and 417's: a running agent run still refuses, while a capture quiet for days, runs in needs_input and pr_open and a job waiting for review do not, and come over). And 707's: the default company stages on both sides (fold by name, a source-only stage moves after the destination's, a view filtering a stage follows it), a company's owner, stage, comments and email consent, team chat (a direct message between the same two people in both folds, one with someone only in the source is re-keyed, a channel named like a destination channel is suffixed, a folding team's channel follows it), reactions, threads, conversation and thread shares, a spreadsheet, a canvas and a drive folder made by a folded member, a vocabulary word, a day's auto-archive, a private thread and a booking profile in both, a grant to a folding team, a business phone number or a business profile on both sides and a demo workspace refusing; and the batch merged after 705: snippets (the same shared shortcut and text folds, other text and a personal clash take `-2`), a closed poll a folded member made and voted in, an import, the same inbox hold, CRM source link and GitHub repository in both, a booking link with a form. It checks the six refusal codes, the 408 guard's own refusal and 707's, runs the preflight and the merge, asserts ~150 outcomes, and ends with `RAISE EXCEPTION 'E2E PASSED …'` so nothing is kept. A merge that raises is the verdict too: `E2E FAILED: the merge raised <code> <message>`. Run it by appending it to the migration under test: `cat supabase/migrations/707_fix_workspace_merge.sql scripts/merge-workspaces/e2e_body.sql > /tmp/e2e.sql` (drop that file's own `commit;` line, so the run stays one rolled-back transaction; on a database that already has the migration, `begin;` and the body alone do), or on a local Postgres built by `scripts/db-bootstrap.sh`, `psql -v ON_ERROR_STOP=1 -f /tmp/e2e.sql` then `supabase db query … -f /tmp/e2e.sql`. The message that comes back is the verdict (`E2E PASSED` or `E2E FAILED: <the failed checks>`), with the counts and the identifier map. The fixture user ids are three real DEV users; on another database replace `u1`, `u2`, `u3` at the top. |
| `postgrest-timeout-probe-create.sql` / `-drop.sql` / `.mjs` | A temporary `_wsmerge_probe_sleep(seconds)` granted to `service_role`, a Node call through PostgREST that prints only status, elapsed seconds and the body, and the drop. Measured: 8.1 s cut before migration 407, 12.3 s and 70.3 s returned after it (so the service role's 120 s holds and nothing in front cuts at 60 s). Always run the drop afterwards. |
| `export-probe.sql` | `export_workspace_rows` (migration 407) on the DEV workspace with the most actions: a byte-cut page, its cursor, the next page, the one-row `workspace` table, a whole table in one page. |
| `export-composite-key-probe.sql` | The same on a table with a two-column primary key (`action_assignee`): the cursor carries both keys and the pages advance. |
| `export-grants-and-bucket.sql` | The export function is callable by `service_role` and not by `authenticated`, has one overload, and the `workspace-merges` bucket has its 50 MB limit and `application/json` type. |
| `table-sizes-per-workspace.sql` | Per exported table, the heaviest workspace's row count and JSON bytes (counts only). This is what showed a 5,000-row page of `claim_chunks` is ~95 MB on PROD. |
| `secret-looking-columns.sql` | Columns of exported tables whose names look like credentials; the export's exclusion pattern was written from this list. |
| `exported-tables-without-pk.sql` | Exported tables without a primary key (none on DEV or PROD; the export refuses one rather than paging by ctid). |
| `projects-team-column.sql` | Whether `projects.team_id` exists (019 dropped it; not on DEV) and every foreign key onto `team`, for migration 408's guard. |
| `cron-timeout-probe.sql` | DEV, temporary: two one-shot pg_cron jobs recording a cron session's default `statement_timeout` (`2min` on Supabase) and whether the runner's command (`SET statement_timeout = 0; …`) lets a job run 130 s (it does). Migration 417's runner depends on that SET. |
| `job-scratch-fixtures.sql` / `job-path-test.mjs` / `job-scratch-cleanup.sql` | DEV, committed then removed: two scratch workspaces, then the merge route's own calls through PostgREST as `service_role` (preflight, `merge_workspace_enqueue`, a duplicate that must be `P0010`, the job row until the pg_cron runner records `done` or `failed`), then the cleanup (also removes the probe's objects). The job path cannot run inside the rolled-back end-to-end: the runner commits in its own transaction. |

## Rehearsing on PROD

A real merge is rehearsed with `merge_workspace` itself inside one rolled-back transaction (the CLI's single implicit transaction, ended by a `RAISE EXCEPTION` carrying the result). Two limits shape it: the Management API cuts a request at about 100 s (HTTP 524) and gives its session a 2 min `statement_timeout`, so run one merge per call and cap it with `SET LOCAL statement_timeout = '85s'` and a `WHEN query_canceled` handler that reports how far it got. Report counts only for a workspace whose content must not be reported. Afterwards check that nothing stayed: the sources exist, `workspace_merge` has no new row, the destination's counts are unchanged.

## Open decision for the owner (707)

Migration 707 refuses a merge (P0008, before anything moves) when the two
workspaces cannot be combined automatically: a business phone number, a
connected website, a live website form key or a live customer booking page on
both sides, the same customer texting both, a customer booking at the same
time, or a quote with the same outside id. The preflight
(`merge_workspace_preflight`) does not list these yet: they show only as the
merge's error, naming what collides. Listing them as a preflight blocker
(a new code beside `source_busy` and `drift`, and its wording in
`src/lib/workspace-merge/wording.ts`) is a follow-up, not part of 707.

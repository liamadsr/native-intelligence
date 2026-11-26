-- ============================================================
-- 722: The person's archive here, on the mail index
-- ============================================================
-- NUMBER: 722 is the first free number after main's newest (721) when this
-- was written. Re-list main's migrations before merging, and renumber (the
-- file, this line, src/lib/email/local-archive.ts and its test,
-- src/lib/email/__tests__/migration-722.test.ts) if main took it meanwhile.
--
-- HOW TO APPLY: on the server's database, as the row "Apply a database
-- migration" in deploy/README.md says: piped into psql in the database
-- container, `-v ON_ERROR_STOP=1`, WITHOUT --single-transaction (it holds its
-- own begin/commit; with the flag it runs the same, psql only warning that a
-- transaction is already in progress). It ends by telling the data API to
-- reload its schema, so that row's second step is not needed.
--
-- ⛔ PROD ORDER: apply this BEFORE rolling out the app code that writes
-- these columns, or with it: the code tolerates the columns being absent
-- (every write drops them and goes again, every read goes without them), so
-- either order works, but the fix holds only once both are in. Applying it
-- early is harmless: both columns start empty, and empty means what happens
-- today.
--
-- Incoming's Done came back (Liam, 11-24 and 11-26: "I dismissed all the
-- notifications and they went through and Google updated, but then they all
-- came back again"). The index row's folder is what Incoming and Mail list,
-- and a mailbox sync could write "inbox" over the person's archive from an
-- answer that predated it. Two columns record the archive, so the sync can
-- tell (src/lib/email/local-archive.ts):
--
--   email_thread_index.local_archived_at          when the person (or the
--                                                 agent, a muted thread's
--                                                 re-archive) archived the
--                                                 thread here. Null: not
--                                                 archived here, or put back.
--   email_thread_index.local_archived_history_id  Gmail's historyId for the
--                                                 thread just after that
--                                                 archive (null for Outlook,
--                                                 or when Gmail gave none).
--
-- Set by the archive, cleared by a move back to the inbox here (Undo), and
-- by the sync when the mailbox shows the thread back in the inbox since (a
-- newer historyId, or a newer message). Ids and times only: no mail.
--
-- Two nullable columns with no default: a catalog change, no rewrite of the
-- table, so the lock is a moment, and the lock timeout caps the wait for it.
-- Access stays as the table has it (RLS on, the owner's policies): nothing
-- to grant.
--
-- Re-runnable, and a re-run is a no-op: add column if not exists; comments
-- repeat harmlessly.
--
-- Rolled back to code from before this change, the columns are simply not
-- read or written; rolling forward again uses them.
-- ============================================================

begin;

SET LOCAL lock_timeout = '5s';

alter table public.email_thread_index add column if not exists local_archived_at timestamptz;

alter table public.email_thread_index add column if not exists local_archived_history_id text;

comment on column public.email_thread_index.local_archived_at is
  'When the thread was archived in Native Intelligence (722); null: not archived here, or put back since. A sync puts the thread back in the inbox only with evidence it came back after this (src/lib/email/local-archive.ts).';

comment on column public.email_thread_index.local_archived_history_id is
  'Gmail''s historyId for the thread just after its archive here (722); a sync answer at or below it predates the archive. Null for Outlook, or when Gmail gave none.';

-- The data API (PostgREST) learns the new columns, delivered at commit.
notify pgrst, 'reload schema';

commit;

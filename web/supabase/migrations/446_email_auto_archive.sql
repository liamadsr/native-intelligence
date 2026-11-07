-- ============================================================
-- 446: the morning tidy (GEN-1166's optional loop)
-- ============================================================
-- A few minutes after a person's morning digest, Dial8 archives that day's
-- receipts and notifications from their inbox (src/lib/email/auto-archive.ts):
-- a server pass, no model, only while the workspace's Autonomy switch is on.
-- One message in the home thread says so, with Undo. Undo puts the batch
-- back, and from then on mail from its senders stays in the inbox.
--
-- What lands:
--   email_auto_archive     one row per pass that archived something, per
--                          (workspace, person, local date):
--     user_id              the mailbox owner (auth.users). The ONLY reader.
--     local_date           the person's date the digest was keyed on.
--     status               'running' (planned, archiving) | 'done'.
--     cutoff_at            the newest mail the pass looked at; the next pass
--                          starts after it, so a thread is looked at once.
--     thread_ids           the threads the pass planned to archive (at most 100).
--     archived_ids         the ones it did: what Undo puts back.
--     senders              the archived threads' sender addresses (lowercase):
--                          once a batch is undone, a later pass leaves mail
--                          from them in the inbox.
--     undone_at            when the person undid the batch.
-- Thread ids and addresses only, no mail text (no stored mail, 2026-10-15).
--
--   agent_log kind 'mail_archived'   the line the main chat reads ("Archived 14
--                          receipts and notifications from your inbox"), and
--                          the one Undo writes.
--
-- RLS: the owner reads their own rows while a member of the workspace; every
-- write is the service role's. Not in the realtime publication.
--
-- Idempotent: create table if not exists, drop constraint if exists + add,
-- drop policy if exists + create, create index if not exists; REVOKE/GRANT
-- restate the full privilege set. This file holds no backslash anywhere: one
-- MCP transport decodes escapes, so the applied SQL would differ from the file.
-- ============================================================

SET LOCAL lock_timeout = '5s';

create table if not exists public.email_auto_archive (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  local_date date not null,
  status text not null default 'running',
  cutoff_at timestamptz not null,
  thread_ids text[] not null default '{}',
  archived_ids text[] not null default '{}',
  senders text[] not null default '{}',
  undone_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.email_auto_archive drop constraint if exists email_auto_archive_status_check;
alter table public.email_auto_archive
  add constraint email_auto_archive_status_check check (status in ('running', 'done'));

alter table public.email_auto_archive drop constraint if exists email_auto_archive_size_check;
alter table public.email_auto_archive
  add constraint email_auto_archive_size_check
  check (cardinality(thread_ids) <= 100 and cardinality(archived_ids) <= 100 and cardinality(senders) <= 100);

-- One pass per person, workspace and day: a retried pass resumes this row.
alter table public.email_auto_archive drop constraint if exists email_auto_archive_day_key;
alter table public.email_auto_archive
  add constraint email_auto_archive_day_key unique (workspace_id, user_id, local_date);

-- The next pass's reads: the person's newest row (its cutoff), and their undone ones (kept senders).
create index if not exists email_auto_archive_recent_idx on public.email_auto_archive (workspace_id, user_id, created_at desc);

comment on table public.email_auto_archive is
  'The morning tidy (446): receipts and notifications archived after the morning digest, one row per person, workspace and day, with what Undo puts back. Thread ids and sender addresses only; readable by the mailbox owner; written by src/lib/email/auto-archive.ts.';

alter table public.email_auto_archive enable row level security;

drop policy if exists "email_auto_archive_select_own" on public.email_auto_archive;
create policy "email_auto_archive_select_own"
  on public.email_auto_archive for select
  to authenticated
  using ((select auth.uid()) = user_id and public.is_workspace_member(workspace_id));

revoke all on table public.email_auto_archive from anon, authenticated;
grant select on table public.email_auto_archive to authenticated;
grant all on table public.email_auto_archive to service_role;

-- ------------------------------------------------------------
-- The log line's kind
-- ------------------------------------------------------------

-- 'pr_changed' is 443's (the Now file's PR updates, PR 970), which rebuilds
-- this list too: either order leaves both kinds in.
alter table public.agent_log drop constraint if exists agent_log_kind_check;
alter table public.agent_log
  add constraint agent_log_kind_check
  check (kind in ('work_started', 'work_waiting', 'work_finished', 'work_failed', 'work_canceled', 'capture_processed', 'chat_checkpoint', 'doc_updated', 'pr_changed', 'mail_archived'));

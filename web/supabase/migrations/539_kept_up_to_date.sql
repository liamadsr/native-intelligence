-- ============================================================
-- 539: records kept up to date from email, meetings and texts
-- ============================================================
-- Tables phase 8 (src/lib/kept-up-to-date/). An arriving email, a finished
-- meeting or a customer's text is put beside the person's open to-dos and
-- the table rows linked to the people it involves (a pipeline row's Contacts
-- or Company relation). Jev's record.kept_up_to_date picks the ONE change it
-- states in plain words (a to-do done, a select set to an option, a date, a
-- number or an amount, a checkbox), or none. The change is applied as the
-- person's agent, with Undo on one message in the person's home thread.
--
-- A row's change goes through apply_data_ops with data_change.source
-- 'email', 'capture' or 'sms' (520's check already takes them) and a reason
-- that says only where it came from (never the source's words: the table's
-- history is every reader's). The quoted sentence lives here, the person's
-- own. This file adds the record of each change, and
-- the log kind.
--
-- What lands:
--   kept_change            one row per source and record, ever:
--     user_id              the person whose records these are (auth.users).
--                          The ONLY reader.
--     source               'email' | 'capture' | 'sms'.
--     source_ref           the source's own id: an email's thread and
--                          message ids, a capture's id, a text's message id.
--     source_label         who it came from in a word: a sender's domain,
--                          or null.
--     record_type          'action' (a to-do) or 'data_row' (a table's row).
--     record_id            the to-do or the row. Unique with the source: a
--                          retried pass changes nothing twice, and a source
--                          undone never changes that record again.
--     table_id, field_key  the row's table and the column set; null for a to-do.
--     from_value, to_value the value before and after (a to-do: its states).
--     prior_status_id, done_status_id
--                          a to-do's state before and the done state it was
--                          moved to: Undo moves it back only while it is
--                          still there.
--     data_change_id       a row's batch in the table's history: Undo takes
--                          back exactly that one.
--     evidence             the sentence quoted as the reason (at most 300).
--     undone_at            when the person undid it.
--
--   agent_log kind 'kept_up_to_date'   the line the main chat reads
--                          ("Updated Acme renewal: Stage → Won, from an email
--                          from acme.example"), and the one Undo writes.
--
-- RLS: the person reads their own rows while a member of the workspace;
-- every write is the service role's. Not in the realtime publication.
--
-- Idempotent: create table if not exists, drop constraint if exists + add,
-- drop policy if exists + create, create index if not exists; REVOKE/GRANT
-- restate the full privilege set. No backslash anywhere in this file.
-- ============================================================

SET LOCAL lock_timeout = '5s';

create table if not exists public.kept_change (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null,
  source_ref text not null,
  source_label text,
  record_type text not null,
  record_id uuid not null,
  table_id uuid references public.data_table (id) on delete cascade,
  field_key text,
  from_value jsonb,
  to_value jsonb,
  prior_status_id uuid references public.workflow_state (id) on delete set null,
  done_status_id uuid references public.workflow_state (id) on delete set null,
  data_change_id uuid references public.data_change (id) on delete set null,
  evidence text,
  undone_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.kept_change drop constraint if exists kept_change_source_check;
alter table public.kept_change
  add constraint kept_change_source_check check (source in ('email', 'capture', 'sms'));

alter table public.kept_change drop constraint if exists kept_change_record_type_check;
alter table public.kept_change
  add constraint kept_change_record_type_check check (record_type in ('action', 'data_row'));

alter table public.kept_change drop constraint if exists kept_change_size_check;
alter table public.kept_change
  add constraint kept_change_size_check
  check (
    length(source_ref) <= 1000
    and (source_label is null or length(source_label) <= 253)
    and (field_key is null or length(field_key) <= 40)
    and (evidence is null or length(evidence) <= 300)
  );

-- A row's change names its table and column; a to-do's names neither.
alter table public.kept_change drop constraint if exists kept_change_shape_check;
alter table public.kept_change
  add constraint kept_change_shape_check
  check (
    (record_type = 'data_row' and table_id is not null and field_key is not null)
    or (record_type = 'action' and table_id is null and field_key is null)
  );

-- One change per source and record, ever.
alter table public.kept_change drop constraint if exists kept_change_source_record_key;
alter table public.kept_change
  add constraint kept_change_source_record_key unique (source, source_ref, record_id);

-- A pass's read: what was changed before on the records it looks at.
create index if not exists kept_change_record_idx on public.kept_change (workspace_id, record_id);
create index if not exists kept_change_recent_idx on public.kept_change (workspace_id, user_id, created_at desc);

comment on table public.kept_change is
  'Records kept up to date from email, meetings and texts (539): one row per source and record, ever, with what Undo puts back. Readable by the person; written by src/lib/kept-up-to-date/engine.ts.';

alter table public.kept_change enable row level security;

drop policy if exists "kept_change_select_own" on public.kept_change;
create policy "kept_change_select_own"
  on public.kept_change for select
  to authenticated
  using ((select auth.uid()) = user_id and public.is_workspace_member(workspace_id));

revoke all on table public.kept_change from anon, authenticated;
grant select on table public.kept_change to authenticated;
grant all on table public.kept_change to service_role;

-- ------------------------------------------------------------
-- The log line's kind
-- ------------------------------------------------------------

-- 452's list plus 'kept_up_to_date'.
alter table public.agent_log drop constraint if exists agent_log_kind_check;
alter table public.agent_log
  add constraint agent_log_kind_check
  check (kind in ('work_started', 'work_waiting', 'work_finished', 'work_failed', 'work_canceled', 'capture_processed', 'chat_checkpoint', 'doc_updated', 'pr_changed', 'mail_archived', 'action_done_from_mail', 'look_ahead', 'kept_up_to_date'));

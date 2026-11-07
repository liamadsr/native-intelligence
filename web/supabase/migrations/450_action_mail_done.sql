-- ============================================================
-- 450: arriving mail marks a matching open to-do done
-- ============================================================
-- A confirmation that arrives (a booking, an order, a payment, a sign-up)
-- is put beside the person's own open to-dos (Jev's action.done_by_email,
-- src/lib/email/action-done-from-mail.ts). The one it clearly settles is
-- marked done, and one message in the home thread says so, with Undo. Undo
-- puts the to-do back where it was, and mail never closes it again.
--
-- What lands:
--   action_mail_done       one row per to-do mail closed, ever:
--     user_id              the mailbox owner (auth.users), whose to-do it is.
--                          The ONLY reader.
--     action_id            the to-do. Unique: mail closes a to-do once, so a
--                          to-do the person reopened (by Undo or by hand)
--                          stays open, and a retried pass closes nothing twice.
--     prior_status_id      where it was: what Undo puts it back to.
--     done_status_id       the done state it was moved to: Undo moves it back
--                          only while it is still there.
--     account_id, thread_id, message_id
--                          the mail that closed it (ids only).
--     sender_domain        its sender's domain, as the message says it.
--     undone_at            when the person undid it.
-- Ids and a domain only, no mail text (no stored mail, 2026-10-15).
--
--   agent_log kind 'action_done_from_mail'   the line the main chat reads
--                          ("Marked GEN-42 done: … (a confirmation from
--                          enterprise.com)"), and the one Undo writes.
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

create table if not exists public.action_mail_done (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  action_id uuid not null references public.actions (id) on delete cascade,
  prior_status_id uuid references public.workflow_state (id) on delete set null,
  done_status_id uuid references public.workflow_state (id) on delete set null,
  account_id uuid,
  thread_id text not null,
  message_id text not null,
  sender_domain text,
  undone_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.action_mail_done drop constraint if exists action_mail_done_size_check;
alter table public.action_mail_done
  add constraint action_mail_done_size_check
  check (length(thread_id) <= 500 and length(message_id) <= 500 and (sender_domain is null or length(sender_domain) <= 253));

-- Mail closes a to-do once, ever.
alter table public.action_mail_done drop constraint if exists action_mail_done_action_key;
alter table public.action_mail_done
  add constraint action_mail_done_action_key unique (action_id);

-- A pass's read: the person's to-dos mail already closed.
create index if not exists action_mail_done_recent_idx on public.action_mail_done (workspace_id, user_id, created_at desc);

comment on table public.action_mail_done is
  'Arriving mail marks a matching open to-do done (450): one row per to-do, ever, with where it was for Undo. Ids and a sender domain only; readable by the owner; written by src/lib/email/action-done-from-mail.ts.';

alter table public.action_mail_done enable row level security;

drop policy if exists "action_mail_done_select_own" on public.action_mail_done;
create policy "action_mail_done_select_own"
  on public.action_mail_done for select
  to authenticated
  using ((select auth.uid()) = user_id and public.is_workspace_member(workspace_id));

revoke all on table public.action_mail_done from anon, authenticated;
grant select on table public.action_mail_done to authenticated;
grant all on table public.action_mail_done to service_role;

-- ------------------------------------------------------------
-- The log line's kind
-- ------------------------------------------------------------

-- 446's list plus 'action_done_from_mail'.
alter table public.agent_log drop constraint if exists agent_log_kind_check;
alter table public.agent_log
  add constraint agent_log_kind_check
  check (kind in ('work_started', 'work_waiting', 'work_finished', 'work_failed', 'work_canceled', 'capture_processed', 'chat_checkpoint', 'doc_updated', 'pr_changed', 'mail_archived', 'action_done_from_mail'));

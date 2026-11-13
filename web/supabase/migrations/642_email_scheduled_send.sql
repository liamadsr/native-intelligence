-- Migration 642: send later. A person's own message, saved as a draft in the
-- mailbox they picked, sent by the app at the time they chose.
--
-- The message itself is never stored here (no mail text in the database since
-- 344): it waits in the person's mailbox as a provider draft, and a row here
-- says which draft, from which mailbox, and when. The row names the draft by
-- the id that survives edits: at Gmail the DRAFT's own id (`r-...`, a draft's
-- message id changes each time it is saved), at Graph the message id (a Graph
-- draft keeps its id). `to_emails` and `subject` are only for the Scheduled
-- folder's list, and are cleared once the message is sent.
--
-- email_draft.scheduled_send_at (034) is NOT this: that table is the agent's
-- drafts, which expire (draft-expiry.ts deletes their provider drafts).
--
-- How it is sent (src/lib/email/scheduled-send.ts): an Inngest event timed at
-- send_at, and a sweep every 5 minutes (/api/cron/email-scheduled-send) for
-- any due row it missed. Each takes the row from 'scheduled' to 'sending'
-- with one conditional update before anything goes out, so a row is sent at
-- most once whoever gets to it first; then 'sent', or 'failed' with a short
-- reason (the person is told with an 'email_send_failed' notification).
-- 'cancelled' is Undo, or Cancel in the Scheduled folder: the draft stays in
-- the mailbox, a normal draft.
--
-- RLS: the owner reads their own rows (user_id = auth.uid()); nothing else
-- reads them, and only the server writes them (the service role, after the
-- routes check the row and the mailbox are the caller's own): there are no
-- insert, update or delete policies, and those grants are revoked.
--
-- Also adds the notification type 'email_send_failed' (572's list, plus it).
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word,
-- before the code that uses it is rolled out.
--
-- Pinned by src/lib/email/__tests__/migration-642.test.ts. Re-runnable.

SET LOCAL lock_timeout = '5s';

create table if not exists public.email_scheduled_send (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.connected_account(id) on delete cascade,
  provider text not null,
  provider_draft_id text not null,
  thread_id text null,
  to_emails text[] null,
  subject text null,
  send_at timestamptz not null,
  status text not null default 'scheduled',
  error text null,
  sent_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint email_scheduled_send_provider_check check (provider in ('google', 'microsoft')),
  constraint email_scheduled_send_status_check check (status in ('scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  constraint email_scheduled_send_draft_id_check check (char_length(provider_draft_id) between 1 and 512),
  constraint email_scheduled_send_error_check check (error is null or char_length(error) <= 300)
);

comment on table public.email_scheduled_send is
  'Send later (642): a provider draft in the person''s own mailbox, sent at send_at. No mail text; to_emails and subject only until sent.';

-- The sweep: due rows, oldest first.
create index if not exists email_scheduled_send_due_idx
  on public.email_scheduled_send (send_at)
  where status in ('scheduled', 'sending');

-- The Scheduled folder: a person's rows in a workspace.
create index if not exists email_scheduled_send_owner_idx
  on public.email_scheduled_send (user_id, workspace_id, send_at);

create index if not exists email_scheduled_send_account_idx
  on public.email_scheduled_send (account_id);

alter table public.email_scheduled_send enable row level security;

drop policy if exists "owner reads own scheduled sends" on public.email_scheduled_send;
create policy "owner reads own scheduled sends" on public.email_scheduled_send
  for select using (user_id = auth.uid());

revoke insert, update, delete on public.email_scheduled_send from anon, authenticated;
grant select on public.email_scheduled_send to authenticated;
grant all on public.email_scheduled_send to service_role;

-- ── A scheduled send that failed: its owner is told ─────────────────────────

alter table public.notification drop constraint if exists notification_type_check;
alter table public.notification add constraint notification_type_check check (type = any (array[
  'action_assigned', 'action_unassigned', 'action_status_changed', 'capture_shared', 'comment_added',
  'comment_reply', 'decision_confirmed', 'cycle_started', 'project_status_changed', 'meeting_starting_soon',
  'contact_followup_due', 'flow_run_output', 'reminder', 'work_needs_you', 'work_failed', 'agent_digest',
  'workspace_merged', 'agent_check_in', 'agent_look_ahead', 'agent_message', 'team_chat_message',
  'meeting_waiting', 'email_send_failed'
])) not valid;
alter table public.notification validate constraint notification_type_check;

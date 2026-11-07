-- Meeting changes from the calendar (docs/plans/email-through-the-agent.md E4;
-- Liam, 2026-10-20: "the meeting you had at 4 p.m. got canceled").
--
-- agent_meeting_watch  what the 5-minute meeting pass last saw of each
--                      person's next 24 hours of provider meetings, so the
--                      next pass can tell a meeting was cancelled, went
--                      missing or moved (src/lib/agent-events/meeting-changes.ts).
--                      Server only: no policy, no grant but service_role.
--                      Its workspace column is pass_workspace_id, not
--                      workspace_id, on purpose: it is a per-pass cache, so a
--                      workspace merge (402, docs/plans/merge-workspaces.md)
--                      must not re-stamp it (one calendar linked to both
--                      workspaces would collide on the key and roll the merge
--                      back). The merge's delete of the source workspace drops
--                      its rows (cascade); the next pass rebuilds them.
-- agent_event_kind_check  dropped and re-added with 'meeting.changed'.
--
-- Additive and idempotent. 403 and 404 are taken (main; an open branch).

create table if not exists public.agent_meeting_watch (
  pass_workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- sha256 of the meeting's source and provider id, 40 hex (upcoming-meetings.ts meetingKey).
  meeting_key text not null check (char_length(meeting_key) between 1 and 64),
  account_id uuid not null references public.connected_account(id) on delete cascade,
  event_id text not null check (char_length(event_id) between 1 and 300),
  title text check (title is null or char_length(title) <= 200),
  start_at timestamptz not null,
  -- How many people besides the person were invited (rooms left out).
  attendee_count integer not null default 0 check (attendee_count between 0 and 10000),
  -- The person organizes it: their own change is never news to them.
  mine boolean not null default false,
  last_seen_at timestamptz not null default now(),
  primary key (pass_workspace_id, user_id, meeting_key)
);

create index if not exists agent_meeting_watch_start_idx on public.agent_meeting_watch (start_at);

alter table public.agent_meeting_watch enable row level security;
revoke all on table public.agent_meeting_watch from anon, authenticated;
grant all on table public.agent_meeting_watch to service_role;

alter table public.agent_event drop constraint if exists agent_event_kind_check;
alter table public.agent_event
  add constraint agent_event_kind_check check (kind in ('email.drafted', 'email.needs_reply', 'email.suspicious', 'capture.processed', 'meeting.soon', 'work.needs_input', 'work.needs_review', 'work.approval', 'work.done', 'work.failed', 'mention', 'activity', 'reminder.due', 'contact.followup_due', 'sequence.failed', 'meeting.changed'));

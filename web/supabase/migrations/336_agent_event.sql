-- ============================================================
-- 336: the agent's inbox (A6 slices 1-3)
-- ============================================================
-- docs/plans/always-on-agent.md section 5 (the router), section 6b
-- (event.needs_person), decisions 6 and 13 and the Defaults block.
--
-- Things happen while the person is away: a draft is written, a meeting is
-- processed, a run waits on an answer or fails, a meeting is about to start,
-- someone comments on their action. Each producer writes ONE row here for one
-- (workspace, user), and the router (src/lib/agent-events/router.ts, an
-- Inngest function debounced per person) sorts each row into an outcome:
--   ignore  nothing to say (autonomy off, expired, a duplicate);
--   quiet   it waits for "while you were away" and the daily digest;
--   turn    a server turn in the home thread (reserved: no rule makes one yet);
--   notify  the agent speaks up through its face (a notice), or the recorder
--           already did and the router records that notice.
--
-- What lands:
--   agent_event            one row per thing that happened, for exactly one
--                          (workspace, user): the workspace walls hold
--                          (decision 2), nothing fans a row out.
--     user_id              auth.users, not member: like agent_log (329), a
--                          departed member's rows survive their removal.
--     source, kind         where it came from and what it is (the app's list:
--                          src/lib/agent-events/types.ts AGENT_EVENT_KINDS).
--     priority             0 (low) to 3 (urgent), set by the producer.
--     occurs_at            when it happens: a meeting's start, else when it
--                          happened.
--     expires_at           past this the router ignores it (a meeting that
--                          has started).
--     ref_type, ref_id     what it is about ('work_item', 'capture',
--                          'email_draft', 'email_thread', 'notification',
--                          'local_calendar_event').
--     facts                templated facts, capped at 4000 bytes: a clipped
--                          title or subject, counts, flags. Never a body, never
--                          raw untrusted text beyond a clipped title.
--     dedupe_key           unique per (workspace, user): a retried producer or
--                          a replayed event writes nothing twice.
--     state                new (not routed yet), routed, delivered (shown in
--                          "while you were away" or a digest), expired.
--     outcome              null while new; set by the router.
--     decided_by           'rule' today; 'jev' once event.needs_person enforces.
--     jev_shadow           what Jev's event.needs_person would have picked
--                          (now, digest or ignore), stored, never applied.
--     notification_id      the notice that went out for it (the recorder's,
--                          or the router's own).
--     home_turn_id         the home turn that carried it (reserved).
--     delivered_key        what delivered it ('away:<message id>' or a digest
--                          key): a retried build re-reads the same rows.
--
--   member.time_zone       the person's IANA zone, saved by the chat spec from
--                          the browser's checked zone, for the 8:00 digest.
--                          Per membership: the digest is per workspace.
--
--   notification type      'agent_digest' joins the type check (the daily
--                          digest's bubble on the face, A6 slice 4).
--
-- home_turn.reason already allows 'event' and 'digest' (333): nothing widens.
--
-- Who may do what: a person reads only their own rows, and only while a
-- member of that workspace. Nobody writes from a client: the service role
-- (the producers, the router, the chat spec) is the only writer. Not in the
-- realtime publication.
--
-- Applied by hand, from this file: to DEV, and to PROD only on the owner's
-- word, BEFORE the PR whose code writes the table merges. Every writer fails
-- soft without it (a lost event is a gap, never a failed run). Additive and
-- idempotent: create if not exists, add column if not exists, drop policy if
-- exists, each check dropped and re-added. This file holds no backslash
-- anywhere: one MCP transport decodes escapes, so the applied SQL would differ
-- from the file.
-- ============================================================

SET LOCAL lock_timeout = '5s';

create table if not exists public.agent_event (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null,
  kind text not null,
  priority smallint not null default 1,
  occurs_at timestamptz not null default now(),
  expires_at timestamptz null,
  ref_type text null,
  ref_id text null,
  facts jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  state text not null default 'new',
  outcome text null,
  decided_by text null,
  jev_shadow jsonb null,
  notification_id uuid null,
  home_turn_id uuid null,
  routed_at timestamptz null,
  delivered_at timestamptz null,
  delivered_key text null,
  created_at timestamptz not null default now()
);

comment on table public.agent_event is
  'The agent''s inbox (336, A6): one row per thing that happened for one user in one workspace (a draft, a processed meeting, work waiting on them or failed, a meeting about to start, a mention), routed to ignore, quiet, turn or notify. Server-written only.';
comment on column public.agent_event.facts is
  'Templated facts (a clipped title or subject, counts, flags), never a body.';
comment on column public.agent_event.jev_shadow is
  'Jev event.needs_person in shadow: the pick (now, digest or ignore) and its probability. Stored, never applied.';
comment on column public.agent_event.delivered_key is
  'What delivered the row (away:<message id>, or a digest key): a retried build re-reads the same rows.';

alter table public.agent_event drop constraint if exists agent_event_source_check;
alter table public.agent_event
  add constraint agent_event_source_check check (source in ('email', 'capture', 'meeting', 'work', 'mention', 'digest'));

alter table public.agent_event drop constraint if exists agent_event_kind_check;
alter table public.agent_event
  add constraint agent_event_kind_check check (kind in ('email.drafted', 'email.needs_reply', 'email.suspicious', 'capture.processed', 'meeting.soon', 'work.needs_input', 'work.needs_review', 'work.approval', 'work.done', 'work.failed', 'mention'));

alter table public.agent_event drop constraint if exists agent_event_priority_check;
alter table public.agent_event
  add constraint agent_event_priority_check check (priority between 0 and 3);

alter table public.agent_event drop constraint if exists agent_event_facts_check;
alter table public.agent_event
  add constraint agent_event_facts_check check (jsonb_typeof(facts) = 'object' and octet_length(facts::text) <= 4000);

alter table public.agent_event drop constraint if exists agent_event_dedupe_key_check;
alter table public.agent_event
  add constraint agent_event_dedupe_key_check check (char_length(dedupe_key) between 1 and 300);

alter table public.agent_event drop constraint if exists agent_event_state_check;
alter table public.agent_event
  add constraint agent_event_state_check check (state in ('new', 'routed', 'delivered', 'expired'));

alter table public.agent_event drop constraint if exists agent_event_outcome_check;
alter table public.agent_event
  add constraint agent_event_outcome_check check (outcome is null or outcome in ('ignore', 'quiet', 'turn', 'notify'));

-- A new row has no outcome yet; every routed one has one.
alter table public.agent_event drop constraint if exists agent_event_outcome_state_check;
alter table public.agent_event
  add constraint agent_event_outcome_state_check check ((state = 'new') = (outcome is null));

alter table public.agent_event drop constraint if exists agent_event_decided_by_check;
alter table public.agent_event
  add constraint agent_event_decided_by_check check (decided_by is null or decided_by in ('rule', 'jev'));

alter table public.agent_event drop constraint if exists agent_event_jev_shadow_check;
alter table public.agent_event
  add constraint agent_event_jev_shadow_check check (jev_shadow is null or (jsonb_typeof(jev_shadow) = 'object' and octet_length(jev_shadow::text) <= 2000));

alter table public.agent_event drop constraint if exists agent_event_ref_check;
alter table public.agent_event
  add constraint agent_event_ref_check check ((ref_type is null or char_length(ref_type) <= 40) and (ref_id is null or char_length(ref_id) <= 300));

alter table public.agent_event drop constraint if exists agent_event_delivered_key_check;
alter table public.agent_event
  add constraint agent_event_delivered_key_check check (delivered_key is null or char_length(delivered_key) between 1 and 200);

-- One row per event per person and workspace.
create unique index if not exists agent_event_dedupe_idx
  on public.agent_event (workspace_id, user_id, dedupe_key);

-- One person's newest rows in one workspace.
create index if not exists agent_event_recent_idx
  on public.agent_event (workspace_id, user_id, created_at desc);

-- The router's read: rows not routed yet.
create index if not exists agent_event_new_idx
  on public.agent_event (workspace_id, user_id, created_at)
  where state = 'new';

-- "While you were away" and the digest: routed rows nobody has seen yet.
create index if not exists agent_event_undelivered_idx
  on public.agent_event (workspace_id, user_id, occurs_at desc)
  where delivered_at is null and outcome in ('quiet', 'notify');

alter table public.agent_event enable row level security;

drop policy if exists "agent_event_select" on public.agent_event;
create policy "agent_event_select"
  on public.agent_event for select
  to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- No insert, update or delete policy: only the service role writes.
revoke all on table public.agent_event from anon, authenticated;
grant select on table public.agent_event to authenticated;
grant all on table public.agent_event to service_role;

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agent_event'
  ) then
    alter publication supabase_realtime drop table public.agent_event;
  end if;
end $$;

-- ── member.time_zone ────────────────────────────────────────────────────────
-- An IANA zone name as the chat spec checked it (Intl accepted it): letters,
-- digits and _ + - / only, at most 64 characters. Null until the person chats.
alter table public.member add column if not exists time_zone text;

alter table public.member drop constraint if exists member_time_zone_check;
alter table public.member
  add constraint member_time_zone_check check (time_zone is null or time_zone ~ '^[A-Za-z0-9_+/-]{1,64}$');

comment on column public.member.time_zone is
  'The person''s IANA time zone (336), saved by the chat spec from the browser''s checked zone; read by the daily digest (A6). Null until known.';

-- ── The agent_digest notification type ─────────────────────────────────────
-- House pattern (172 / 197 / 200 / 224 / 273): DROP + full-enumeration ADD.
-- Widening only permits more values, so this applies cleanly with data present.
alter table public.notification drop constraint if exists notification_type_check;
alter table public.notification add constraint notification_type_check check (type = any (array[
  'action_assigned', 'action_unassigned', 'action_status_changed', 'action_priority_changed',
  'action_due_soon', 'action_overdue', 'action_mentioned', 'capture_processed', 'capture_shared',
  'comment_added', 'comment_reply', 'decision_confirmed', 'cycle_started', 'cycle_ending_soon',
  'share_comment_added', 'project_status_changed', 'meeting_starting_soon', 'followup_reminder',
  'contact_followup_due', 'relationship_going_stale', 'email_drafts_ready', 'feedback_requested',
  'flow_run_output', 'work_run_ready', 'work_run_input', 'reminder',
  'work_needs_you', 'work_failed',
  'agent_digest'
]));

-- Preference rows for existing members, in-app on / email off (the backfill
-- every type since migration 033 has used; a missing row reads as allowed).
insert into public.notification_preference (member_id, notification_type, in_app, email)
select m.id, 'agent_digest', true, false
from public.member m
on conflict (member_id, notification_type) do nothing;

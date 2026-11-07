-- ============================================================
-- 356: a meeting's goal, set by the person before the call
-- ============================================================
-- Decision, 2026-10-17 (Liam): when a meeting prep lands in the main chat, a
-- composer under its card asks "What's the goal of this call?". The goal can
-- also be set from the main chat ("the goal of my 2:30 is to close the
-- pilot", the set_meeting_goal tool), and later from the live HUD. It is kept
-- per meeting so the live agent and the HUD can read it once the call starts
-- (a later phase; nothing reads it during a call yet).
--
-- Calendar events are not rows (Google and Microsoft are read live), so the
-- goal is keyed by the meeting itself: its calendar event id and its start.
-- The start is part of the key because one id can stand for a whole series
-- (an EventKit event from the desktop's local calendar), and a goal is for
-- one occurrence. The pending capture, when one stands for the meeting, is
-- kept beside it, so a capture finds its goal directly (the app's lookup
-- also matches a capture's calendar_event_id and start:
-- src/lib/meetings/meeting-goal.ts).
--
-- A goal is private to the person who set it: only they read or write it,
-- and only in a workspace they belong to. Server reads (the chat tool, the
-- live agent later) run on the service role and fence on the person.
--
-- What changes:
--   meeting_goal   NEW table: workspace, person, calendar event id, start,
--                  pending capture (set null when it goes), the goal (1 to
--                  500 characters), where it was set (prep_card, chat or
--                  hud), created/updated times. One goal per person per
--                  meeting (unique on workspace, person, event, start).
--   meeting_goal_capture_idx   NEW partial index: a capture's goal.
--   meeting_goal_updated_at    NEW trigger: public.update_updated_at() (013).
--   RLS            owner-only select, insert, update and delete, each with
--                  public.is_workspace_member (the 321 pattern).
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word.
-- Without it the composer and set_meeting_goal fail to save (the table is
-- missing) and get_meeting_prep reads no goal; nothing else changes.
--
-- Idempotent: create if not exists, drop policy / trigger if exists before
-- creating them, revoke/grant restate the full privilege set. This file holds
-- no backslash anywhere: one MCP transport decodes escapes, so the applied SQL
-- would differ from the file.
-- ============================================================

SET LOCAL lock_timeout = '5s';

create table if not exists public.meeting_goal (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The provider's event id (get_calendar_events' id), or the local event's external id.
  calendar_event_id text not null,
  -- The occurrence's start: with the event id, the meeting.
  starts_at timestamptz not null,
  -- The pending capture standing for the meeting, when one does.
  capture_id uuid references public.captures(id) on delete set null,
  goal text not null,
  source text not null default 'prep_card',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meeting_goal_goal_check check (char_length(btrim(goal)) between 1 and 500),
  constraint meeting_goal_source_check check (source in ('prep_card', 'chat', 'hud')),
  constraint meeting_goal_event_id_check check (char_length(calendar_event_id) between 1 and 300),
  constraint meeting_goal_meeting_key unique (workspace_id, user_id, calendar_event_id, starts_at)
);

comment on table public.meeting_goal is
  'A meeting''s goal (356), set by the person before the call: from the prep card''s composer, the main chat (set_meeting_goal) or the HUD. Keyed by calendar event id and start; private to the person who set it.';

-- A capture's goal (the live agent and the HUD, by capture).
create index if not exists meeting_goal_capture_idx
  on public.meeting_goal (workspace_id, capture_id)
  where capture_id is not null;

drop trigger if exists meeting_goal_updated_at on public.meeting_goal;
create trigger meeting_goal_updated_at
  before update on public.meeting_goal
  for each row execute function public.update_updated_at();

alter table public.meeting_goal enable row level security;

drop policy if exists "meeting_goal_select" on public.meeting_goal;
create policy "meeting_goal_select"
  on public.meeting_goal for select
  to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

drop policy if exists "meeting_goal_insert" on public.meeting_goal;
create policy "meeting_goal_insert"
  on public.meeting_goal for insert
  to authenticated
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

drop policy if exists "meeting_goal_update" on public.meeting_goal;
create policy "meeting_goal_update"
  on public.meeting_goal for update
  to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

drop policy if exists "meeting_goal_delete" on public.meeting_goal;
create policy "meeting_goal_delete"
  on public.meeting_goal for delete
  to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- A person reads and writes only their own goals (the policies above);
-- Supabase's default grants (truncate, trigger, references…) go. Re-runnable.
revoke all on table public.meeting_goal from anon, authenticated;
grant select, insert, update, delete on table public.meeting_goal to authenticated;

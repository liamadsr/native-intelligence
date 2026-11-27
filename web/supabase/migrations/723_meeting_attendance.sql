-- ============================================================
-- 723: Your agent joins a meeting for you (meeting_attendance)
-- ============================================================
-- NUMBER: 723 is the first free number after main's newest (722) when this
-- was written. Re-list main's migrations before merging, and renumber (the
-- file, this line, src/lib/meeting-agent/store.ts and
-- src/lib/meeting-agent/__tests__/migration-723.test.ts) if main took it meanwhile.
--
-- HOW TO APPLY: on the server's database, as the row "Apply a database
-- migration" in deploy/README.md says: piped into psql in the database
-- container, `-v ON_ERROR_STOP=1`, WITHOUT --single-transaction (it holds its
-- own begin/commit; with the flag it runs the same, psql only warning that a
-- transaction is already in progress). It ends by telling the data API to
-- reload its schema, so that row's second step is not needed.
--
-- ⛔ PROD ORDER: apply this BEFORE turning MEETING_AGENT on. With the setting
-- off (the default) nothing reads or writes the table, so applying it early
-- is harmless, and code rolled out without it changes nothing.
--
-- Roadmap #12 (Liam, 11-27: "let's do it"; docs/plans/agent-joins-meetings.md):
-- the person sends their agent to one meeting with a brief they approved.
-- It dials in under its own announced name ("<Name>'s assistant (AI)"),
-- speaks only from the brief, asks the person when something needs them,
-- and leaves the notes as a capture.
--
-- Calendar events are not rows, so an attendance is keyed by the meeting
-- itself, as 356's meeting_goal is: (workspace, person, calendar event id,
-- start). One per person per meeting.
--
-- What changes:
--   meeting_attendance   NEW table: whose meeting, its status, how it joins
--                        (the dial-in number and its PIN digits), the brief
--                        and when it was approved, the name it says, the
--                        capture its notes go to, the call's ids, the one-time
--                        join token's hash (never the token), the asks it put
--                        to the person, and the moments of the call.
--   meeting_attendance_due_idx   NEW partial index: the scheduled ones by start.
--   meeting_attendance_updated_at   NEW trigger: public.update_updated_at() (013).
--   RLS                  owner-only select, insert, update and delete, each
--                        with public.is_workspace_member (the 356 pattern).
--                        The server works on the service role, fenced on the
--                        person in the code.
--
-- A dial-in PIN is the meeting's own secret; it is the person's, like the rest
-- of the row, and nobody else reads it (RLS, and the code never logs it).
--
-- Re-runnable: create if not exists, drop trigger / policy if exists before
-- creating them, revoke/grant restate the full privilege set. This file holds
-- no backslash anywhere: one MCP transport decodes escapes, so the applied SQL
-- would differ from the file.
--
-- Rolled back to code from before this change, the table is simply not read;
-- rolling forward again uses it.
-- ============================================================

begin;

SET LOCAL lock_timeout = '5s';

create table if not exists public.meeting_attendance (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The provider's event id (get_calendar_events' id), or the local event's external id.
  calendar_event_id text not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  title text not null default '',
  status text not null default 'draft',
  status_detail text,
  status_at timestamptz not null default now(),
  join_method text not null default 'dial_in',
  -- E.164.
  dial_in_number text,
  -- DTMF: digits, # and *, and w (half a second's wait).
  dial_in_pin text,
  -- { goals, may_share, ask, must_not_agree }: each a list of short lines.
  brief jsonb not null default '{}'::jsonb,
  brief_approved_at timestamptz,
  -- What it calls itself: "<Name>'s assistant (AI)".
  display_name text not null,
  owner_first_name text not null,
  capture_id uuid references public.captures(id) on delete set null,
  live_session_id text,
  twilio_call_sid text,
  -- sha256 (hex) of the one-time token the outbound leg carries; cleared once the call is answered.
  join_token_hash text,
  -- The questions it put to the person: [{ at, question, message_id }].
  asks jsonb not null default '[]'::jsonb,
  dial_started_at timestamptz,
  joined_at timestamptz,
  announced_at timestamptz,
  objected_at timestamptz,
  left_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meeting_attendance_status_check check (status in ('draft', 'scheduled', 'dialling', 'in_meeting', 'ended', 'cancelled', 'failed', 'objected')),
  constraint meeting_attendance_join_method_check check (join_method in ('dial_in')),
  constraint meeting_attendance_event_id_check check (char_length(calendar_event_id) between 1 and 300),
  constraint meeting_attendance_title_check check (char_length(title) <= 300),
  constraint meeting_attendance_number_check check (dial_in_number is null or dial_in_number ~ '^[+][1-9][0-9]{6,14}$'),
  constraint meeting_attendance_pin_check check (dial_in_pin is null or dial_in_pin ~ '^[0-9#*w]{1,64}$'),
  constraint meeting_attendance_brief_check check (jsonb_typeof(brief) = 'object' and pg_column_size(brief) <= 16384),
  constraint meeting_attendance_asks_check check (jsonb_typeof(asks) = 'array'),
  constraint meeting_attendance_name_check check (char_length(display_name) between 1 and 80 and char_length(owner_first_name) between 1 and 40),
  constraint meeting_attendance_detail_check check (status_detail is null or char_length(status_detail) <= 80),
  -- Nothing dials without an approved brief and a number.
  constraint meeting_attendance_ready_check check (status in ('draft', 'cancelled') or (brief_approved_at is not null and dial_in_number is not null)),
  constraint meeting_attendance_meeting_key unique (workspace_id, user_id, calendar_event_id, starts_at)
);

comment on table public.meeting_attendance is
  'Your agent attends a meeting for you (723, roadmap #12): one per person per meeting (calendar event id and start), with the brief they approved, how it dials in, and how the call went. Private to the person.';

-- The scheduler's read: what is due to dial.
create index if not exists meeting_attendance_due_idx
  on public.meeting_attendance (starts_at)
  where status = 'scheduled';

-- The webhook's match on the one-time token.
create unique index if not exists meeting_attendance_token_idx
  on public.meeting_attendance (join_token_hash)
  where join_token_hash is not null;

drop trigger if exists meeting_attendance_updated_at on public.meeting_attendance;
create trigger meeting_attendance_updated_at
  before update on public.meeting_attendance
  for each row execute function public.update_updated_at();

alter table public.meeting_attendance enable row level security;

drop policy if exists "meeting_attendance_select" on public.meeting_attendance;
create policy "meeting_attendance_select"
  on public.meeting_attendance for select
  to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

drop policy if exists "meeting_attendance_insert" on public.meeting_attendance;
create policy "meeting_attendance_insert"
  on public.meeting_attendance for insert
  to authenticated
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

drop policy if exists "meeting_attendance_update" on public.meeting_attendance;
create policy "meeting_attendance_update"
  on public.meeting_attendance for update
  to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

drop policy if exists "meeting_attendance_delete" on public.meeting_attendance;
create policy "meeting_attendance_delete"
  on public.meeting_attendance for delete
  to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- A person reads and writes only their own (the policies above); Supabase's
-- default grants (truncate, trigger, references…) go. Re-runnable.
revoke all on table public.meeting_attendance from anon, authenticated;
grant select, insert, update, delete on table public.meeting_attendance to authenticated;

-- The data API (PostgREST) learns the new table, delivered at commit.
notify pgrst, 'reload schema';

commit;

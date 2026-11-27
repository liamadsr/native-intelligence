-- ============================================================
-- 727: Your agent attends a recurring meeting for you (meeting_attendance_series)
-- ============================================================
-- NUMBER: 727 was assigned by the managing session (11-27): main holds 724
-- to 726. Re-list main's migrations before merging, and renumber (the file,
-- this line, src/lib/meeting-agent/series.ts and
-- src/lib/meeting-agent/__tests__/migration-727.test.ts) if main took it meanwhile.
--
-- HOW TO APPLY: on the server's database, as the row "Apply a database
-- migration" in deploy/README.md says: piped into psql in the database
-- container, `-v ON_ERROR_STOP=1`, WITHOUT --single-transaction (it holds its
-- own begin/commit; with the flag it runs the same, psql only warning that a
-- transaction is already in progress). It ends by telling the data API to
-- reload its schema, so that row's second step is not needed.
--
-- ⛔ PROD ORDER: after 723 (it references meeting_attendance), and BEFORE the
-- code that sends the agent to a series runs with MEETING_AGENT on. With the
-- setting off nothing reads or writes these, so applying it early is harmless.
--
-- Roadmap #12 phase 2 (docs/plans/agent-joins-meetings.md §2): "The person
-- opts in per meeting, or per recurring meeting, explicitly." One approval
-- covers a series: the person approves the brief once, every later occurrence
-- on their calendar is sent with it (a sweep schedules each a day and a half
-- ahead, src/lib/meeting-agent/series.ts), each one is listed with the rest,
-- and "skip this one" is a cancel of that occurrence, which the sweep never
-- sends again. Pausing or removing the series stops the sweep.
--
-- What changes:
--   meeting_attendance_series   NEW table: whose series (the provider's
--                               series master id), its title, the approved
--                               brief, an optional dial-in the person gave for
--                               every occurrence, paused_at. One per person
--                               per series. Owner-only RLS (the 723 pattern).
--   meeting_attendance.series_ref   NEW nullable column: the series an
--                               occurrence was sent by (set null when the
--                               series goes).
--   meeting_attendance_series_merge_fold   NEW trigger and function: during
--                               a workspace merge, a moving series the person
--                               has there too takes a -merged- suffix (723's way).
--   meeting_attendance_series_updated_at   NEW trigger: update_updated_at() (013).
--
-- Re-runnable: create if not exists, add column if not exists, drop trigger /
-- policy if exists before creating them, revoke/grant restate the full
-- privilege set. This file holds no backslash anywhere.
--
-- Rolled back to code from before this change, the table and column are
-- simply not read; rolling forward again uses them.
-- ============================================================

begin;

SET LOCAL lock_timeout = '5s';

create table if not exists public.meeting_attendance_series (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Google's recurringEventId, Microsoft's seriesMasterId.
  series_id text not null,
  title text not null default '',
  -- { goals, may_share, ask, must_not_agree }, as 723's brief.
  brief jsonb not null default '{}'::jsonb,
  brief_approved_at timestamptz not null,
  -- The person's own dial-in for every occurrence; null: each occurrence's invite.
  dial_in_number text,
  dial_in_pin text,
  paused_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meeting_attendance_series_id_check check (char_length(series_id) between 1 and 300),
  constraint meeting_attendance_series_title_check check (char_length(title) <= 300),
  constraint meeting_attendance_series_number_check check (dial_in_number is null or dial_in_number ~ '^[+][1-9][0-9]{6,14}$'),
  constraint meeting_attendance_series_pin_check check (dial_in_pin is null or dial_in_pin ~ '^[0-9#*w]{1,64}$'),
  constraint meeting_attendance_series_dial_in_check check ((dial_in_number is null) = (dial_in_pin is null)),
  constraint meeting_attendance_series_brief_check check (jsonb_typeof(brief) = 'object' and pg_column_size(brief) <= 16384),
  constraint meeting_attendance_series_key unique (workspace_id, user_id, series_id)
);

comment on table public.meeting_attendance_series is
  'Your agent attends every occurrence of a recurring meeting for you (727, roadmap #12): the person approved its brief once; a sweep sends each occurrence ahead of time. Private to the person.';

-- The sweep's read: the series that are on.
create index if not exists meeting_attendance_series_active_idx
  on public.meeting_attendance_series (created_at)
  where paused_at is null;

alter table public.meeting_attendance add column if not exists series_ref uuid references public.meeting_attendance_series(id) on delete set null;

comment on column public.meeting_attendance.series_ref is
  'The series this occurrence was sent by (727); null: sent for this meeting alone.';

create index if not exists meeting_attendance_series_ref_idx
  on public.meeting_attendance (series_ref)
  where series_ref is not null;

drop trigger if exists meeting_attendance_series_updated_at on public.meeting_attendance_series;
create trigger meeting_attendance_series_updated_at
  before update on public.meeting_attendance_series
  for each row execute function public.update_updated_at();

alter table public.meeting_attendance_series enable row level security;

drop policy if exists "meeting_attendance_series_select" on public.meeting_attendance_series;
create policy "meeting_attendance_series_select"
  on public.meeting_attendance_series for select
  to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

drop policy if exists "meeting_attendance_series_insert" on public.meeting_attendance_series;
create policy "meeting_attendance_series_insert"
  on public.meeting_attendance_series for insert
  to authenticated
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

drop policy if exists "meeting_attendance_series_update" on public.meeting_attendance_series;
create policy "meeting_attendance_series_update"
  on public.meeting_attendance_series for update
  to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

drop policy if exists "meeting_attendance_series_delete" on public.meeting_attendance_series;
create policy "meeting_attendance_series_delete"
  on public.meeting_attendance_series for delete
  to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- A workspace merge moves every source row to the destination (707's
-- generic re-stamp). A series the same person has in both would meet
-- meeting_attendance_series_key and stop the merge, so during a merge
-- (_wsmerge_active) the moving one takes a suffix on its series id: both
-- stay, and the moved one matches no calendar series (the destination's
-- keeps sending). 723's meeting_attendance_merge_fold is the same way.
create or replace function public.meeting_attendance_series_merge_fold()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.workspace_id is distinct from old.workspace_id and public._wsmerge_active() then
    if exists (select 1 from public.meeting_attendance_series d
        where d.workspace_id = new.workspace_id and d.user_id = new.user_id and d.series_id = new.series_id and d.id <> old.id) then
      new.series_id := left(new.series_id, 280) || '-merged-' || left(replace(old.id::text, '-', ''), 8);
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.meeting_attendance_series_merge_fold() from public, anon, authenticated;

drop trigger if exists meeting_attendance_series_merge_fold on public.meeting_attendance_series;
create trigger meeting_attendance_series_merge_fold
  before update of workspace_id on public.meeting_attendance_series
  for each row execute function public.meeting_attendance_series_merge_fold();

revoke all on table public.meeting_attendance_series from anon, authenticated;
grant select, insert, update, delete on table public.meeting_attendance_series to authenticated;

-- The data API (PostgREST) learns the new table and column, delivered at commit.
notify pgrst, 'reload schema';

commit;

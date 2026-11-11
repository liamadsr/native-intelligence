-- 550: availability (phase 1): working hours and the calendars that count.
--
-- The availability engine (src/lib/availability/engine.ts) answers "when can
-- this person meet": their working hours minus their busy time.
--
--   1. availability_schedule      one row per person (the same in every
--                                 workspace): a weekly pattern of HH:MM
--                                 ranges, and dates whose hours replace that
--                                 whole day (an empty date is a day off).
--                                 time_zone is null until the person names
--                                 one: their hours then follow the zone they
--                                 are in (member.time_zone). No row at all
--                                 means weekdays 9 to 6
--                                 (src/lib/availability/schedule.ts).
--   2. calendar_sub_preference    counts_as_busy: the person's own choice for
--                                 one calendar. Null (every row today) keeps
--                                 the default: the primary calendar and the
--                                 other calendars they own count, calendars
--                                 they only follow don't
--                                 (src/lib/availability/busy.ts).
--
-- RLS on; a person reads their own hours; only the service role writes them
-- (the agent's set_working_hours, and the settings page through the server).
-- Re-runnable.
--
-- Must run on PROD before the app code that reads it deploys: every slot
-- read selects counts_as_busy.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. availability_schedule
-- ------------------------------------------------------------

create table if not exists public.availability_schedule (
  user_id uuid primary key references auth.users(id) on delete cascade,
  time_zone text null,
  weekly jsonb not null,
  overrides jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.availability_schedule is
  'A person''s working hours (550): weekly HH:MM ranges, Sunday first, and dated overrides. No row means weekdays 9 to 6 in their own zone.';

alter table public.availability_schedule drop constraint if exists availability_schedule_time_zone_check;
alter table public.availability_schedule
  add constraint availability_schedule_time_zone_check check (time_zone is null or time_zone ~ '^[A-Za-z0-9_+/-]{1,64}$');
alter table public.availability_schedule drop constraint if exists availability_schedule_weekly_check;
alter table public.availability_schedule
  add constraint availability_schedule_weekly_check check (jsonb_typeof(weekly) = 'array' and jsonb_array_length(weekly) = 7);
alter table public.availability_schedule drop constraint if exists availability_schedule_overrides_check;
alter table public.availability_schedule
  add constraint availability_schedule_overrides_check check (jsonb_typeof(overrides) = 'object');

-- ------------------------------------------------------------
-- 2. calendar_sub_preference.counts_as_busy
-- ------------------------------------------------------------

alter table public.calendar_sub_preference add column if not exists counts_as_busy boolean null;

comment on column public.calendar_sub_preference.counts_as_busy is
  'Whether this calendar''s events make the person busy (550). Null keeps the default: the primary and the calendars they own count, followed ones do not.';

-- ------------------------------------------------------------
-- 3. RLS and grants
-- ------------------------------------------------------------

alter table public.availability_schedule enable row level security;

drop policy if exists availability_schedule_select_own on public.availability_schedule;
create policy availability_schedule_select_own on public.availability_schedule
  for select to authenticated using (auth.uid() = user_id);

revoke all on table public.availability_schedule from anon, authenticated;
grant select on table public.availability_schedule to authenticated;
grant all on table public.availability_schedule to service_role;

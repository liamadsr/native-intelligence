-- 552: availability (phase 2): whether teammates may learn when a person is busy.
--
-- find_times can find a time for several members of one workspace
-- (src/lib/availability/team.ts): each person's working hours minus their
-- busy time, intersected. This is the one setting it needs, per person and
-- per workspace, on their member row:
--
--   member.availability_sharing   'busy_only' (the default): the other
--                                 members of that workspace may learn when
--                                 this person is busy, as blocks of time
--                                 only, never an event's title, place,
--                                 people or calendar. 'none': their time is
--                                 not shared; a request that includes them
--                                 comes back unknown for them ("they don't
--                                 share their availability").
--
-- Every existing member gets the default: nothing to set up before it works.
--
-- Who may change it: only the person, on their own row. The server writes it
-- with the service role (the settings page's route, the agent's
-- set_working_hours on the person's own turn). The member_update policy (306)
-- also lets an owner or admin update other members' rows from a client, so
-- a trigger keeps this one column the row's own user's: an admin can still
-- change a role, never someone else's sharing. Trusted callers skip it as in
-- 306's guard: the service role, or no request at all.
--
-- Re-runnable: add column if not exists, drop constraint if exists, create or
-- replace, drop trigger if exists.
--
-- Must run on PROD before the app code that reads it deploys: find_times
-- with people and Settings > Availability select availability_sharing.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. member.availability_sharing
-- ------------------------------------------------------------

-- A constant default: no table rewrite.
alter table public.member add column if not exists availability_sharing text not null default 'busy_only';

alter table public.member drop constraint if exists member_availability_sharing_check;
alter table public.member
  add constraint member_availability_sharing_check check (availability_sharing in ('busy_only', 'none'));

comment on column public.member.availability_sharing is
  'Whether the other members of this workspace may learn when this person is busy (552): busy_only (blocks of time only, never what an event is) or none.';

-- ------------------------------------------------------------
-- 2. Only the person changes their own sharing
-- ------------------------------------------------------------

create or replace function public.member_guard_availability_sharing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The server: the service role, or no request at all.
  if coalesce(auth.role(), '') in ('', 'service_role') then
    return new;
  end if;
  if new.availability_sharing is distinct from old.availability_sharing
     and old.user_id is distinct from auth.uid() then
    raise exception 'Only the person can change whether their availability is shared'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

revoke all on function public.member_guard_availability_sharing() from public, anon, authenticated;

drop trigger if exists member_guard_availability_sharing on public.member;
create trigger member_guard_availability_sharing
  before update of availability_sharing on public.member
  for each row execute function public.member_guard_availability_sharing();

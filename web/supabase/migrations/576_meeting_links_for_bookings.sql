begin;
SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 576: a meeting link as the place of a booked meeting (calls plan, phase 7,
-- with availability's booking links and time offers, 554, 581, 583).
--
-- Availability chooses where people meet with booking_link.video and
-- time_offer.video (the calendar provider's own video link, true by default)
-- and a free-text location. This adds one more choice beside them, off by
-- default: call_here, a meeting link of ours. A booking made from a link or an
-- offer with call_here gets a meeting (src/lib/meeting-links/bookings.ts,
-- through 574's meeting_create_for, its host the booking's host), whose link is
-- the calendar event's location and the booking's conference_url (what the
-- guest's /b and /t pages show); the provider's video link is not added then.
-- The guest opens the link and waits in the lobby as any guest does.
--
--   meeting.booking_id   the booking a meeting was made for (one meeting per
--                        booking); server only, never in the members' grant.
--   meeting_booking_changed(booking, starts, minutes, cancelled)
--                        the service role's: the booking moved (the meeting's
--                        window follows it, as 574's meeting_make sets one) or
--                        was cancelled or failed (the link is revoked as 574's
--                        meeting_revoke does: waiting guests let go, guests in
--                        its live call taken out).
--
-- Additive. Idempotent. Safe on a live database with the deployed app
-- running: two boolean columns with a constant default (no rewrite), a
-- nullable column on 573's meeting (empty in production) and a partial unique
-- index on it (built under the lock: the table is empty there), and one new
-- function. The deployed app never reads the new columns. lock_timeout bounds
-- the wait for each lock. No backslashes anywhere in this file (one MCP
-- transport decodes escapes).
-- ------------------------------------------------------------

alter table public.booking_link add column if not exists call_here boolean not null default false;
alter table public.time_offer add column if not exists call_here boolean not null default false;
comment on column public.booking_link.call_here is
  'Meet on a call here (576): each booking gets a meeting link of ours as its place, instead of the provider''s video link. Off by default.';
comment on column public.time_offer.call_here is
  'Meet on a call here (576): the booking gets a meeting link of ours as its place, instead of the provider''s video link. Off by default.';

alter table public.meeting add column if not exists booking_id uuid null references public.meeting_booking(id) on delete set null;
create unique index if not exists meeting_booking_id_key on public.meeting (booking_id) where booking_id is not null;
comment on column public.meeting.booking_id is
  'The booking this meeting was made for (576), one meeting per booking. Server only.';

create or replace function public.meeting_booking_changed(target_booking uuid, starts timestamptz, minutes integer, cancelled boolean)
returns table (meeting_id uuid, call_id uuid, room text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  m public.meeting%rowtype;
  live public.team_call%rowtype;
  length_min integer := coalesce(minutes, 30);
  ends timestamptz;
begin
  select * into m from public.meeting x where x.booking_id = target_booking;
  if not found then
    return;
  end if;
  -- The lock order of 574: the live call's row, then the meeting's, then its guests.
  select * into live from public.team_call t where t.channel_id = m.channel_id and t.status = 'live' for update;
  perform 1 from public.meeting x where x.id = m.id for update;
  if coalesce(cancelled, false) then
    if m.revoked_at is not null then
      return query select m.id, live.id, live.room;
      return;
    end if;
    update public.meeting x set revoked_at = now(), revoked_by = m.host_member_id where x.id = m.id;
    insert into public.team_call_eject (call_id, room, identity, reason)
    select t.id, t.room, 'guest-' || g.id::text, 'access'
      from public.meeting_guest g
      join public.team_call t on t.id = g.call_id and t.status = 'live'
     where g.meeting_id = m.id and (g.in_call or g.state = 'admitted')
    on conflict do nothing;
    update public.meeting_guest g
       set state = 'left', in_call = false, left_at = case when g.in_call then now() else g.left_at end
     where g.meeting_id = m.id and g.state in ('waiting', 'admitted');
    if live.id is not null then
      update public.team_call t
         set participant_count = public.team_call_people_now(t.id), updated_at = now()
       where t.id = live.id;
    end if;
    return query select m.id, live.id, live.room;
    return;
  end if;
  if starts is null or length_min not between 5 and 480 then
    raise exception 'meetings: a booking needs a start and a length' using errcode = '22023';
  end if;
  -- Moved: the window as 574's meeting_make sets one (15 minutes before, 2 hours after).
  ends := starts + make_interval(mins => length_min);
  update public.meeting x
     set starts_at = starts, ends_at = ends, opens_at = starts - interval '15 minutes', closes_at = ends + interval '2 hours'
   where x.id = m.id;
  return query select m.id, null::uuid, null::text;
end;
$$;

revoke all on function public.meeting_booking_changed(uuid, timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.meeting_booking_changed(uuid, timestamptz, integer, boolean) to service_role;

notify pgrst, 'reload schema';

commit;

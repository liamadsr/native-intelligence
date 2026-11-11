begin;
SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 585: a meeting link as the place of a booked meeting (calls plan, phase 7,
-- with availability's booking links and time offers, 554, 581, 583; numbered
-- after 584 because it alters 581's booking_link).
--
-- Availability chooses where people meet with booking_link.video and
-- time_offer.video (the calendar provider's own video link, true by default)
-- and a free-text location. This adds one more choice beside them, off by
-- default: call_here, a meeting link of ours. A booking made from a link or an
-- offer with call_here gets a meeting (src/lib/meeting-links/bookings.ts),
-- whose link is the calendar event's location and the booking's
-- conference_url (what the guest's /b and /t pages show).
--
--   meeting.booking_id     (573) the booking a meeting was made for: one
--                          meeting per booking (573's partial unique index).
--                          Server only, never in the members' grant; 574's
--                          daily allowance for a host's own links skips it.
--   meeting_create_for_booking(booking, ref, digest, nonce)
--                          the service role's: the booking's meeting, made and
--                          tied to it in one step, or the one it already has
--                          (the booking's row is locked first, so a retry or a
--                          second attempt at once finds it). Its host is the
--                          booking's host, its title, start and length the
--                          booking's. It does not count against the host's
--                          own daily allowance in 574's meeting_make: its
--                          bound is one per booking, and the booking features
--                          limit bookings. Nothing (no row) for a host no
--                          longer in the workspace or a booking longer than a
--                          meeting may be; refused for a booking no longer live.
--   meeting_booking_changed(booking, starts, minutes, cancelled)
--                          the service role's worker: moves the meeting's
--                          window (as 574's meeting_make sets one) or revokes
--                          its link (as 574's meeting_revoke does: waiting
--                          guests let go, guests in its live call on the eject
--                          outbox).
--   meeting_booking_follow (a trigger on meeting_booking)
--                          every writer of a booking's time or state (the
--                          time offers' and booking links' stores, the
--                          customers' tools, 581's move_meeting_booking, the
--                          sweeps) reaches its meeting here: a booking that
--                          becomes cancelled, failed, declined or expired, or
--                          is deleted, revokes its link; one put back live (a
--                          cancellation the calendar refused) gets it back; a
--                          live booking whose time changes moves the meeting's
--                          window. It never stops the booking's own write. The
--                          app only drains the eject outbox at once after a
--                          cancellation (taking guests out of the room is
--                          LiveKit's, not the database's).
--
-- Additive. Idempotent. Safe on a live database with the deployed app
-- running: two boolean columns with a constant default (no rewrite), three
-- new functions and two triggers on meeting_booking (brief locks:
-- lock_timeout bounds the wait). The deployed app never reads the new columns. No
-- backslashes anywhere in this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

alter table public.booking_link add column if not exists call_here boolean not null default false;
alter table public.time_offer add column if not exists call_here boolean not null default false;
comment on column public.booking_link.call_here is
  'Meet on a call here (585): each booking gets a meeting link of ours as its place, instead of the provider''s video link. Off by default.';
comment on column public.time_offer.call_here is
  'Meet on a call here (585): the booking gets a meeting link of ours as its place, instead of the provider''s video link. Off by default.';

comment on column public.meeting.booking_id is
  'The booking this meeting was made for (585), one meeting per booking (573''s unique index). Server only.';

create or replace function public.meeting_create_for_booking(booking_ref uuid, meeting_ref uuid, digest text, nonce text)
returns table (made_id uuid, made_nonce text, created boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.meeting_booking%rowtype;
  had public.meeting%rowtype;
  host uuid;
  title_now text;
  length_min integer;
  ends timestamptz;
  opens timestamptz;
  closes timestamptz;
  ch uuid;
begin
  -- The booking's row orders every attempt for it: one meeting per booking.
  select * into b from public.meeting_booking x where x.id = booking_ref for update;
  if not found then
    raise exception 'meetings: no such booking' using errcode = '22023';
  end if;
  select * into had from public.meeting x where x.booking_id = b.id;
  if found then
    return query select had.id, had.token_nonce, false;
    return;
  end if;
  if b.state not in ('requested', 'booking', 'confirmed') then
    raise exception 'meetings: that booking is not live' using errcode = '22023';
  end if;
  if meeting_ref is null or digest is null or char_length(digest) not between 40 and 128
     or nonce is null or char_length(nonce) not between 16 and 64 then
    raise exception 'meetings: no such link' using errcode = '22023';
  end if;
  select m.id into host from public.member m where m.user_id = b.host_user_id and m.workspace_id = b.workspace_id;
  length_min := round(extract(epoch from (b.ends_at - b.starts_at)) / 60)::integer;
  if host is null or length_min not between 5 and 480 then
    return;
  end if;
  title_now := left(regexp_replace(trim(coalesce(b.title, '')), '[[:space:]]+', ' ', 'g'), 80);
  if title_now = '' then
    title_now := 'Meeting';
  end if;
  ends := b.starts_at + make_interval(mins => length_min);
  opens := b.starts_at - interval '15 minutes';
  closes := ends + interval '2 hours';
  if closes <= now() then
    raise exception 'meetings: that time has passed' using errcode = '22023';
  end if;

  insert into public.team_chat_channel (workspace_id, kind, name, created_by)
  values (b.workspace_id, 'meeting', title_now, host)
  returning id into ch;
  insert into public.team_chat_member (channel_id, member_id, workspace_id) values (ch, host, b.workspace_id);
  insert into public.meeting (id, workspace_id, channel_id, host_member_id, title, token_hash, token_nonce, starts_at, ends_at, opens_at, closes_at, booking_id)
  values (meeting_ref, b.workspace_id, ch, host, title_now, digest, nonce, b.starts_at, ends, opens, closes, b.id);
  return query select meeting_ref, nonce, true;
end;
$$;

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

-- Every writer of a booking's time or state reaches its meeting here (see the header). Never stops the write.
create or replace function public.meeting_booking_follow()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  dead constant text[] := array['cancelled', 'failed', 'declined', 'expired'];
  length_min integer;
begin
  if tg_op = 'DELETE' then
    perform public.meeting_booking_changed(old.id, null, null, true);
    return old;
  end if;
  if not exists (select 1 from public.meeting x where x.booking_id = new.id) then
    return new;
  end if;
  if new.state = any (dead) then
    if not (old.state = any (dead)) then
      perform public.meeting_booking_changed(new.id, null, null, true);
    end if;
    return new;
  end if;
  if old.state = any (dead) then
    -- Put back live (a cancellation the calendar refused): its link works again.
    update public.meeting x set revoked_at = null, revoked_by = null where x.booking_id = new.id and x.revoked_at is not null;
  end if;
  if new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at then
    length_min := round(extract(epoch from (new.ends_at - new.starts_at)) / 60)::integer;
    if length_min between 5 and 480 then
      perform public.meeting_booking_changed(new.id, new.starts_at, length_min, false);
    end if;
  end if;
  return new;
exception when others then
  raise warning 'meetings: booking % not followed by its meeting: %', coalesce(new.id, old.id), sqlerrm;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists meeting_booking_follow on public.meeting_booking;
create trigger meeting_booking_follow
  after update of state, starts_at, ends_at on public.meeting_booking
  for each row execute function public.meeting_booking_follow();
drop trigger if exists meeting_booking_follow_delete on public.meeting_booking;
create trigger meeting_booking_follow_delete
  before delete on public.meeting_booking
  for each row execute function public.meeting_booking_follow();

revoke all on function public.meeting_create_for_booking(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.meeting_create_for_booking(uuid, uuid, text, text) to service_role;
revoke all on function public.meeting_booking_changed(uuid, timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.meeting_booking_changed(uuid, timestamptz, integer, boolean) to service_role;
revoke all on function public.meeting_booking_follow() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;

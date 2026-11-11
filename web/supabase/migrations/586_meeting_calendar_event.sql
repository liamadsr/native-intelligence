begin;
SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 586: where a scheduled meeting link's calendar event was written, and
-- whose event it is (calls plan, phase 7 follow-up).
--
-- A meeting made with a start time from team chat goes on its host's
-- calendar (src/lib/meeting-links/calendar-events.ts): on the connected
-- Google or Outlook account they chose (or their default), created once with
-- the meeting's id as its idempotency key, our link as its location. A
-- meeting added to an event the person made in the calendar's own dialog
-- ("Add a meeting link") is remembered the same way. These columns let a new
-- link, a revoke or an end keep that event in step on the SAME calendar, and
-- say how far the meeting may touch it:
--
--   meeting.calendar_event_id    the provider's event id (null: none)
--   meeting.calendar_account_id  the connected account it is on; set null
--                                when that account is disconnected (the
--                                updates then do nothing, quietly, and the
--                                app's calendar shows the meeting from this
--                                table instead)
--   meeting.calendar_event_kind  'meeting': the event the meeting link made
--                                for itself; the meeting owns it (a revoke
--                                removes it, a new link rewrites its link, an
--                                end shortens it). 'person': an event the
--                                person made and attached the link to; the
--                                meeting only ever swaps or removes its own
--                                link in it, never deletes it, never changes
--                                its times.
--
-- And meeting_revoke_as(meeting, acting user): the service role's revoke for
-- the app's calendar routes (a device signs in with a token the database
-- can't read as the person): the same as 574's meeting_revoke, for the
-- meeting's host only.
--
-- All server only: the columns are never in the members' column grant (573),
-- the function never the members'. A booking's meeting (585) never uses
-- them: its booking keeps its own event.
--
-- Additive. Idempotent. Safe on a live database with the deployed app
-- running: three nullable columns (no rewrite; the deployed app selects its
-- columns by name and never reads these) and one new function. lock_timeout
-- bounds the wait for the lock. No backslashes anywhere in this file (one MCP
-- transport decodes escapes).
-- ------------------------------------------------------------

alter table public.meeting add column if not exists calendar_event_id text;
alter table public.meeting add column if not exists calendar_account_id uuid references public.connected_account(id) on delete set null;
alter table public.meeting add column if not exists calendar_event_kind text check (calendar_event_kind is null or calendar_event_kind in ('meeting', 'person'));
comment on column public.meeting.calendar_event_id is
  'The provider event a scheduled meeting link is on its host''s calendar as (586). Server only.';
comment on column public.meeting.calendar_account_id is
  'The connected account that event is on (586); null when there is none or the account was disconnected. Server only.';
comment on column public.meeting.calendar_event_kind is
  'meeting: the event the link made for itself (the meeting owns it); person: an event the person made and attached the link to (the meeting only swaps or removes its link). 586. Server only.';

create or replace function public.meeting_revoke_as(target_meeting uuid, acting_user uuid)
returns table (revoked boolean, call_id uuid, room text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  m public.meeting%rowtype;
  live public.team_call%rowtype;
begin
  select * into m from public.meeting x where x.id = target_meeting;
  if not found or m.host_member_id is null
     or not exists (select 1 from public.member p where p.id = m.host_member_id and p.user_id = acting_user) then
    raise exception 'meetings: only the host can revoke the link' using errcode = '42501';
  end if;
  -- The lock order of 574: the live call's row, then the meeting's, then its guests.
  select * into live from public.team_call t where t.channel_id = m.channel_id and t.status = 'live' for update;
  perform 1 from public.meeting x where x.id = m.id for update;
  if m.revoked_at is not null then
    return query select false, live.id, live.room;
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
  return query select true, live.id, live.room;
end;
$$;

revoke all on function public.meeting_revoke_as(uuid, uuid) from public, anon, authenticated;
grant execute on function public.meeting_revoke_as(uuid, uuid) to service_role;

notify pgrst, 'reload schema';

commit;

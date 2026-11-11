-- ============================================================
-- 575: Meeting links: a call's count of who is in it includes its guests.
-- 565 counts the members joined (team_call_participant) each time it
-- writes participant_count; a meeting's call also has guests in it (573's
-- meeting_guest.in_call), so three of 565's functions are redefined here,
-- each from its CURRENT body (565's text, the same as DEV's), with one
-- change: the count is 574's team_call_people_now (members joined plus
-- guests in the call). Everything else in them, and their grants, stay.
--   team_call_participant_event(text, uuid, text, boolean, timestamptz, timestamptz)
--   team_call_fence(uuid, uuid)
--   team_call_member_gone_trigger()
-- A call with no guests counts exactly as before. The peak (and so the
-- ended call's words, "Call ended · 12 min · 3 people") counts guests too.
-- A guest's own join and leave are 574's meeting_guest_event; 565's
-- refusal of a join without access never sees a guest (a guest's identity
-- is not a member id, so the webhook never hands it to 565).
--
-- Additive. Idempotent. Needs 574. No backslashes anywhere in this file
-- (one MCP transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

create or replace function public.team_call_participant_event(room_name text, member_ref uuid, session_ref text, is_join boolean, event_at timestamptz, session_joined_at timestamptz)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  c public.team_call%rowtype;
  p public.team_call_participant%rowtype;
  joined_time timestamptz := coalesce(session_joined_at, event_at);
  outcome text;
  in_now integer;
begin
  -- The call's row lock orders every event of one call.
  select * into c from public.team_call t where t.room = room_name for update;
  if not found then
    return 'unknown';
  end if;
  if c.status <> 'live' then
    return 'ended';
  end if;
  -- Someone who may not read the conversation, or is no member of its
  -- workspace at all (removed, rejoining on a token LiveKit refreshed): out again.
  if is_join and not public.team_chat_member_can_read(c.channel_id, member_ref) then
    insert into public.team_call_eject (call_id, room, identity, reason)
    values (c.id, c.room, member_ref::text, 'access')
    on conflict do nothing;
    return 'ejected';
  end if;
  if not exists (select 1 from public.member m where m.id = member_ref and m.workspace_id = c.workspace_id) then
    return 'unknown';
  end if;
  select * into p from public.team_call_participant x where x.call_id = c.id and x.member_id = member_ref;

  if is_join then
    if not found then
      insert into public.team_call_participant (call_id, member_id, workspace_id, channel_id, state, session_sid, first_joined_at, joined_at, last_event_at)
      values (c.id, member_ref, c.workspace_id, c.channel_id, 'joined', session_ref, joined_time, joined_time, event_at);
      outcome := 'joined';
    elsif p.session_sid is not distinct from session_ref then
      -- This session again: a repeat while in it, or a late one after it left.
      outcome := case when p.state = 'joined' then 'same' else 'stale' end;
    elsif joined_time < p.joined_at then
      -- An older session than the one on the row.
      outcome := 'stale';
    else
      update public.team_call_participant x
         set state = 'joined', session_sid = session_ref, joined_at = joined_time, left_at = null,
             last_event_at = greatest(x.last_event_at, event_at)
       where x.call_id = c.id and x.member_id = member_ref;
      outcome := 'joined';
    end if;
    if outcome = 'joined' then
      -- Joining is answering.
      update public.team_call_ring x
         set state = 'accepted', answered_at = now()
       where x.call_id = c.id and x.member_id = member_ref and x.state in ('ringing', 'busy');
      update public.team_call t
         set ringing = array_remove(t.ringing, member_ref), declined = array_remove(t.declined, member_ref)
       where t.id = c.id;
    end if;
  else
    if not found then
      -- The leave came first: remember the session, so its late join is stale.
      insert into public.team_call_participant (call_id, member_id, workspace_id, channel_id, state, session_sid, first_joined_at, joined_at, left_at, last_event_at)
      values (c.id, member_ref, c.workspace_id, c.channel_id, 'left', session_ref, joined_time, joined_time, greatest(event_at, joined_time), event_at);
      outcome := 'left';
    elsif p.session_sid is not distinct from session_ref then
      if p.state = 'left' then
        outcome := 'same';
      else
        update public.team_call_participant x
           set state = 'left', left_at = greatest(event_at, x.joined_at), last_event_at = greatest(x.last_event_at, event_at)
         where x.call_id = c.id and x.member_id = member_ref;
        outcome := 'left';
      end if;
    elsif joined_time <= p.joined_at then
      -- An older session's leave, after a newer one joined (a reconnect).
      outcome := 'stale';
    else
      -- A newer session's leave before its join arrived.
      update public.team_call_participant x
         set state = 'left', session_sid = session_ref, joined_at = joined_time, left_at = greatest(event_at, joined_time),
             last_event_at = greatest(x.last_event_at, event_at)
       where x.call_id = c.id and x.member_id = member_ref;
      outcome := 'left';
    end if;
  end if;

  -- 575: its members joined and its guests in it.
  in_now := public.team_call_people_now(c.id);
  update public.team_call t
     set participant_count = in_now,
         peak_participants = greatest(t.peak_participants, in_now),
         updated_at = now()
   where t.id = c.id;
  return outcome;
end;
$$;

create or replace function public.team_call_fence(only_member uuid default null, only_channel uuid default null)
returns table (call_id uuid, room text, member_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  r record;
begin
  for r in
    select p.call_id as cid, t.room as rm, p.member_id as mid
      from public.team_call_participant p
      join public.team_call t on t.id = p.call_id
     where p.state = 'joined'
       and t.status = 'live'
       and (only_member is null or p.member_id = only_member)
       and (only_channel is null or p.channel_id = only_channel)
       and not public.team_chat_member_can_read(p.channel_id, p.member_id)
     order by p.call_id
  loop
    perform 1 from public.team_call t where t.id = r.cid for update;
    update public.team_call_participant x
       set state = 'left', left_at = now(), last_event_at = greatest(x.last_event_at, now())
     where x.call_id = r.cid and x.member_id = r.mid and x.state = 'joined';
    insert into public.team_call_eject (call_id, room, identity, reason)
    values (r.cid, r.rm, r.mid::text, 'access')
    on conflict do nothing;
    update public.team_call t
       set participant_count = public.team_call_people_now(t.id),
           updated_at = now()
     where t.id = r.cid;
    return query select r.cid, r.rm, r.mid;
  end loop;
end;
$$;

create or replace function public.team_call_member_gone_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  for r in
    select p.call_id as cid, t.room as rm
      from public.team_call_participant p
      join public.team_call t on t.id = p.call_id
     where p.member_id = old.id and p.state = 'joined' and t.status = 'live'
     order by p.call_id
  loop
    perform 1 from public.team_call t where t.id = r.cid for update;
    update public.team_call_participant x
       set state = 'left', left_at = now(), last_event_at = greatest(x.last_event_at, now())
     where x.call_id = r.cid and x.member_id = old.id;
    insert into public.team_call_eject (call_id, room, identity, reason)
    values (r.cid, r.rm, old.id::text, 'access')
    on conflict do nothing;
    update public.team_call t
       set participant_count = public.team_call_people_now(t.id),
           updated_at = now()
     where t.id = r.cid;
  end loop;
  return old;
end;
$$;

notify pgrst, 'reload schema';

commit;

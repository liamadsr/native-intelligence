-- ============================================================
-- 565: Team calls, the functions that write 564's tables. The app calls the
-- first three as the person (their JWT, so auth.uid() is theirs); LiveKit's
-- webhooks, the leave route, the ring timer and the sweeper call the rest as
-- the service role (src/lib/team-calls/store.ts).
-- ============================================================
--   team_call_start(ch)  as the person, in a channel or DM they may post
--                     in: the live call there (created false), or a new one
--                     with its message in the conversation (created true).
--                     Two starts at once make one call: the second finds
--                     the first (team_call_one_live).
--   team_call_ring_members(target_call, members)  as the person, in a live
--                     call in a conversation they may post in: a ring for
--                     each member who may read the
--                     channel, is not the caller and is not in this call
--                     already; 'busy' (a quiet notice, not a ring) for one
--                     who is in another live call of the same workspace
--                     (another workspace's calls are not the caller's to
--                     know of; the person's own page keeps such a ring
--                     quiet). A member with a
--                     ring open for this call is left as they are. Limits,
--                     each a member skipped (never an error): at most 20 per
--                     request and 20 rings per call in all; nobody is rung
--                     again for a call they declined or let run out; a caller
--                     rings the same person at most once a minute, in any
--                     call; and in a DM, someone who declined a call there in
--                     the last two minutes is not rung by the next one (the
--                     call is in the DM for them to join; no ring, so no
--                     missed-call notice or email each round). Returns the
--                     rings made.
--   team_call_answer(target_ring, accept)  as the ring's own person: accepted or
--                     declined, once; a ring already settled answers with
--                     its state and changes nothing (another tab or device
--                     answered first), and one past its time answers
--                     'missed' (its timer tells the person).
--   team_call_participant_event(room_name, member_ref, session_ref,
--                     is_join, event_at, session_joined_at)  service
--                     role: a LiveKit participant_joined or _left. Sessions
--                     are ordered by when they joined (session_joined_at,
--                     LiveKit's own, to the millisecond), never by when an
--                     event arrived: a session that left never comes back (a
--                     late join of it is stale), an older session's join or
--                     leave is stale once a newer session is on the row (a
--                     reconnect's old leave lands in the same second as the
--                     new join), and a newer session's leave that arrives
--                     before its join is kept, so the join is stale when it
--                     comes. Joining answers the member's open ring for the
--                     call. Recounts who is in it and the peak. Returns what
--                     it did.
--   team_call_end(target_call, end_reason, end_at)  service role: the call ended (its room
--                     finished, a DM's person hung up, the sweeper found its
--                     room gone, the room could not be made, or its channel
--                     was archived). Once: an
--                     ended call answers nothing. Everyone still in it has
--                     left; its duration (start to the last person out) and
--                     peak are written onto it and, as words, onto its
--                     message; its open rings are missed and returned (the
--                     app tells those people).
--   team_call_expire_rings(only_ring)  service role: open rings past their time
--                     are missed (all of them, or just `only_ring`), and
--                     returned.
--   team_call_fence(only_member, only_channel)  service role (and 565's
--                     triggers): everyone connected to a live call who may
--                     no longer read its conversation (team_chat_member_can_
--                     read) is marked left and put on 564's team_call_eject
--                     outbox, for the app to take out of the LiveKit room.
--                     Returns them. The sweeper runs it over every live call.
--   Triggers that eject the moment access ends, whatever path ends it (an
--                     app route, a definer function, a cascade), so it can't
--                     be skipped:
--                       team_member, after delete: their team's channels;
--                       team_chat_member, after delete: that DM;
--                       member, after update of workspace_id or user_id: all;
--                       member, before delete: every call they are in (their
--                         rows go with them);
--                       team_chat_channel, after update of team_id or kind:
--                         that channel's call;
--                       team_chat_channel, after update of archived_at: an
--                         archived channel's live call ends ('archived') and
--                         its room closes;
--                       team_chat_channel, before delete: its live call's
--                         room closes.
--                     A participant event of someone who may not read the
--                     conversation (a removed person rejoining on a token
--                     LiveKit refreshed) is refused and ejected too.
--   team_call_summary(kind, seconds, peak)  a call's message once it ended:
--                     'Call ended · 12 min · 3 people'; 'Missed call' for a
--                     DM nobody answered; 'Call ended' when nobody joined.
--                     The same words as src/lib/team-calls/types.ts
--                     teamCallSummary.
--
-- Lock order, everywhere: a call's row first, then its rings and people, so
-- two of these never wait on each other. When one of these writes a call's
-- message for a person's action (archiving a channel ends its call), it sets
-- the transaction-local team_calls.writing, which 564's message guard lets
-- through; no client can set it.
--
-- Additive. Idempotent. New functions, and triggers that only add work after
-- a membership change (none refuses one). No backslashes anywhere in this
-- file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

-- ── Words ───────────────────────────────────────────────────────────────────

create or replace function public.team_call_summary(channel_kind text, seconds integer, peak integer)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when channel_kind = 'dm' and coalesce(peak, 0) <= 1 then 'Missed call'
    when coalesce(peak, 0) = 0 then 'Call ended'
    else 'Call ended · '
      || case
           when coalesce(seconds, 0) < 60 then 'under a minute'
           when seconds < 3600 then (seconds / 60)::text || ' min'
           else (seconds / 3600)::text || ' h'
             || case when (seconds % 3600) / 60 > 0 then ' ' || ((seconds % 3600) / 60)::text || ' min' else '' end
         end
      || ' · ' || peak::text || case when peak = 1 then ' person' else ' people' end
  end;
$$;

-- ── As the person ───────────────────────────────────────────────────────────

create or replace function public.team_call_start(ch uuid)
returns table (call_id uuid, room text, message_id uuid, created boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  ws uuid;
  me uuid;
  live public.team_call%rowtype;
  new_call uuid := gen_random_uuid();
  new_message uuid;
begin
  if not public.team_chat_can_post(ch) then
    raise exception 'team calls: no such channel' using errcode = '42501';
  end if;
  select c.workspace_id into ws from public.team_chat_channel c where c.id = ch;
  me := public.current_member_id(ws);
  if me is null then
    raise exception 'team calls: not a member of this workspace' using errcode = '42501';
  end if;

  select * into live from public.team_call t where t.channel_id = ch and t.status = 'live';
  if found then
    return query select live.id, live.room, live.message_id, false;
    return;
  end if;

  begin
    insert into public.team_call (id, workspace_id, channel_id, started_by, room)
    values (new_call, ws, ch, me, 'tc-' || new_call::text);
  exception when unique_violation then
    -- Another start won the race: that call is this one.
    select * into live from public.team_call t where t.channel_id = ch and t.status = 'live';
    if found then
      return query select live.id, live.room, live.message_id, false;
      return;
    end if;
    raise;
  end;

  insert into public.team_chat_message (channel_id, workspace_id, author_kind, author_member_id, body, kind, call_id)
  values (ch, ws, 'member', me, 'Started a call', 'call', new_call)
  returning id into new_message;
  update public.team_call t set message_id = new_message where t.id = new_call;
  return query select new_call, 'tc-' || new_call::text, new_message, true;
end;
$$;

create or replace function public.team_call_ring_members(target_call uuid, members uuid[])
returns table (ring_id uuid, member_id uuid, user_id uuid, state text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  c public.team_call%rowtype;
  ch public.team_chat_channel%rowtype;
  me uuid;
  my_name text;
  mem uuid;
  mem_user uuid;
  is_busy boolean;
  made_id uuid;
  made_expiry timestamptz;
  rung integer;
begin
  select * into c from public.team_call t where t.id = target_call for update;
  if not found or not public.team_chat_can_read(c.channel_id) then
    raise exception 'team calls: no such call' using errcode = '42501';
  end if;
  if c.status <> 'live' then
    raise exception 'team calls: the call has ended' using errcode = '22023';
  end if;
  if not public.team_chat_can_post(c.channel_id) then
    raise exception 'team calls: this conversation is read only' using errcode = '42501';
  end if;
  if coalesce(cardinality(members), 0) > 20 then
    raise exception 'team calls: at most 20 people at a time' using errcode = '22023';
  end if;
  select * into ch from public.team_chat_channel x where x.id = c.channel_id;
  me := public.current_member_id(c.workspace_id);
  select left(m.display_name, 120) into my_name from public.member m where m.id = me;
  select count(*)::integer into rung from public.team_call_ring r where r.call_id = c.id;

  for mem in select distinct x from unnest(coalesce(members, '{}'::uuid[])) as x loop
    -- 20 rings per call, in all.
    exit when rung >= 20;
    continue when mem is null or mem = me;
    select m.user_id into mem_user from public.member m where m.id = mem and m.workspace_id = c.workspace_id;
    continue when mem_user is null;
    continue when not public.team_chat_member_can_read(c.channel_id, mem);
    -- In this call already: nothing to ring.
    continue when exists (
      select 1 from public.team_call_participant p
       where p.call_id = c.id and p.member_id = mem and p.state = 'joined'
    );
    -- Declined this call, or let it ring out: not rung for it again.
    continue when exists (
      select 1 from public.team_call_ring r
       where r.call_id = c.id and r.member_id = mem and r.state in ('declined', 'missed')
    );
    -- This caller rang them in the last minute (any call).
    continue when exists (
      select 1 from public.team_call_ring r
       where r.caller_member_id = me and r.member_id = mem and r.created_at > now() - interval '60 seconds'
    );
    -- A DM where they declined a call in the last two minutes: the call is there to join, unrung.
    continue when ch.kind = 'dm' and exists (
      select 1 from public.team_call_ring r
       where r.channel_id = c.channel_id and r.member_id = mem and r.state = 'declined'
         and coalesce(r.answered_at, r.created_at) > now() - interval '2 minutes'
    );
    -- In another live call of this workspace: a quiet notice instead.
    is_busy := exists (
      select 1
        from public.team_call_participant p
        join public.team_call t on t.id = p.call_id
       where p.member_id = mem
         and p.state = 'joined'
         and t.status = 'live'
         and t.id <> c.id
    );
    made_id := null;
    insert into public.team_call_ring (call_id, workspace_id, channel_id, member_id, user_id, caller_member_id, caller_name, channel_kind, channel_name, state, expires_at)
    values (c.id, c.workspace_id, c.channel_id, mem, mem_user, me, coalesce(nullif(my_name, ''), 'A teammate'), ch.kind, left(ch.name, 80),
            case when is_busy then 'busy' else 'ringing' end, now() + interval '40 seconds')
    on conflict (call_id, member_id) where state in ('ringing', 'busy') do nothing
    returning id, expires_at into made_id, made_expiry;
    continue when made_id is null;
    rung := rung + 1;
    if not is_busy then
      update public.team_call t
         set ringing = case when mem = any (t.ringing) then t.ringing else array_append(t.ringing, mem) end,
             declined = array_remove(t.declined, mem),
             updated_at = now()
       where t.id = c.id;
    end if;
    return query select made_id, mem, mem_user, case when is_busy then 'busy' else 'ringing' end, made_expiry;
  end loop;
end;
$$;

create or replace function public.team_call_answer(target_ring uuid, accept boolean)
returns table (call_id uuid, state text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  r public.team_call_ring%rowtype;
  now_state text;
begin
  select * into r from public.team_call_ring x where x.id = target_ring and x.user_id = auth.uid();
  if not found then
    raise exception 'team calls: no such ring' using errcode = '42501';
  end if;
  perform 1 from public.team_call t where t.id = r.call_id for update;
  if r.state in ('ringing', 'busy') and r.expires_at <= now() then
    -- Past its time: missed (its timer, or the sweeper, writes it and tells them).
    return query select r.call_id, 'missed'::text;
    return;
  end if;
  update public.team_call_ring x
     set state = case when accept then 'accepted' else 'declined' end,
         answered_at = now()
   where x.id = target_ring
     and x.state in ('ringing', 'busy')
     and x.expires_at > now()
  returning x.state into now_state;
  if now_state is null then
    -- Settled already (another tab or device answered, or it ran out).
    return query select r.call_id, r.state;
    return;
  end if;
  update public.team_call t
     set ringing = array_remove(t.ringing, r.member_id),
         declined = case
           when accept then array_remove(t.declined, r.member_id)
           when r.member_id = any (t.declined) then t.declined
           else array_append(t.declined, r.member_id)
         end,
         updated_at = now()
   where t.id = r.call_id;
  return query select r.call_id, now_state;
end;
$$;

-- ── As the service role ─────────────────────────────────────────────────────

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

  select count(*)::integer into in_now from public.team_call_participant x where x.call_id = c.id and x.state = 'joined';
  update public.team_call t
     set participant_count = in_now,
         peak_participants = greatest(t.peak_participants, in_now),
         updated_at = now()
   where t.id = c.id;
  return outcome;
end;
$$;

create or replace function public.team_call_end(target_call uuid, end_reason text, end_at timestamptz)
returns table (
  ring_id uuid, call_id uuid, message_id uuid, workspace_id uuid, channel_id uuid, channel_kind text, channel_name text,
  member_id uuid, user_id uuid, caller_member_id uuid, caller_name text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  c public.team_call%rowtype;
  ch_kind text;
  ended timestamptz;
  secs integer;
  peak integer;
begin
  if end_reason is null or end_reason not in ('finished', 'left', 'swept', 'failed', 'archived') then
    raise exception 'team calls: no such end' using errcode = '22023';
  end if;
  select * into c from public.team_call t where t.id = target_call for update;
  if not found or c.status <> 'live' then
    return;
  end if;
  select x.kind into ch_kind from public.team_chat_channel x where x.id = c.channel_id;
  -- Ended when the last person left; else (still in it, or nobody came) at the event.
  select max(coalesce(x.left_at, coalesce(end_at, now()))) into ended
    from public.team_call_participant x
   where x.call_id = c.id;
  ended := greatest(c.started_at, least(coalesce(ended, end_at, now()), now()));
  secs := greatest(0, floor(extract(epoch from (ended - c.started_at)))::integer);
  update public.team_call_participant x
     set state = 'left', left_at = greatest(ended, x.joined_at), last_event_at = greatest(x.last_event_at, ended)
   where x.call_id = c.id and x.state = 'joined';
  peak := c.peak_participants;
  update public.team_call t
     set status = 'ended', ended_at = ended, ended_reason = end_reason, duration_seconds = secs,
         participant_count = 0, ringing = '{}', updated_at = now()
   where t.id = c.id;
  if c.message_id is not null then
    -- The call's own words (a person's action may have ended it: 564's guard lets this through).
    perform set_config('team_calls.writing', 'on', true);
    update public.team_chat_message m
       set body = public.team_call_summary(ch_kind, secs, peak)
     where m.id = c.message_id;
    perform set_config('team_calls.writing', 'off', true);
  end if;
  return query
    update public.team_call_ring r
       set state = 'missed'
     where r.call_id = c.id and r.state in ('ringing', 'busy')
    returning r.id, r.call_id, c.message_id, r.workspace_id, r.channel_id, r.channel_kind, r.channel_name,
              r.member_id, r.user_id, r.caller_member_id, r.caller_name;
end;
$$;

create or replace function public.team_call_expire_rings(only_ring uuid default null)
returns table (
  ring_id uuid, call_id uuid, message_id uuid, workspace_id uuid, channel_id uuid, channel_kind text, channel_name text,
  member_id uuid, user_id uuid, caller_member_id uuid, caller_name text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  -- The calls' rows first (the lock order), then their rings.
  perform 1
     from public.team_call t
    where t.id in (
      select r.call_id from public.team_call_ring r
       where r.state in ('ringing', 'busy') and r.expires_at <= now() and (only_ring is null or r.id = only_ring)
    )
    order by t.id
      for update;
  return query
    with gone as (
      update public.team_call_ring r
         set state = 'missed'
       where r.state in ('ringing', 'busy')
         and r.expires_at <= now()
         and (only_ring is null or r.id = only_ring)
      returning r.id, r.call_id, r.workspace_id, r.channel_id, r.channel_kind, r.channel_name,
                r.member_id, r.user_id, r.caller_member_id, r.caller_name
    ),
    unrung as (
      update public.team_call t
         set ringing = coalesce((select array_agg(x) from unnest(t.ringing) x where x not in (select g.member_id from gone g where g.call_id = t.id)), '{}'),
             updated_at = now()
       where t.id in (select g.call_id from gone g)
      returning t.id, t.message_id
    )
    select g.id, g.call_id, u.message_id, g.workspace_id, g.channel_id, g.channel_kind, g.channel_name,
           g.member_id, g.user_id, g.caller_member_id, g.caller_name
      from gone g
      left join unrung u on u.id = g.call_id;
end;
$$;

-- ── Access ends: out of the room ────────────────────────────────────────────

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
       set participant_count = (select count(*)::integer from public.team_call_participant x where x.call_id = t.id and x.state = 'joined'),
           updated_at = now()
     where t.id = r.cid;
    return query select r.cid, r.rm, r.mid;
  end loop;
end;
$$;

-- A member's access to some conversations ended: out of those calls.
create or replace function public.team_call_fence_member_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.team_call_fence(old.member_id, null);
  return null;
end;
$$;

-- A DM's member removed: out of that DM's call.
create or replace function public.team_call_fence_dm_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.team_call_fence(old.member_id, old.channel_id);
  return null;
end;
$$;

-- A member moved to another workspace or account: out of every call.
create or replace function public.team_call_fence_moved_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.team_call_fence(new.id, null);
  return null;
end;
$$;

-- A member removed from the workspace: out of every call they are in (their
-- rows go with them, so they are marked left and the count kept true first).
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
       set participant_count = (select count(*)::integer from public.team_call_participant x where x.call_id = t.id and x.state = 'joined'),
           updated_at = now()
     where t.id = r.cid;
  end loop;
  return old;
end;
$$;

-- A channel archived: its live call ends and its room closes. Its team or
-- kind changed: whoever may no longer read it is out.
create or replace function public.team_call_channel_changed_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  live public.team_call%rowtype;
begin
  if new.archived_at is not null and old.archived_at is null then
    select * into live from public.team_call t where t.channel_id = new.id and t.status = 'live';
    if found then
      perform public.team_call_end(live.id, 'archived', now());
      insert into public.team_call_eject (call_id, room, identity, reason)
      values (live.id, live.room, null, 'archived')
      on conflict do nothing;
    end if;
  end if;
  if new.team_id is distinct from old.team_id or new.kind is distinct from old.kind then
    perform public.team_call_fence(null, new.id);
  end if;
  return null;
end;
$$;

-- A channel deleted: its live call's room closes (the call goes with the channel).
create or replace function public.team_call_channel_gone_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.team_call_eject (call_id, room, identity, reason)
  select t.id, t.room, null, 'deleted'
    from public.team_call t
   where t.channel_id = old.id and t.status = 'live'
  on conflict do nothing;
  return old;
end;
$$;

drop trigger if exists team_call_fence_team_member on public.team_member;
create trigger team_call_fence_team_member
  after delete on public.team_member
  for each row execute function public.team_call_fence_member_trigger();

drop trigger if exists team_call_fence_dm_member on public.team_chat_member;
create trigger team_call_fence_dm_member
  after delete on public.team_chat_member
  for each row execute function public.team_call_fence_dm_trigger();

drop trigger if exists team_call_fence_member_moved on public.member;
create trigger team_call_fence_member_moved
  after update of workspace_id, user_id on public.member
  for each row
  when (new.workspace_id is distinct from old.workspace_id or new.user_id is distinct from old.user_id)
  execute function public.team_call_fence_moved_trigger();

drop trigger if exists team_call_member_gone on public.member;
create trigger team_call_member_gone
  before delete on public.member
  for each row execute function public.team_call_member_gone_trigger();

drop trigger if exists team_call_channel_changed on public.team_chat_channel;
create trigger team_call_channel_changed
  after update of archived_at, team_id, kind on public.team_chat_channel
  for each row execute function public.team_call_channel_changed_trigger();

drop trigger if exists team_call_channel_gone on public.team_chat_channel;
create trigger team_call_channel_gone
  before delete on public.team_chat_channel
  for each row execute function public.team_call_channel_gone_trigger();

revoke all on function public.team_call_fence(uuid, uuid) from public, anon, authenticated;
revoke all on function public.team_call_fence_member_trigger() from public, anon, authenticated;
revoke all on function public.team_call_fence_dm_trigger() from public, anon, authenticated;
revoke all on function public.team_call_fence_moved_trigger() from public, anon, authenticated;
revoke all on function public.team_call_member_gone_trigger() from public, anon, authenticated;
revoke all on function public.team_call_channel_changed_trigger() from public, anon, authenticated;
revoke all on function public.team_call_channel_gone_trigger() from public, anon, authenticated;
grant execute on function public.team_call_fence(uuid, uuid) to service_role;

revoke all on function public.team_call_summary(text, integer, integer) from public, anon, authenticated;
revoke all on function public.team_call_start(uuid) from public, anon;
revoke all on function public.team_call_ring_members(uuid, uuid[]) from public, anon;
revoke all on function public.team_call_answer(uuid, boolean) from public, anon;
revoke all on function public.team_call_participant_event(text, uuid, text, boolean, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.team_call_end(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.team_call_expire_rings(uuid) from public, anon, authenticated;
grant execute on function public.team_call_summary(text, integer, integer) to service_role;
grant execute on function public.team_call_start(uuid) to authenticated;
grant execute on function public.team_call_ring_members(uuid, uuid[]) to authenticated;
grant execute on function public.team_call_answer(uuid, boolean) to authenticated;
grant execute on function public.team_call_participant_event(text, uuid, text, boolean, timestamptz, timestamptz) to service_role;
grant execute on function public.team_call_end(uuid, text, timestamptz) to service_role;
grant execute on function public.team_call_expire_rings(uuid) to service_role;

notify pgrst, 'reload schema';

commit;

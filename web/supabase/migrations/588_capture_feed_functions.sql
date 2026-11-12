-- ============================================================
-- 588: The capture feed, the functions that write 587's tables. The app's
-- server calls every one as the service role (src/lib/capture-feed/store.ts):
-- the producer's requests reach them through /api/internal/capture-feed/*,
-- after its secret was checked; the notes switch, the call recorder's work
-- list, the notes' finish and the sweeper call the rest.
-- ============================================================
--   team_call_notes_owner(call)  the member whose capture a call's notes are:
--                     a meeting's host (whoever started its call), else the
--                     call's starter, else who turned the notes on; a member
--                     of the workspace with an account.
--   team_call_capture_ensure(target_call, capture_title)  the call's
--                     capture, made the first time notes are on (or again
--                     after its owner ended it by hand) (private to
--                     its owner, its conversation written on it as 566's
--                     fences read it, shared with that conversation by one
--                     entity_access grant, source 'team_call', as 567's
--                     notes are). Null while the call is not live with notes
--                     on. Once made, the same one every round.
--   team_call_feed_unwanted(call_ref, feed_round)  null while a call wants a
--                     feed for this round (live, notes on in this round,
--                     under 567's 3 hours); else why not.
--   capture_feed_hearable_guests(session)  the meeting guests a producer may
--                     hear: let into the call, and said go to this round's
--                     notes (574's notes_ack_round). Every member may be heard.
--   capture_feed_capture_closed(capture)  ended, or its transcript locked (its
--                     owner ended it by hand): no producer feeds it.
--   capture_feed_eject_producer(session)  the session's producer on 565's
--                     eject outbox (identity notes-recorder-<producer id>, the
--                     app's teamCallRecorderIdentity, and the session): out of
--                     the room.
--   capture_feed_producer_wanted(call, producer_id)  a live session of that
--                     producer in the call's current round, its capture open.
--   capture_feed_settle_ejects()  the drain's first step: a producer's
--                     pending eject is done, nobody removed, when the call
--                     wants that producer again (notes off, then on).
--   capture_feed_start(source_kind, source_ref, producer_kind, producer_id,
--                     capture_title)  a producer begins (or takes up again)
--                     the feed of a source: the session for the source's
--                     current round, made once, and the guests it may hear.
--                     'started' / 'resumed' (its own, or one whose producer
--                     went quiet); 'busy' (another producer heartbeats it),
--                     'not_wanted' (no notes, or the capture closed),
--                     'unknown'.
--   capture_feed_heartbeat(producer_id, sessions)  the producer is running
--                     these: each is kept (its heartbeat written, a lost one
--                     live again, with the guests it may hear now), or ended
--                     because its source no longer wants it or its capture
--                     closed (keep false, with why; the producer goes on the
--                     eject outbox), or is not this producer's.
--   capture_feed_roster(session, producer_id, events)  who joined and left:
--                     a speaker key's first event names who it is (a member
--                     of the workspace who may read the call's conversation,
--                     a guest of this meeting, or an outside name and
--                     email); each person gets one participant row with a
--                     label unique in the capture, applied in the order the
--                     events happened (an older one is stale).
--   capture_feed_append(session, producer_id, segments)  final segments:
--                     each key once (a repeat is a duplicate), dropped when
--                     said after the session ended, when its speaker is not
--                     known yet, or for a guest who has not said go to this
--                     round's notes (574's notes_ack_round); the rest are
--                     stored and appended to the capture's transcript as
--                     `[Label] words` lines in the order they were said,
--                     through 192's append_capture_transcript.
--   capture_feed_end(session, producer_id, reason)  the producer delivered
--                     everything it heard and leaves the session
--                     (delivered_at: the notes' finish stops waiting for it).
--                     It ends unless its source still wants a feed and its
--                     capture is open; a producer that lost the room (or
--                     whose words were refused) hands it back as 'lost', a
--                     gap opened, until one takes it up; one that left an
--                     empty room or could not join hands it back as it is.
--   capture_feed_follow_call  a trigger on team_call: notes going off, or the
--                     call ending, end that round's session at that moment
--                     (nothing said after it reaches the capture) and put its
--                     producers on the eject outbox.
--   capture_feed_mark_lost(stale_seconds)  the sweeper: sessions whose
--                     producer stopped heartbeating are 'lost', with the
--                     moment in gaps, their capture says so
--                     (metadata.notes_recorder 'lost' until it comes back),
--                     and the producer goes on the eject outbox.
--   capture_feed_fence_producers()  the sweeper: a producer still seen in a
--                     live call that wants no feed of it goes on the eject
--                     outbox again.
--   team_call_recorder_work(producer_id, running, max_jobs)  the call
--                     recorder's work: live calls with notes on, their
--                     capture open, that no producer is feeding (or this one,
--                     which says it isn't).
--   capture_feed_lines(capture)  its transcript's lines in the order said,
--                     read in the database from every segment (no page cap):
--                     a speaker's stretches less than 1.5 s apart, with
--                     nobody between, run together (notes.ts mergeNotes).
--   capture_feed_quote_speakers(capture, quote)  the participant rows of the
--                     lines that hold a quote as whole words (five words or
--                     more, or 20 characters; a contraction one word): the
--                     live agent's gate files an action as its assignee's own
--                     only when that member's own roster row said it.
--   team_call_capture_lock(target_call, preamble_text, rebuild)  the call
--                     ended: its sessions end, and its capture is locked
--                     (ended_at, duration, the transcript written once more
--                     from capture_feed_lines, the preamble before the
--                     person's own notes) and 'ready' (spoke: whether
--                     anything was said); or, when nothing was said and its
--                     owner wrote nothing in it, removed with its grant and
--                     the notes 'silent'. rebuild false: lock it as it
--                     stands. A capture already ended: the notes 'ready'
--                     ('done' when team_call_capture_finish finished it,
--                     so its pass is not run twice); a transcript its owner
--                     locked is never written. Silent, with an earlier
--                     capture of the call that holds words: the call links
--                     back to that one and is 'ready', not 'silent'.
--   team_call_capture_finish(capture)  a call's capture its owner closed by
--                     hand, finished then: its feeds end, it ends, its
--                     people have left, it is the recorder's no more; the
--                     caller runs its end-of-meeting pass ('ready', again
--                     while that pass is not done; 'done' once it is).
--   team_call_capture_pass_done(capture)  that pass is done.
--   team_call_closed_captures(max_rows, max_attempts)  the sweeper: closed
--                     captures whose pass is not done, asked for again
--                     ('retry', counted), at most max_attempts times, then
--                     'given_up'.
--
-- Lock order, as 565's and 567's: a call's row first, then its sessions,
-- then the capture, so no two of these wait on each other.
--
-- Additive. Idempotent. New functions only; no earlier function is
-- redefined. Every one is SECURITY DEFINER with its search_path pinned, and
-- only the service role may run it. No backslashes anywhere in this file
-- (one MCP transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

-- ── A call's capture ────────────────────────────────────────────────────────

create or replace function public.team_call_notes_owner(c public.team_call)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.id
    from (values
           (1, (select mt.host_member_id from public.meeting mt where mt.channel_id = c.channel_id)),
           (2, c.started_by),
           (3, c.notes_by)
         ) as o(rank, member_ref)
    join public.member m on m.id = o.member_ref and m.workspace_id = c.workspace_id and m.user_id is not null
   order by o.rank
   limit 1;
$$;

create or replace function public.team_call_capture_ensure(target_call uuid, capture_title text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.team_call%rowtype;
  owner_member uuid;
  owner_user uuid;
  made uuid;
begin
  select * into c from public.team_call t where t.id = target_call for update;
  if not found then
    raise exception 'team calls: no such call' using errcode = '22023';
  end if;
  -- A capture its owner ended by hand takes no more words: notes on again get a new one.
  if c.capture_id is not null and not public.capture_feed_capture_closed(c.capture_id) then
    return c.capture_id;
  end if;
  if c.status <> 'live' or not c.notes then
    return null;
  end if;
  owner_member := public.team_call_notes_owner(c);
  if owner_member is null then
    raise exception 'team calls: the notes have no owner in the workspace' using errcode = '22023';
  end if;
  select m.user_id into owner_user from public.member m where m.id = owner_member;

  insert into public.captures (
    user_id, workspace_id, title, status, recorded_at, started_at, visibility, live_mode, is_transcript_locked, metadata, notes_channel_id
  )
  values (
    owner_user, c.workspace_id, left(coalesce(nullif(trim(capture_title), ''), 'Call'), 200), 'active', now(), now(), 'private', false, false,
    jsonb_build_object(
      'source', 'team_call', 'team_call_id', c.id, 'channel_id', c.channel_id, 'message_id', c.message_id,
      'capture_mode', 'team_call', 'notes_recorder', 'live'
    ),
    c.channel_id
  )
  returning id into made;

  update public.team_call t set capture_id = made, updated_at = now() where t.id = c.id;
  insert into public.team_call_capture (call_id, capture_id, workspace_id) values (c.id, made, c.workspace_id) on conflict do nothing;
  -- Shared with the call's conversation, and no one else (566's fence).
  insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_channel_id, level, granted_by, source)
  values (c.workspace_id, 'capture', made, 'channel', c.channel_id, 'view', owner_member, 'team_call')
  on conflict do nothing;
  return made;
end;
$$;

create or replace function public.team_call_feed_unwanted(call_ref uuid, feed_round integer)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  c public.team_call%rowtype;
begin
  select * into c from public.team_call t where t.id = call_ref;
  if not found then
    return 'gone';
  end if;
  if c.status <> 'live' then
    return 'call_ended';
  end if;
  if not c.notes or c.notes_round <> feed_round then
    return 'notes_off';
  end if;
  if c.notes_seconds + greatest(0, extract(epoch from (now() - c.notes_on_since))) >= 10800 then
    return 'bound';
  end if;
  return null;
end;
$$;

-- ── A producer's session ────────────────────────────────────────────────────

-- The meeting guests who may be heard in a session: let into its call and said go to its round of
-- notes (574's notes_ack_round). A producer opens no transcription for any other guest.
create or replace function public.capture_feed_hearable_guests(s public.capture_feed_session)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(g.id order by g.id), '{}'::uuid[])
    from public.meeting_guest g
   where s.source_kind = 'team_call'
     and g.call_id = s.source_ref
     and g.state = 'admitted'
     and g.notes_ack_round >= s.round;
$$;

-- A capture that can take no more words: ended, or its transcript locked (its owner ended it by hand).
create or replace function public.capture_feed_capture_closed(target_capture uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.captures c where c.id = target_capture and (c.ended_at is not null or c.is_transcript_locked));
$$;

-- Take a producer out of its call's room (565's eject outbox, drained by the app): its session
-- ended or went quiet, and nothing may keep hearing the call for it.
create or replace function public.capture_feed_eject_producer(s public.capture_feed_session)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.team_call_eject (call_id, room, identity, reason, feed_session)
  select t.id, t.room, left('notes-recorder-' || s.producer_id, 64), 'access', s.id
    from public.team_call t
   where s.source_kind = 'team_call' and t.id = s.source_ref
  on conflict do nothing;
$$;

-- Does this call want a feed from this producer now: a live session of it in the call's current
-- round of notes, its capture open? (An eject queued for an earlier round is then stale.)
create or replace function public.capture_feed_producer_wanted(call_ref uuid, p_producer_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.team_call t
      join public.capture_feed_session y
        on y.source_kind = 'team_call' and y.source_ref = t.id and y.round = t.notes_round
     where t.id = call_ref and t.status = 'live' and t.notes
       and y.producer_id = p_producer_id and y.status = 'live'
       and not public.capture_feed_capture_closed(y.capture_id)
  );
$$;

-- The eject drain asks this first (src/lib/team-calls/eject.ts): a producer's pending entry is
-- done, nobody removed, when that producer is wanted in the call again (notes off, then on before
-- the drain ran). Returns how many were settled so.
create or replace function public.capture_feed_settle_ejects()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  update public.team_call_eject e
     set done_at = now()
   where e.done_at is null
     and e.identity like 'notes-recorder-%'
     and e.call_id is not null
     and public.capture_feed_producer_wanted(e.call_id, substr(e.identity, 16));
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.capture_feed_start(
  p_source_kind text, p_source_ref uuid, p_producer_kind text, p_producer_id text, p_capture_title text
)
returns table (outcome text, session_id uuid, capture_id uuid, started_at timestamptz, round integer, guests uuid[])
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  c public.team_call%rowtype;
  s public.capture_feed_session%rowtype;
  made uuid;
  why text;
  had boolean;
begin
  if p_producer_kind is null or p_producer_kind !~ '^[a-z][a-z0-9_]{0,39}$'
     or p_producer_id is null or p_producer_id !~ '^[A-Za-z0-9._-]{1,40}$' then
    raise exception 'capture feed: no such producer' using errcode = '22023';
  end if;
  if p_source_kind is distinct from 'team_call' then
    return query select 'unknown'::text, null::uuid, null::uuid, null::timestamptz, null::integer, null::uuid[];
    return;
  end if;
  select * into c from public.team_call t where t.id = p_source_ref for update;
  if not found then
    return query select 'unknown'::text, null::uuid, null::uuid, null::timestamptz, null::integer, null::uuid[];
    return;
  end if;
  why := public.team_call_feed_unwanted(c.id, c.notes_round);
  if why is not null then
    return query select 'not_wanted'::text, null::uuid, c.capture_id, null::timestamptz, c.notes_round, null::uuid[];
    return;
  end if;
  select * into s from public.capture_feed_session x
   where x.source_kind = 'team_call' and x.source_ref = c.id and x.round = c.notes_round
     for update;
  had := found;
  -- This round's capture was ended by hand: it takes no more words, and nobody is to hear the
  -- call for it (notes on again is a new round, into a new capture).
  if had and public.capture_feed_capture_closed(s.capture_id) then
    return query select 'not_wanted'::text, null::uuid, s.capture_id, null::timestamptz, c.notes_round, null::uuid[];
    return;
  end if;
  made := public.team_call_capture_ensure(c.id, p_capture_title);
  if not had then
    insert into public.capture_feed_session (workspace_id, capture_id, source_kind, source_ref, round, producer_kind, producer_id)
    values (c.workspace_id, made, 'team_call', c.id, c.notes_round, p_producer_kind, p_producer_id)
    returning * into s;
    return query select 'started'::text, s.id, s.capture_id, s.started_at, s.round, public.capture_feed_hearable_guests(s);
    return;
  end if;
  if s.status = 'ended' then
    return query select 'not_wanted'::text, s.id, s.capture_id, s.started_at, s.round, null::uuid[];
    return;
  end if;
  if s.producer_id <> p_producer_id and s.status = 'live' and s.heartbeat_at > now() - interval '30 seconds' then
    return query select 'busy'::text, s.id, s.capture_id, s.started_at, s.round, null::uuid[];
    return;
  end if;
  update public.capture_feed_session x
     set producer_kind = p_producer_kind, producer_id = p_producer_id, heartbeat_at = now(), status = 'live',
         delivered_at = null, gaps = public.capture_feed_close_gap(x.gaps, x.status), updated_at = now()
   where x.id = s.id
  returning * into s;
  perform public.capture_feed_recorder_state(s.capture_id, 'live');
  return query select 'resumed'::text, s.id, s.capture_id, s.started_at, s.round, public.capture_feed_hearable_guests(s);
end;
$$;

-- A lost session's last gap ends now (it is back).
create or replace function public.capture_feed_close_gap(gaps jsonb, was text)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when was <> 'lost' or jsonb_array_length(gaps) = 0 or (gaps -> -1) ? 'to' then gaps
    else jsonb_set(gaps, array[(jsonb_array_length(gaps) - 1)::text], (gaps -> -1) || jsonb_build_object('to', now()))
  end;
$$;

-- What the capture says of its recorder now: 'live', or 'lost' (it stopped hearing the call).
create or replace function public.capture_feed_recorder_state(target_capture uuid, state text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.captures c
     set metadata = coalesce(c.metadata, '{}'::jsonb) || jsonb_build_object('notes_recorder', state)
   where c.id = target_capture
     and c.ended_at is null
     and not c.is_transcript_locked
     and coalesce(c.metadata ->> 'notes_recorder', '') is distinct from state;
$$;

create or replace function public.capture_feed_heartbeat(p_producer_id text, p_sessions uuid[])
returns table (session_id uuid, keep boolean, reason text, guests uuid[])
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  sid uuid;
  s public.capture_feed_session%rowtype;
  why text;
begin
  for sid in select distinct x from unnest(coalesce(p_sessions, '{}'::uuid[])) as x limit 200 loop
    select * into s from public.capture_feed_session x where x.id = sid for update;
    if not found then
      return query select sid, false, 'unknown'::text, null::uuid[];
      continue;
    end if;
    if s.producer_id is distinct from p_producer_id then
      return query select sid, false, 'taken'::text, null::uuid[];
      continue;
    end if;
    if s.status = 'ended' then
      return query select sid, false, coalesce(s.end_reason, 'ended'), null::uuid[];
      continue;
    end if;
    why := public.team_call_feed_unwanted(s.source_ref, s.round);
    if why is null and public.capture_feed_capture_closed(s.capture_id) then
      why := 'capture_closed';
    end if;
    if why is not null then
      update public.capture_feed_session x
         set status = 'ended', ended_at = now(), end_reason = why, gaps = public.capture_feed_close_gap(x.gaps, x.status), updated_at = now()
       where x.id = s.id;
      perform public.capture_feed_eject_producer(s);
      return query select sid, false, why, null::uuid[];
      continue;
    end if;
    update public.capture_feed_session x
       set heartbeat_at = now(), status = 'live', gaps = public.capture_feed_close_gap(x.gaps, x.status), updated_at = now()
     where x.id = s.id;
    if s.status = 'lost' then
      perform public.capture_feed_recorder_state(s.capture_id, 'live');
    end if;
    return query select sid, true, null::text, public.capture_feed_hearable_guests(s);
  end loop;
end;
$$;

-- The producer has delivered everything it heard for this session and leaves it. The session ends
-- now unless its source still wants a feed (a producer that lost the room hands it back: the
-- recorder's work list offers it again at once); either way a call's finish stops waiting for it.
create or replace function public.capture_feed_end(p_session uuid, p_producer_id text, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.capture_feed_session%rowtype;
  why text;
begin
  select * into s from public.capture_feed_session x where x.id = p_session and x.producer_id = p_producer_id for update;
  if not found then
    return false;
  end if;
  if s.status = 'ended' then
    update public.capture_feed_session x set delivered_at = now(), updated_at = now() where x.id = s.id;
    return true;
  end if;
  why := public.team_call_feed_unwanted(s.source_ref, s.round);
  if why is null and public.capture_feed_capture_closed(s.capture_id) then
    why := 'capture_closed';
  end if;
  if why is not null then
    update public.capture_feed_session x
       set delivered_at = now(), status = 'ended', ended_at = now(),
           end_reason = left(coalesce(nullif(trim(p_reason), ''), why), 40),
           gaps = public.capture_feed_close_gap(x.gaps, x.status), updated_at = now()
     where x.id = s.id;
    return true;
  end if;
  -- Still wanted, and left because nobody else was in the room or the join failed: handed back as
  -- it is (nothing was missed: nobody spoke, or nothing was heard yet), no gap.
  if p_reason in ('alone', 'failed') then
    update public.capture_feed_session x set delivered_at = now(), updated_at = now() where x.id = s.id;
    return true;
  end if;
  -- Still wanted (the producer lost the room, or the feed refused its words): handed back, and
  -- until a producer takes it up again the notes say what they miss (a gap, the capture 'lost').
  update public.capture_feed_session x
     set delivered_at = now(), status = 'lost',
         gaps = case when x.status = 'lost' then x.gaps else x.gaps || jsonb_build_array(jsonb_build_object('from', now())) end,
         updated_at = now()
   where x.id = s.id;
  perform public.capture_feed_recorder_state(s.capture_id, 'lost');
  return true;
end;
$$;

-- Notes going off, or the call ending (565's team_call_end, 567's team_call_set_notes and
-- team_call_notes_stop, all unchanged), end that round's feed at that moment: a segment said
-- after it never reaches the capture, however late the producer hears of it.
create or replace function public.capture_feed_follow_call()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.capture_feed_session x
     set status = 'ended',
         ended_at = case when new.status = 'ended' then coalesce(new.ended_at, now()) else now() end,
         end_reason = case when new.status = 'ended' then 'call_ended' else 'notes_off' end,
         gaps = public.capture_feed_close_gap(x.gaps, x.status),
         updated_at = now()
   where x.source_kind = 'team_call' and x.source_ref = new.id and x.round = old.notes_round and x.status <> 'ended';
  -- Nothing hears the call for these notes any more: out of the room (the eject outbox).
  insert into public.team_call_eject (call_id, room, identity, reason, feed_session)
  select distinct on (x.producer_id) new.id, new.room, left('notes-recorder-' || x.producer_id, 64), 'access', x.id
    from public.capture_feed_session x
   where x.source_kind = 'team_call' and x.source_ref = new.id and x.round = old.notes_round
   order by x.producer_id, x.updated_at desc
  on conflict do nothing;
  return null;
end;
$$;

revoke all on function public.capture_feed_follow_call() from public, anon, authenticated;

drop trigger if exists capture_feed_follow_call on public.team_call;
create trigger capture_feed_follow_call
  after update of notes, status on public.team_call
  for each row
  when ((old.notes and not new.notes) or (old.status = 'live' and new.status = 'ended'))
  execute function public.capture_feed_follow_call();

-- ── Who is in it ────────────────────────────────────────────────────────────

-- A person's name as a transcript label: no brackets or line breaks, one space between words,
-- 36 characters at most (the "(2)" that makes it unique stays under 40).
create or replace function public.capture_feed_label_base(raw text, fallback text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(nullif(left(trim(regexp_replace(regexp_replace(coalesce(raw, ''), '[][]+', ' ', 'g'), '[[:space:]]+', ' ', 'g')), 36), ''), fallback);
$$;

-- A label no other roster row of this capture has: "Rosa Lind", then "Rosa Lind (2)".
create or replace function public.capture_feed_unique_label(target_capture uuid, base text)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  candidate text := base;
  n integer := 2;
begin
  while exists (
    select 1 from public.capture_participant p
     where p.capture_id = target_capture and p.source = 'call_roster' and lower(p.speaker_label) = lower(candidate)
  ) or exists (
    select 1 from public.capture_feed_speaker x where x.capture_id = target_capture and lower(x.label) = lower(candidate)
  ) loop
    candidate := base || ' (' || n || ')';
    n := n + 1;
  end loop;
  return candidate;
end;
$$;

create or replace function public.capture_feed_roster(p_session uuid, p_producer_id text, p_events jsonb)
returns table (key text, outcome text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  s public.capture_feed_session%rowtype;
  c public.team_call%rowtype;
  cap public.captures%rowtype;
  ev jsonb;
  ev_key text;
  speaker text;
  kind text;
  ev_at timestamptz;
  sp public.capture_feed_speaker%rowtype;
  ident jsonb;
  person_member uuid;
  person_guest uuid;
  person_name text;
  person_email text;
  participant uuid;
  person_label text;
  owner_member uuid;
begin
  select * into s from public.capture_feed_session x where x.id = p_session for update;
  if not found or s.producer_id is distinct from p_producer_id then
    return query select (e ->> 'key'), (case when s.id is null then 'unknown' else 'taken' end)::text
      from jsonb_array_elements(case when jsonb_typeof(p_events) = 'array' then p_events else '[]'::jsonb end) as e;
    return;
  end if;
  select * into cap from public.captures x where x.id = s.capture_id for update;
  if cap.ended_at is not null then
    return query select (e ->> 'key'), 'locked'::text
      from jsonb_array_elements(case when jsonb_typeof(p_events) = 'array' then p_events else '[]'::jsonb end) as e;
    return;
  end if;
  select * into c from public.team_call t where t.id = s.source_ref;
  owner_member := (select m.id from public.member m where m.user_id = cap.user_id and m.workspace_id = cap.workspace_id);

  for ev in
    select e from jsonb_array_elements(case when jsonb_typeof(p_events) = 'array' then p_events else '[]'::jsonb end) as e
     order by case when jsonb_typeof(e -> 'at_ms') = 'number' then (e ->> 'at_ms')::numeric end nulls last
     limit 500
  loop
    ev_key := left(ev ->> 'key', 128);
    speaker := ev ->> 'speaker';
    kind := ev ->> 'kind';
    if speaker is null or char_length(speaker) not between 1 and 128 or kind not in ('joined', 'left')
       or jsonb_typeof(ev -> 'at_ms') is distinct from 'number' or (ev ->> 'at_ms')::numeric < 0 then
      return query select ev_key, 'invalid'::text;
      continue;
    end if;
    ev_at := s.started_at + make_interval(secs => (ev ->> 'at_ms')::numeric / 1000);

    select * into sp from public.capture_feed_speaker x where x.capture_id = s.capture_id and x.speaker_key = speaker for update;
    if not found then
      ident := ev -> 'identity';
      if jsonb_typeof(ident) is distinct from 'object' then
        return query select ev_key, 'unknown_speaker'::text;
        continue;
      end if;
      person_member := null;
      person_guest := null;
      person_name := null;
      person_email := null;
      begin
        person_member := nullif(ident ->> 'member_id', '')::uuid;
        person_guest := nullif(ident ->> 'guest_id', '')::uuid;
      exception when invalid_text_representation then
        return query select ev_key, 'invalid'::text;
        continue;
      end;
      if person_member is not null then
        -- A member of the workspace who may read the call's conversation now.
        select m.display_name into person_name from public.member m where m.id = person_member and m.workspace_id = s.workspace_id;
        if not found or c.id is null or not public.team_chat_member_can_read(c.channel_id, person_member) then
          return query select ev_key, 'refused'::text;
          continue;
        end if;
        select p.id into participant from public.capture_participant p
         where p.capture_id = s.capture_id and p.source = 'call_roster' and p.member_id = person_member
         limit 1;
        -- The owner's own row, if the app seeded one already (a turn run on the capture): theirs, attested now.
        if participant is null and person_member = owner_member then
          select p.id into participant from public.capture_participant p where p.capture_id = s.capture_id and p.is_self limit 1;
          if participant is not null then
            update public.capture_participant p
               set member_id = person_member,
                   speaker_label = public.capture_feed_unique_label(s.capture_id, public.capture_feed_label_base(person_name, 'Teammate')),
                   self_binding = 'confirmed', source = 'call_roster', role = 'organizer',
                   joined_at = coalesce(p.joined_at, ev_at)
             where p.id = participant;
          end if;
        end if;
      elsif person_guest is not null then
        -- A guest of this call's meeting.
        select g.name into person_name from public.meeting_guest g where g.id = person_guest and c.id is not null and g.channel_id = c.channel_id;
        if not found then
          return query select ev_key, 'refused'::text;
          continue;
        end if;
        select x.participant_id into participant from public.capture_feed_speaker x
         where x.capture_id = s.capture_id and x.guest_id = person_guest
         limit 1;
      else
        person_name := nullif(left(trim(ident ->> 'name'), 120), '');
        person_email := nullif(left(trim(lower(ident ->> 'email')), 254), '');
        if person_name is null then
          return query select ev_key, 'invalid'::text;
          continue;
        end if;
        participant := null;
      end if;

      if participant is null then
        person_label := public.capture_feed_unique_label(
          s.capture_id,
          case
            when person_member is not null then public.capture_feed_label_base(person_name, 'Teammate')
            when person_guest is not null then public.capture_feed_label_base(coalesce(nullif(trim(person_name), ''), 'Guest') || ' (guest)', 'Guest')
            else public.capture_feed_label_base(person_name, 'Guest')
          end
        );
        insert into public.capture_participant (
          capture_id, member_id, contact_id, external_name, external_email, speaker_label, role, joined_at, is_self, self_binding, source
        )
        values (
          s.capture_id,
          person_member,
          case when person_member is not null then (select ct.id from public.contact ct where ct.workspace_id = s.workspace_id and ct.member_id = person_member limit 1) end,
          case when person_member is not null then left(nullif(trim(person_name), ''), 120) else coalesce(left(nullif(trim(person_name), ''), 120), 'Guest') end,
          person_email,
          person_label,
          case when person_member is not null and person_member = owner_member then 'organizer' else 'attendee' end,
          ev_at,
          person_member is not null and person_member = owner_member,
          -- The voice on this track is exactly this member's: the server says so, for each of them.
          case when person_member is not null then 'confirmed' else 'none' end,
          'call_roster'
        )
        returning id into participant;
      else
        select p.speaker_label into person_label from public.capture_participant p where p.id = participant;
      end if;
      insert into public.capture_feed_speaker (capture_id, speaker_key, participant_id, label, member_id, guest_id)
      values (s.capture_id, speaker, participant, coalesce(person_label, 'Teammate'), person_member, person_guest)
      returning * into sp;
    end if;

    if sp.last_event_at is not null and ev_at < sp.last_event_at then
      return query select ev_key, 'stale'::text;
      continue;
    end if;
    update public.capture_feed_speaker x
       set present = (kind = 'joined'), last_event_at = ev_at
     where x.capture_id = sp.capture_id and x.speaker_key = sp.speaker_key;
    if kind = 'joined' then
      update public.capture_participant p
         set joined_at = least(coalesce(p.joined_at, ev_at), ev_at), left_at = null
       where p.id = sp.participant_id;
    else
      update public.capture_participant p
         set left_at = greatest(ev_at, coalesce(p.joined_at, ev_at))
       where p.id = sp.participant_id
         and not exists (
           select 1 from public.capture_feed_speaker o
            where o.participant_id = sp.participant_id and o.present and o.speaker_key <> sp.speaker_key
         );
    end if;
    return query select ev_key, 'applied'::text;
  end loop;
end;
$$;

-- ── What was said ───────────────────────────────────────────────────────────

create or replace function public.capture_feed_append(p_session uuid, p_producer_id text, p_segments jsonb)
returns table (outcome text, accepted integer, duplicate integer, dropped integer, transcript_length integer, capture_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  s public.capture_feed_session%rowtype;
  cap public.captures%rowtype;
  list jsonb := case when jsonb_typeof(p_segments) = 'array' then p_segments else '[]'::jsonb end;
  total integer;
  seg jsonb;
  seg_key text;
  speaker text;
  words text;
  start_at numeric;
  end_at numeric;
  said timestamptz;
  sp public.capture_feed_speaker%rowtype;
  n_accepted integer := 0;
  n_duplicate integer := 0;
  n_dropped integer := 0;
  lines text;
  stored_length integer;
  appended record;
  added text[] := '{}';
begin
  total := jsonb_array_length(list);
  select * into s from public.capture_feed_session x where x.id = p_session for update;
  if not found then
    return query select 'unknown'::text, 0, 0, total, null::integer, null::uuid;
    return;
  end if;
  if s.producer_id is distinct from p_producer_id then
    return query select 'taken'::text, 0, 0, total, null::integer, null::uuid;
    return;
  end if;
  select * into cap from public.captures x where x.id = s.capture_id for update;
  if cap.ended_at is not null or cap.is_transcript_locked then
    return query select 'locked'::text, 0, 0, total, coalesce(char_length(cap.transcript), 0), cap.id;
    return;
  end if;

  for seg in
    select e from jsonb_array_elements(list) as e
     order by case when jsonb_typeof(e -> 'start_ms') = 'number' then (e ->> 'start_ms')::numeric end nulls last
     limit 500
  loop
    seg_key := seg ->> 'key';
    speaker := seg ->> 'speaker';
    words := trim(regexp_replace(coalesce(seg ->> 'text', ''), '[[:space:]]+', ' ', 'g'));
    if seg_key is null or char_length(seg_key) not between 1 and 128 or speaker is null or char_length(speaker) not between 1 and 128
       or words = '' or jsonb_typeof(seg -> 'start_ms') is distinct from 'number' or jsonb_typeof(seg -> 'end_ms') is distinct from 'number' then
      n_dropped := n_dropped + 1;
      continue;
    end if;
    start_at := (seg ->> 'start_ms')::numeric;
    end_at := (seg ->> 'end_ms')::numeric;
    if start_at < 0 or end_at < start_at then
      n_dropped := n_dropped + 1;
      continue;
    end if;
    said := s.started_at + make_interval(secs => start_at / 1000);
    -- Said after the notes went off (or the call ended): never in the notes.
    if s.ended_at is not null and said >= s.ended_at then
      n_dropped := n_dropped + 1;
      continue;
    end if;
    select * into sp from public.capture_feed_speaker x where x.capture_id = s.capture_id and x.speaker_key = speaker;
    if not found then
      n_dropped := n_dropped + 1;
      continue;
    end if;
    -- A meeting's guest is in the notes only once they said go to this round's (574's notice).
    if sp.guest_id is not null and not exists (
      select 1 from public.meeting_guest g where g.id = sp.guest_id and g.notes_ack_round >= s.round
    ) then
      n_dropped := n_dropped + 1;
      continue;
    end if;
    insert into public.capture_feed_segment (session_id, capture_id, key, speaker_key, start_ms, end_ms, said_at, text)
    values (s.id, s.capture_id, seg_key, speaker, floor(start_at)::bigint, floor(end_at)::bigint, said, left(words, 4000))
    on conflict (session_id, key) do nothing;
    if found then
      n_accepted := n_accepted + 1;
      added := added || seg_key;
    else
      n_duplicate := n_duplicate + 1;
    end if;
  end loop;

  stored_length := coalesce(char_length(cap.transcript), 0);
  if n_accepted > 0 then
    select string_agg('[' || x.label || '] ' || g.text, chr(10) order by g.said_at, g.key) into lines
      from public.capture_feed_segment g
      join public.capture_feed_speaker x on x.capture_id = g.capture_id and x.speaker_key = g.speaker_key
     where g.session_id = s.id and g.key = any (added);
    -- 192's compare-and-swap append (the capture's row is locked here, so it applies).
    select * into appended from public.append_capture_transcript(
      cap.id, cap.workspace_id, case when stored_length > 0 then chr(10) else '' end || lines, stored_length
    );
    if appended.status is distinct from 'applied' then
      raise exception 'capture feed: the transcript did not take the append (%)', appended.status using errcode = '40001';
    end if;
    stored_length := appended.server_length;
    update public.capture_feed_session x set segments = x.segments + n_accepted, updated_at = now() where x.id = s.id;
  end if;
  return query select 'applied'::text, n_accepted, n_duplicate, n_dropped, stored_length, cap.id;
end;
$$;

-- ── The sweeper and the recorder's work ─────────────────────────────────────

create or replace function public.capture_feed_mark_lost(stale_seconds integer)
returns table (session_id uuid, capture_id uuid, source_ref uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  r public.capture_feed_session%rowtype;
begin
  for r in
    select x.*
      from public.capture_feed_session x
     where x.status = 'live'
       and x.heartbeat_at < now() - make_interval(secs => greatest(coalesce(stale_seconds, 90), 30))
     order by x.heartbeat_at
     limit 200
  loop
    update public.capture_feed_session x
       set status = 'lost', gaps = x.gaps || jsonb_build_array(jsonb_build_object('from', r.heartbeat_at)), updated_at = now()
     where x.id = r.id and x.status = 'live';
    perform public.capture_feed_recorder_state(r.capture_id, 'lost');
    -- A producer that stopped saying it runs is no longer trusted in the room.
    perform public.capture_feed_eject_producer(r);
    return query select r.id, r.capture_id, r.source_ref;
  end loop;
end;
$$;

-- The sweeper: a producer in a room whose call wants no feed of it any more (notes off, the call
-- over, the capture closed) or that went quiet, seen in the last 15 minutes, is put on the eject outbox
-- again, so nothing keeps hearing a call that has no notes, whatever a producer does. Returns how
-- many were queued.
create or replace function public.capture_feed_fence_producers()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  -- Not a producer the call wants now (capture_feed_producer_wanted, the drain's own check: one
  -- that started the current round's session is left alone, before its join as after it).
  insert into public.team_call_eject (call_id, room, identity, reason, feed_session)
  select distinct on (t.id, x.producer_id) t.id, t.room, left('notes-recorder-' || x.producer_id, 64), 'access', x.id
    from public.capture_feed_session x
    join public.team_call t on t.id = x.source_ref
   where x.source_kind = 'team_call'
     and x.updated_at > now() - interval '15 minutes'
     and t.status = 'live'
     and not public.capture_feed_producer_wanted(t.id, x.producer_id)
   order by t.id, x.producer_id, x.updated_at desc
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.team_call_recorder_work(p_producer_id text, p_running uuid[], max_jobs integer)
returns table (call_id uuid, room text, round integer, channel_kind text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.id, t.room, t.notes_round, ch.kind
    from public.team_call t
    join public.team_chat_channel ch on ch.id = t.channel_id
    left join public.capture_feed_session x
      on x.source_kind = 'team_call' and x.source_ref = t.id and x.round = t.notes_round
   where t.status = 'live'
     and t.notes
     and not (t.id = any (coalesce(p_running, '{}'::uuid[])))
     and (x.id is null or not public.capture_feed_capture_closed(x.capture_id))
     and (
       x.id is null
       or (x.status <> 'ended' and (x.producer_id = p_producer_id or x.status = 'lost' or x.heartbeat_at < now() - interval '30 seconds'))
     )
   order by t.notes_on_since
   limit greatest(coalesce(max_jobs, 0), 0);
$$;

-- ── The transcript in the order said ────────────────────────────────────────

-- Words as a quote is matched against them: lower case, an apostrophe dropped (a contraction is
-- one word: "I'll" is "ill"), anything else that is not a letter or digit a space, one space
-- between words.
create or replace function public.capture_feed_norm(raw text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select trim(regexp_replace(translate(lower(coalesce(raw, '')), '''' || chr(8217), ''), '[^[:alnum:]]+', ' ', 'g'));
$$;

-- A capture's lines in the order things were said: every segment, by when it was said; a
-- speaker's stretches with nobody between them, less than 1.5 s apart, run together as one line
-- (src/lib/team-calls/notes.ts mergeNotes, the same rule). Read in the database, whole: no row cap.
create or replace function public.capture_feed_lines(p_capture uuid)
returns table (line_no bigint, speaker_key text, participant_id uuid, label text, text text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with g as (
    select s.said_at, s.key, s.text, s.speaker_key, x.label, x.participant_id,
           s.said_at + make_interval(secs => (s.end_ms - s.start_ms) / 1000.0) as ends
      from public.capture_feed_segment s
      join public.capture_feed_speaker x on x.capture_id = s.capture_id and x.speaker_key = s.speaker_key
     where s.capture_id = p_capture
  ),
  o as (
    select g.*, lag(g.speaker_key) over w as prev_speaker, lag(g.ends) over w as prev_end
      from g
    window w as (order by g.said_at, g.ends, g.key)
  ),
  m as (
    select o.*,
           sum(case when o.prev_speaker is distinct from o.speaker_key or o.said_at - o.prev_end > interval '1.5 seconds' then 1 else 0 end)
             over (order by o.said_at, o.ends, o.key) as n
      from o
  )
  select m.n, min(m.speaker_key), (array_agg(m.participant_id))[1], min(m.label), string_agg(m.text, ' ' order by m.said_at, m.ends, m.key)
    from m
   group by m.n;
$$;

-- Who said a quote: the participant rows of the lines that hold it, as whole words. A quote of
-- fewer than five words, unless it has 20 letters and spaces or more, names no one ("I'll do it"
-- could be anyone's). The live agent's gate files an action as its assignee's own only when the
-- one row that said it is that member's own roster row.
create or replace function public.capture_feed_quote_speakers(p_capture uuid, p_quote text)
returns table (participant_id uuid, member_id uuid, source text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with q as (select public.capture_feed_norm(p_quote) as t)
  select distinct l.participant_id, p.member_id, p.source
    from q
    cross join public.capture_feed_lines(p_capture) l
    left join public.capture_participant p on p.id = l.participant_id
   where q.t <> ''
     and (array_length(regexp_split_to_array(q.t, ' '), 1) >= 5 or char_length(q.t) >= 20)
     and position(' ' || q.t || ' ' in ' ' || public.capture_feed_norm(l.text) || ' ') > 0;
$$;

-- ── The end ─────────────────────────────────────────────────────────────────

create or replace function public.team_call_capture_lock(target_call uuid, preamble_text text, rebuild boolean)
returns table (outcome text, capture_id uuid, owner_user uuid, workspace_id uuid, spoke boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  c public.team_call%rowtype;
  cap public.captures%rowtype;
  n integer;
  ended timestamptz;
  ordered text;
  earlier uuid;
begin
  select * into c from public.team_call t where t.id = target_call for update;
  if not found or c.capture_id is null then
    return query select 'none'::text, null::uuid, null::uuid, null::uuid, false;
    return;
  end if;
  if c.status <> 'ended' then
    return query select 'live'::text, c.capture_id, null::uuid, c.workspace_id, false;
    return;
  end if;
  -- The call is over: so is every feed of it.
  update public.capture_feed_session x
     set status = 'ended', ended_at = coalesce(x.ended_at, now()), end_reason = coalesce(x.end_reason, 'call_ended'),
         gaps = public.capture_feed_close_gap(x.gaps, x.status), updated_at = now()
   where x.source_kind = 'team_call' and x.source_ref = c.id and x.status <> 'ended';
  select * into cap from public.captures x where x.id = c.capture_id for update;
  select count(*)::integer into n from public.capture_feed_segment g where g.capture_id = cap.id;
  if cap.ended_at is not null then
    -- Ended already (a second finish, or its owner ended it by hand): the notes are ready. Its
    -- end-of-meeting pass is the caller's unless it was finished already (team_call_capture_finish,
    -- whose pass is its own, asked for again by the sweeper until done).
    update public.team_call t set notes_state = 'ready', updated_at = now() where t.id = c.id and t.notes_state <> 'ready';
    if exists (select 1 from public.team_call_capture r where r.call_id = c.id and r.capture_id = cap.id and r.finished_at is not null) then
      return query select 'done'::text, cap.id, cap.user_id, cap.workspace_id, n > 0;
      return;
    end if;
    update public.team_call_capture r set finished_at = now() where r.call_id = c.id and r.capture_id = cap.id;
    return query select 'ready'::text, cap.id, cap.user_id, cap.workspace_id, n > 0;
    return;
  end if;
  if n = 0 and coalesce(trim(cap.user_notes), '') = '' and not cap.is_transcript_locked then
    -- Nothing was said: no capture is left behind. The call links back to an earlier capture of
    -- its own that holds words (one its owner ended by hand, notes on again after), else silent.
    delete from public.entity_access g where g.entity_type = 'capture' and g.entity_id = cap.id;
    delete from public.captures x where x.id = cap.id;
    select r.capture_id into earlier
      from public.team_call_capture r
      join public.captures x on x.id = r.capture_id
     where r.call_id = c.id
       and (exists (select 1 from public.capture_feed_segment g where g.capture_id = x.id)
            or coalesce(trim(x.user_notes), '') <> '' or coalesce(trim(x.transcript), '') <> '')
     order by r.created_at desc
     limit 1;
    if earlier is not null then
      update public.team_call t set capture_id = earlier, notes_state = 'ready', updated_at = now() where t.id = c.id;
    else
      update public.team_call t set notes_state = 'silent', updated_at = now() where t.id = c.id and t.notes_state in ('capturing', 'transcribing');
    end if;
    return query select 'silent'::text, earlier, null::uuid, c.workspace_id, false;
    return;
  end if;
  -- Every segment, in the order said, read here in the database (the capture's row is locked, so
  -- nothing is appended meanwhile, and no read is capped at a page).
  -- Its owner locked the transcript by hand: it stays as they left it (the capture still ends).
  if coalesce(rebuild, true) and n > 0 and not cap.is_transcript_locked then
    select string_agg('[' || l.label || '] ' || l.text, chr(10) order by l.line_no) into ordered
      from public.capture_feed_lines(cap.id) l;
  end if;
  ended := greatest(coalesce(c.ended_at, now()), cap.started_at);
  update public.captures x
     set transcript = coalesce(ordered, x.transcript),
         user_notes = case
           when coalesce(trim(preamble_text), '') = '' then x.user_notes
           when coalesce(trim(x.user_notes), '') = '' then preamble_text
           else preamble_text || chr(10) || chr(10) || x.user_notes
         end,
         ended_at = ended,
         duration_seconds = greatest(0, floor(extract(epoch from (ended - x.started_at))))::integer,
         metadata = coalesce(x.metadata, '{}'::jsonb) || jsonb_build_object('notes_recorder', 'done')
   where x.id = cap.id;
  update public.capture_participant p
     set left_at = greatest(ended, coalesce(p.joined_at, ended))
   where p.capture_id = cap.id and p.source = 'call_roster' and p.left_at is null and p.joined_at is not null;
  update public.capture_feed_speaker x set present = false where x.capture_id = cap.id and x.present;
  update public.team_call t set notes_state = 'ready', updated_at = now() where t.id = c.id;
  update public.team_call_capture r set finished_at = now() where r.call_id = c.id and r.capture_id = cap.id;
  return query select 'ready'::text, cap.id, cap.user_id, cap.workspace_id, n > 0;
end;
$$;

-- A call's capture its owner ended (or locked) by hand, finished then, whether or not notes come on
-- again: its feeds end, it ends (ended_at, duration; its transcript is never written: it is theirs
-- now), its people have left, it is the recorder's no more ('done': a person may edit it again once
-- it is unlocked), and its record says finished. 'ready' when this call finished it (the caller
-- runs its end-of-meeting pass); 'done' when it was finished already; 'open' while it is not closed;
-- 'none' when it is no call's.
create or replace function public.team_call_capture_finish(target_capture uuid)
returns table (outcome text, call_id uuid, capture_id uuid, owner_user uuid, workspace_id uuid, spoke boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  r public.team_call_capture%rowtype;
  c public.team_call%rowtype;
  cap public.captures%rowtype;
  n integer;
  ended timestamptz;
begin
  select * into r from public.team_call_capture x where x.capture_id = target_capture limit 1;
  if not found then
    return query select 'none'::text, null::uuid, target_capture, null::uuid, null::uuid, false;
    return;
  end if;
  -- Lock order, as everywhere: the call, then its sessions, then the capture (capture_feed_append
  -- takes a session, then its capture; the lock, the call first).
  select * into c from public.team_call t where t.id = r.call_id for update;
  select * into r from public.team_call_capture x where x.call_id = r.call_id and x.capture_id = target_capture for update;
  if r.pass_done_at is not null then
    return query select 'done'::text, r.call_id, target_capture, null::uuid, r.workspace_id, false;
    return;
  end if;
  -- Read without a lock first: an open capture is left as it is, and no session is locked for it.
  select * into cap from public.captures x where x.id = target_capture;
  if not found or not (cap.ended_at is not null or cap.is_transcript_locked) then
    return query select 'open'::text, r.call_id, target_capture, null::uuid, r.workspace_id, false;
    return;
  end if;
  select count(*)::integer into n from public.capture_feed_segment g where g.capture_id = target_capture;
  if r.finished_at is not null then
    -- Ended already; its pass is not done yet (the last ask gave out): the caller runs it.
    return query select 'ready'::text, r.call_id, cap.id, cap.user_id, cap.workspace_id, n > 0;
    return;
  end if;
  update public.capture_feed_session x
     set status = 'ended', ended_at = coalesce(x.ended_at, now()), end_reason = coalesce(x.end_reason, 'capture_closed'),
         gaps = public.capture_feed_close_gap(x.gaps, x.status), updated_at = now()
   where x.capture_id = target_capture and x.status <> 'ended';
  select * into cap from public.captures x where x.id = target_capture for update;
  ended := greatest(coalesce(cap.ended_at, now()), cap.started_at);
  update public.captures x
     set ended_at = ended,
         duration_seconds = case when cap.ended_at is null then greatest(0, floor(extract(epoch from (ended - x.started_at))))::integer else x.duration_seconds end,
         metadata = coalesce(x.metadata, '{}'::jsonb) || jsonb_build_object('notes_recorder', 'done')
   where x.id = cap.id;
  update public.capture_participant p
     set left_at = greatest(ended, coalesce(p.joined_at, ended))
   where p.capture_id = cap.id and p.source = 'call_roster' and p.left_at is null and p.joined_at is not null;
  update public.capture_feed_speaker x set present = false where x.capture_id = cap.id and x.present;
  update public.team_call_capture x set finished_at = now() where x.call_id = r.call_id and x.capture_id = cap.id;
  return query select 'ready'::text, r.call_id, cap.id, cap.user_id, cap.workspace_id, n > 0;
end;
$$;

-- A call capture's end-of-meeting pass is done (the finish, after its post-extraction step).
create or replace function public.team_call_capture_pass_done(target_capture uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  with done as (
    update public.team_call_capture r set pass_done_at = now()
     where r.capture_id = target_capture and r.pass_done_at is null
    returning 1
  )
  select exists (select 1 from done);
$$;

-- The sweeper: a call's capture that is closed (by hand, or by the call's end) and whose
-- end-of-meeting pass is not done, last asked for at least 30 minutes ago (a running finish has its
-- time), is asked for again: 'retry', with how many times now; at most max_attempts times, then
-- 'given_up' (once). A capture still filling in is never in it.
create or replace function public.team_call_closed_captures(max_rows integer, max_attempts integer)
returns table (kind text, call_id uuid, capture_id uuid, attempt integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  return query
  with spent as (
    update public.team_call_capture r
       set pass_given_up_at = now()
      from public.captures x
     where x.id = r.capture_id
       and r.pass_done_at is null and r.pass_given_up_at is null
       and r.pass_attempts >= greatest(coalesce(max_attempts, 3), 1)
       and coalesce(r.pass_asked_at, r.finished_at, x.ended_at, r.created_at) < now() - interval '30 minutes'
       and (x.ended_at is not null or x.is_transcript_locked)
    returning r.call_id, r.capture_id, r.pass_attempts
  )
  select 'given_up'::text, spent.call_id, spent.capture_id, spent.pass_attempts from spent;

  return query
  with picked as (
    select r.call_id, r.capture_id
      from public.team_call_capture r
      join public.captures x on x.id = r.capture_id
     where r.pass_done_at is null and r.pass_given_up_at is null
       and r.pass_attempts < greatest(coalesce(max_attempts, 3), 1)
       and coalesce(r.pass_asked_at, r.finished_at, x.ended_at, r.created_at) < now() - interval '30 minutes'
       and (x.ended_at is not null or x.is_transcript_locked)
     order by r.created_at
     limit greatest(coalesce(max_rows, 0), 0)
       for update of r skip locked
  ),
  asked as (
    update public.team_call_capture r
       set pass_attempts = r.pass_attempts + 1, pass_asked_at = now()
      from picked
     where r.call_id = picked.call_id and r.capture_id = picked.capture_id
    returning r.call_id, r.capture_id, r.pass_attempts
  )
  select 'retry'::text, asked.call_id, asked.capture_id, asked.pass_attempts from asked;
end;
$$;

revoke all on function public.team_call_notes_owner(public.team_call) from public, anon, authenticated;
revoke all on function public.team_call_capture_ensure(uuid, text) from public, anon, authenticated;
revoke all on function public.team_call_feed_unwanted(uuid, integer) from public, anon, authenticated;
revoke all on function public.capture_feed_hearable_guests(public.capture_feed_session) from public, anon, authenticated;
revoke all on function public.capture_feed_capture_closed(uuid) from public, anon, authenticated;
revoke all on function public.capture_feed_eject_producer(public.capture_feed_session) from public, anon, authenticated;
revoke all on function public.capture_feed_producer_wanted(uuid, text) from public, anon, authenticated;
revoke all on function public.capture_feed_settle_ejects() from public, anon, authenticated;
revoke all on function public.capture_feed_start(text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.capture_feed_close_gap(jsonb, text) from public, anon, authenticated;
revoke all on function public.capture_feed_recorder_state(uuid, text) from public, anon, authenticated;
revoke all on function public.capture_feed_heartbeat(text, uuid[]) from public, anon, authenticated;
revoke all on function public.capture_feed_end(uuid, text, text) from public, anon, authenticated;
revoke all on function public.capture_feed_label_base(text, text) from public, anon, authenticated;
revoke all on function public.capture_feed_unique_label(uuid, text) from public, anon, authenticated;
revoke all on function public.capture_feed_roster(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.capture_feed_append(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.capture_feed_mark_lost(integer) from public, anon, authenticated;
revoke all on function public.capture_feed_fence_producers() from public, anon, authenticated;
revoke all on function public.team_call_recorder_work(text, uuid[], integer) from public, anon, authenticated;
revoke all on function public.capture_feed_norm(text) from public, anon, authenticated;
revoke all on function public.capture_feed_lines(uuid) from public, anon, authenticated;
revoke all on function public.capture_feed_quote_speakers(uuid, text) from public, anon, authenticated;
revoke all on function public.team_call_capture_lock(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.team_call_capture_finish(uuid) from public, anon, authenticated;
revoke all on function public.team_call_capture_pass_done(uuid) from public, anon, authenticated;
revoke all on function public.team_call_closed_captures(integer, integer) from public, anon, authenticated;
grant execute on function public.team_call_capture_finish(uuid) to service_role;
grant execute on function public.team_call_capture_pass_done(uuid) to service_role;
grant execute on function public.team_call_closed_captures(integer, integer) to service_role;
grant execute on function public.team_call_capture_ensure(uuid, text) to service_role;
grant execute on function public.capture_feed_start(text, uuid, text, text, text) to service_role;
grant execute on function public.capture_feed_heartbeat(text, uuid[]) to service_role;
grant execute on function public.capture_feed_end(uuid, text, text) to service_role;
grant execute on function public.capture_feed_roster(uuid, text, jsonb) to service_role;
grant execute on function public.capture_feed_append(uuid, text, jsonb) to service_role;
grant execute on function public.capture_feed_mark_lost(integer) to service_role;
grant execute on function public.capture_feed_fence_producers() to service_role;
grant execute on function public.capture_feed_settle_ejects() to service_role;
grant execute on function public.team_call_recorder_work(text, uuid[], integer) to service_role;
grant execute on function public.capture_feed_quote_speakers(uuid, text) to service_role;
grant execute on function public.team_call_capture_lock(uuid, text, boolean) to service_role;

notify pgrst, 'reload schema';

commit;

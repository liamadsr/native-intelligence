-- ============================================================
-- 655: The live agent on a call's capture, driven by the server (one
-- recorder per call, phase 2). Since 587-589 the call recorder fills one
-- capture per call as people speak; nobody's device runs the live agent on
-- it, so until now the call's notes were written only once the call ended.
-- Now the app runs the live agent's own turns on that capture as the words
-- arrive (src/lib/team-calls/live-turns.ts), as the capture's owner, with no
-- device in the loop and whoever is in the call. This file is the record
-- that keeps those turns throttled, one at a time across every app process,
-- bounded per call, stopped at the call's end, and the narrow row the people
-- in the call read the notes from.
-- ============================================================
--   team_call_live_agent  one row per call capture the live agent writes
--                      (server only). A turn has two stages, kept apart so a
--                      queue that backs up makes the notes slower, never
--                      stops them:
--                        queued   the claim handed a turn to the queue
--                                 (queued_id, queued_at, queued_until):
--                                 nothing more is offered for the capture
--                                 while it waits, for supersede_seconds;
--                                 nothing is counted. A mark older than that
--                                 may be an event that never runs (lost, or a
--                                 function not yet registered after a
--                                 deploy): the next claim queues a fresh one
--                                 and keeps the old one valid beside it
--                                 (prev_queued_id), so whichever event runs
--                                 first begins the turn and the other is
--                                 stale. A lost event costs supersede_seconds,
--                                 not the queue's bound, and a slow queue is
--                                 never starved (its old event stays valid).
--                        running  the queued turn began (its run started):
--                                 lease_id, lease_until; only now is it a
--                                 turn (turns, the bound per call) and the
--                                 throttle's clock (last_turn_at). A queued
--                                 turn that waited past queued_until is
--                                 stale when it starts: skipped, never a
--                                 failure, never a turn; the next claim
--                                 queues a fresh one with the same words.
--                      done_offset: how far into the capture's transcript
--                      the turns have read (in characters: what a turn that
--                      went through, or whose answer never came back, has
--                      sent; a failed turn leaves it, so its words go with
--                      the next one); done_tail: a fingerprint of the
--                      characters just before it, so a transcript that was
--                      rewritten under it (never expected while the
--                      recorder fills it: every person's write is refused
--                      then, src/lib/capture-feed/transcript.ts) starts a
--                      fresh window rather than sending text from the
--                      middle of a line. failures, failures_in_row: a run
--                      of failed turns that ran stops the agent for the
--                      call. state: 'idle', 'working', 'ready', 'failed' or
--                      'stopped' (stop_reason: the call ended, its capture
--                      was closed, the owner may no longer read the
--                      conversation, the bound, a run of failures, or the
--                      owner's usage).
--   team_call_live_notes  what the people in the call read: per call capture
--                      the summary as the live agent last wrote it (a copy
--                      of captures.ai_summary, kept by a trigger), and the
--                      agent's state (state, state_at, until: when a running
--                      turn's lease runs out, so a dead process never shows
--                      "writing" for ever; turns, reason). Small on purpose:
--                      the panel follows this row over Realtime instead of
--                      the capture's own row, which carries the whole
--                      transcript and changes with every batch of words.
--                      Read by a signed-in person only when they may read
--                      the capture itself (its policy asks captures, under
--                      the capture's own read rules, 566's conversation
--                      fence included), so it reaches no one the capture
--                      does not.
--
-- Functions (the service role's alone; definers, search_path pinned):
--   team_call_live_turn_claim(capture, ...)  may a turn be queued now? It
--     locks the row, checks the call (live, this capture its current one,
--     notes on), the capture (open, its owner still in the conversation and
--     the workspace) and the bound, refuses while a turn is queued or
--     running, then the throttle: not within min_interval_seconds of the
--     last turn's start, never with fewer than min_chars new characters,
--     and with fewer than ready_chars only once quiet_seconds have passed.
--     A turn that may be queued gets a queue mark for queue_seconds.
--   team_call_live_turn_begin(capture, queued, ...)  the queued turn's run
--     starts: it becomes the running turn (the lease for lease_seconds) and
--     counts, once; 'stale' when the mark ran out or is not this one.
--   team_call_live_turn_unqueue(capture, queued)  a turn that was never
--     handed over (the send failed): the mark is taken back, nothing counted.
--   team_call_live_turn_window(capture, lease, ...)  the words the running
--     turn sends: from done_offset on (at most max_chars, cut at a line's
--     end), and up to context_chars before it as context. Nothing once the
--     lease is not this turn's; nothing once the call is over, and the agent
--     is stopped then.
--   team_call_live_turn_release(capture, lease, outcome, ...)  the running
--     turn is over: 'ok' moves done_offset to what it sent; 'unknown' (its
--     answer never came back: the route may still be writing) moves it too,
--     so the words are never sent twice, and keeps the lease to its end, so
--     the call's finish still waits for it; 'failed' leaves it; 'stopped'
--     ends the agent for the capture. A lease that is no longer this turn's
--     changes nothing ('stale').
--   team_call_live_turn_lease_until(capture, lease)  the running turn's
--     lease end, or null when `lease` is not running: the live agent's route
--     takes a server turn only while it holds the lease (its key is bound to
--     the lease), and stops the turn's tools at the lease's end.
--   team_call_live_turn_busy(capture)  is a turn RUNNING now (a queued one
--     is not: the call's finish waits only for a turn that can still write).
--
-- RLS on both new tables; team_call_live_agent has no client grant;
-- team_call_live_notes is the signed-in person's to read only (SELECT, its
-- one policy), published to Realtime. Additive. Idempotent. Safe on a live
-- database with the deployed app running: two new empty tables, a trigger on
-- captures that acts only on a call's capture with a live notes row (none
-- until the switch is on), and new functions the deployed app never calls.
-- The new tables' foreign keys and the trigger take a SHARE ROW EXCLUSIVE lock
-- on captures, team_call and workspace (writes wait, reads do not; the trigger
-- is created or replaced, never dropped, so no exclusive lock): apply it with
-- no call live and at a quiet moment. lock_timeout bounds each statement's
-- wait to 5 s (per statement: the file waits at most a few times that), and
-- past it the file rolls back whole and can be applied again. No
-- backslashes anywhere in this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

create table if not exists public.team_call_live_agent (
  capture_id uuid primary key references public.captures(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  call_id uuid not null references public.team_call(id) on delete cascade,
  state text not null default 'idle' check (state in ('idle', 'working', 'ready', 'failed', 'stopped')),
  stop_reason text check (stop_reason is null or char_length(stop_reason) <= 40),
  turns integer not null default 0 check (turns >= 0),
  failures integer not null default 0 check (failures >= 0),
  failures_in_row integer not null default 0 check (failures_in_row >= 0),
  done_offset integer not null default 0 check (done_offset >= 0),
  done_tail text,
  queued_id uuid,
  queued_at timestamptz,
  queued_until timestamptz,
  prev_queued_id uuid,
  prev_queued_until timestamptz,
  lease_id uuid,
  lease_until timestamptz,
  last_turn_at timestamptz,
  last_ok_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_call_live_agent_queue check ((queued_id is null) = (queued_until is null) and (queued_id is null) = (queued_at is null)),
  constraint team_call_live_agent_prev check ((prev_queued_id is null) = (prev_queued_until is null)),
  constraint team_call_live_agent_lease check ((lease_id is null) = (lease_until is null)),
  constraint team_call_live_agent_stopped check ((state = 'stopped') = (stop_reason is not null))
);
create index if not exists team_call_live_agent_call_idx on public.team_call_live_agent (call_id);

alter table public.team_call_live_agent enable row level security;
revoke all on table public.team_call_live_agent from anon, authenticated;
grant select, insert, update, delete on table public.team_call_live_agent to service_role;

comment on table public.team_call_live_agent is
  'The live agent''s turns on a call''s capture, run by the server as the words arrive (655): queued and running turns, the throttle, the bound, the stop. Server only.';

create table if not exists public.team_call_live_notes (
  capture_id uuid primary key references public.captures(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  summary text not null default '',
  state text not null default 'idle' check (state in ('idle', 'working', 'ready', 'failed', 'stopped')),
  state_at timestamptz not null default now(),
  until timestamptz,
  turns integer not null default 0 check (turns >= 0),
  reason text check (reason is null or char_length(reason) <= 40),
  updated_at timestamptz not null default now()
);

alter table public.team_call_live_notes enable row level security;
revoke all on table public.team_call_live_notes from anon, authenticated;
grant select on table public.team_call_live_notes to authenticated;
grant select, insert, update, delete on table public.team_call_live_notes to service_role;

-- Read only by someone who may read the capture itself: the subquery runs under the capture's own
-- read policies as the reader (566's conversation fence included), so the notes reach no one the
-- capture does not, and lose a reader the moment the capture does.
drop policy if exists team_call_live_notes_read on public.team_call_live_notes;
create policy team_call_live_notes_read on public.team_call_live_notes
  for select to authenticated
  using (exists (select 1 from public.captures c where c.id = team_call_live_notes.capture_id));

comment on table public.team_call_live_notes is
  'A call''s shared live notes as the people in it read them (655): the summary the live agent wrote and its state. Read only by who may read the capture.';

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'team_call_live_notes') then
      alter publication supabase_realtime add table public.team_call_live_notes;
    end if;
  end if;
end $$;

-- The agent's state, as the readers see it (the narrow row; made the first time, with the summary).
create or replace function public.team_call_live_notes_stamp(target_capture uuid, notes_state text, notes_until timestamptz, turn_count integer, reason text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.team_call_live_notes (capture_id, workspace_id, summary, state, state_at, until, turns, reason, updated_at)
  select x.id, x.workspace_id, coalesce(x.ai_summary, ''), notes_state, now(), notes_until, turn_count, reason, now()
    from public.captures x
   where x.id = target_capture
  on conflict (capture_id) do update
     set state = excluded.state, state_at = excluded.state_at, until = excluded.until,
         turns = excluded.turns, reason = excluded.reason, updated_at = excluded.updated_at,
         -- Re-read on every stamp: a summary written while the row was first made (its trigger saw
         -- no row yet) is caught up at the next stamp, never left behind.
         summary = excluded.summary;
$$;

-- The summary the live agent writes on a call's capture, copied to the narrow row the readers follow.
-- Only a call's capture (notes_channel_id) that has a live notes row: nothing for any other capture.
create or replace function public.team_call_live_notes_summary_sync()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.team_call_live_notes n
     set summary = coalesce(new.ai_summary, ''), updated_at = now()
   where n.capture_id = new.id;
  return new;
end;
$$;

-- Create or replace (Postgres 14 and later: the Supabase stack runs 17), never drop and create: a
-- drop takes an ACCESS EXCLUSIVE lock on captures that stalls every read of it while it waits.
create or replace trigger team_call_live_notes_summary_sync
  after update of ai_summary on public.captures
  for each row
  when (new.notes_channel_id is not null and old.ai_summary is distinct from new.ai_summary)
  execute function public.team_call_live_notes_summary_sync();

-- Stop the agent for a capture, once.
create or replace function public.team_call_live_turn_stop(target_capture uuid, reason text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  update public.team_call_live_agent a
     set state = 'stopped', stop_reason = left(reason, 40), lease_id = null, lease_until = null,
         queued_id = null, queued_at = null, queued_until = null, prev_queued_id = null, prev_queued_until = null, updated_at = now()
   where a.capture_id = target_capture and a.state <> 'stopped'
  returning a.turns into n;
  if n is not null then
    perform public.team_call_live_notes_stamp(target_capture, 'stopped', null, n, left(reason, 40));
  end if;
  return coalesce(n, 0);
end;
$$;

-- Why no turn may run on this capture any more ('call_ended', 'owner_out'), or null. The row is locked
-- by the caller; the call is the capture's (587's record of every capture a call made).
create or replace function public.team_call_live_turn_unwanted(target_capture uuid, call_ref uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  c public.team_call%rowtype;
  cap_workspace uuid;
  cap_owner uuid;
  cap_ended timestamptz;
  cap_locked boolean;
  cap_owner_out boolean;
begin
  select * into c from public.team_call t where t.id = call_ref;
  select x.workspace_id, x.user_id, x.ended_at, coalesce(x.is_transcript_locked, false), coalesce(x.notes_owner_out, false)
    into cap_workspace, cap_owner, cap_ended, cap_locked, cap_owner_out
    from public.captures x
   where x.id = target_capture;
  if c.id is null or cap_workspace is null or c.status <> 'live' or c.capture_id is distinct from target_capture
     or cap_ended is not null or cap_locked then
    return 'call_ended';
  end if;
  -- A turn runs as the capture's owner: one who may no longer read the conversation (568), or who
  -- left the workspace, writes nothing more into it.
  if cap_owner is null or cap_owner_out
     or not exists (select 1 from public.member m where m.user_id = cap_owner and m.workspace_id = cap_workspace) then
    return 'owner_out';
  end if;
  return null;
end;
$$;

create or replace function public.team_call_live_turn_claim(
  target_capture uuid,
  min_interval_seconds integer,
  min_chars integer,
  ready_chars integer,
  quiet_seconds integer,
  max_turns integer,
  queue_seconds integer,
  supersede_seconds integer
)
returns table (outcome text, lease uuid, turn_no integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  c public.team_call%rowtype;
  cap_workspace uuid;
  cap_length integer;
  r public.team_call_live_agent%rowtype;
  unwanted text;
  fresh integer;
  since double precision;
  made uuid;
begin
  select t.* into c
    from public.team_call_capture tc
    join public.team_call t on t.id = tc.call_id
   where tc.capture_id = target_capture
   order by tc.created_at desc
   limit 1;
  if not found then
    return query select 'not_a_call'::text, null::uuid, 0;
    return;
  end if;
  select x.workspace_id, char_length(coalesce(x.transcript, '')) into cap_workspace, cap_length
    from public.captures x
   where x.id = target_capture;
  if cap_workspace is null then
    return query select 'not_a_call'::text, null::uuid, 0;
    return;
  end if;

  insert into public.team_call_live_agent (capture_id, workspace_id, call_id)
  values (target_capture, cap_workspace, c.id)
  on conflict (capture_id) do nothing;
  select a.* into r from public.team_call_live_agent a where a.capture_id = target_capture for update;

  if r.state = 'stopped' then
    return query select 'stopped'::text, null::uuid, r.turns;
    return;
  end if;
  unwanted := public.team_call_live_turn_unwanted(target_capture, c.id);
  if unwanted is not null then
    perform public.team_call_live_turn_stop(target_capture, unwanted);
    return query select 'stopped'::text, null::uuid, r.turns;
    return;
  end if;
  if r.turns >= max_turns then
    perform public.team_call_live_turn_stop(target_capture, 'bound');
    return query select 'stopped'::text, null::uuid, r.turns;
    return;
  end if;
  -- Notes off for now: nothing new is heard; they may come on again into this capture.
  if not c.notes then
    return query select 'notes_off'::text, null::uuid, r.turns;
    return;
  end if;
  -- One at a time: a turn running, or one queued in the last supersede_seconds.
  if (r.lease_until is not null and r.lease_until > now())
     or (r.queued_until is not null and r.queued_until > now() and r.queued_at > now() - make_interval(secs => greatest(supersede_seconds, 30))) then
    return query select 'busy'::text, null::uuid, r.turns;
    return;
  end if;

  -- A transcript shorter than where the turns stopped was rewritten under them: all of it is new
  -- (the window starts it afresh, team_call_live_turn_window).
  fresh := case when cap_length < r.done_offset then cap_length else cap_length - r.done_offset end;
  since := extract(epoch from (now() - coalesce(r.last_turn_at, r.created_at)));
  if r.last_turn_at is not null and since < min_interval_seconds then
    return query select 'too_soon'::text, null::uuid, r.turns;
    return;
  end if;
  if fresh < min_chars then
    return query select 'too_few_words'::text, null::uuid, r.turns;
    return;
  end if;
  if fresh < ready_chars and since < quiet_seconds then
    return query select 'waiting'::text, null::uuid, r.turns;
    return;
  end if;

  made := gen_random_uuid();
  -- A mark still valid but older than supersede_seconds stays valid beside the new one: its event
  -- may yet run (a slow queue), and whichever runs first begins the turn.
  update public.team_call_live_agent a
     set prev_queued_id = case when a.queued_until > now() then a.queued_id
                               when a.prev_queued_until > now() then a.prev_queued_id else null end,
         prev_queued_until = case when a.queued_until > now() then a.queued_until
                                  when a.prev_queued_until > now() then a.prev_queued_until else null end,
         queued_id = made,
         queued_at = now(),
         queued_until = now() + make_interval(secs => greatest(queue_seconds, 60)),
         updated_at = now()
   where a.capture_id = target_capture;
  return query select 'queued'::text, made, r.turns;
end;
$$;

create or replace function public.team_call_live_turn_begin(target_capture uuid, queued uuid, lease_seconds integer, max_turns integer)
returns table (outcome text, turn_no integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  r public.team_call_live_agent%rowtype;
  unwanted text;
begin
  select a.* into r from public.team_call_live_agent a where a.capture_id = target_capture for update;
  if not found then
    return query select 'stale'::text, 0;
    return;
  end if;
  if r.state = 'stopped' then
    return query select 'stopped'::text, r.turns;
    return;
  end if;
  -- Not a valid mark (another one, or this one already began: a run that starts twice sends once),
  -- or it waited too long in the queue: skipped, never counted, never a failure.
  -- (coalesce: with no mark at all the comparisons are null, and a null test would let it run.)
  if not (coalesce(r.queued_id = queued and r.queued_until > now(), false)
          or coalesce(r.prev_queued_id = queued and r.prev_queued_until > now(), false)) then
    if r.queued_id = queued then
      update public.team_call_live_agent a set queued_id = null, queued_at = null, queued_until = null, updated_at = now() where a.capture_id = target_capture;
    elsif r.prev_queued_id = queued then
      update public.team_call_live_agent a set prev_queued_id = null, prev_queued_until = null, updated_at = now() where a.capture_id = target_capture;
    end if;
    return query select 'stale'::text, r.turns;
    return;
  end if;
  unwanted := public.team_call_live_turn_unwanted(target_capture, r.call_id);
  if unwanted is not null then
    perform public.team_call_live_turn_stop(target_capture, unwanted);
    return query select 'stopped'::text, r.turns;
    return;
  end if;
  if r.turns >= max_turns then
    perform public.team_call_live_turn_stop(target_capture, 'bound');
    return query select 'stopped'::text, r.turns;
    return;
  end if;
  update public.team_call_live_agent a
     set lease_id = queued,
         lease_until = now() + make_interval(secs => greatest(lease_seconds, 30)),
         queued_id = null,
         queued_at = null,
         queued_until = null,
         prev_queued_id = null,
         prev_queued_until = null,
         last_turn_at = now(),
         turns = a.turns + 1,
         state = 'working',
         updated_at = now()
   where a.capture_id = target_capture;
  perform public.team_call_live_notes_stamp(target_capture, 'working', now() + make_interval(secs => greatest(lease_seconds, 30)), r.turns + 1, null);
  return query select 'running'::text, r.turns + 1;
end;
$$;

create or replace function public.team_call_live_turn_unqueue(target_capture uuid, queued uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  with taken as (
    update public.team_call_live_agent a
       set queued_id = null, queued_at = null, queued_until = null, updated_at = now()
     where a.capture_id = target_capture and a.queued_id = queued
    returning 1
  )
  select exists (select 1 from taken);
$$;

-- The 200 characters before an offset, as a fingerprint (md5) of where the turns stopped reading.
create or replace function public.team_call_live_turn_tail(tx text, at_offset integer)
returns text
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select case when at_offset <= 0 then null
              else md5(substring(tx from greatest(1, at_offset - 199) for least(200, at_offset))) end;
$$;

create or replace function public.team_call_live_turn_window(target_capture uuid, turn_lease uuid, max_chars integer, context_chars integer)
returns table (from_offset integer, to_offset integer, context text, words text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  r public.team_call_live_agent%rowtype;
  tx text;
  w text;
  ctx text;
  cut integer;
  start_at integer;
  done integer;
begin
  select a.* into r from public.team_call_live_agent a where a.capture_id = target_capture for update;
  if not found or r.lease_id is distinct from turn_lease or r.lease_until <= now() then
    return;
  end if;
  -- Still the live call's open capture; once it is not, the agent stops here (the turn that
  -- asked sends nothing).
  select coalesce(x.transcript, '') into tx
    from public.captures x
   where x.id = target_capture and x.ended_at is null and not coalesce(x.is_transcript_locked, false);
  if tx is null or not exists (
    select 1 from public.team_call t
     where t.id = r.call_id and t.status = 'live' and t.capture_id = target_capture
  ) then
    perform public.team_call_live_turn_stop(target_capture, 'call_ended');
    return;
  end if;

  -- The transcript is appended to only, while the recorder fills it (no person may write it then).
  -- Should it ever have been rewritten under the turns (shorter than where they stopped, or other
  -- text before that point), start a fresh window at its newest max_chars, from a whole line, rather
  -- than send text from the middle of one.
  done := r.done_offset;
  if done > 0 and (char_length(tx) < done or public.team_call_live_turn_tail(tx, done) is distinct from r.done_tail) then
    done := greatest(0, char_length(tx) - greatest(max_chars, 1));
    if done > 0 and strpos(substring(tx from done + 1), chr(10)) > 0 then
      done := done + strpos(substring(tx from done + 1), chr(10));
    end if;
    update public.team_call_live_agent a
       set done_offset = done, done_tail = public.team_call_live_turn_tail(tx, done), updated_at = now()
     where a.capture_id = target_capture;
  end if;

  w := substring(tx from done + 1 for greatest(max_chars, 1));
  -- More waits beyond the cap: end at the last whole line, so no line is split between two turns.
  if char_length(tx) - done > char_length(w) then
    cut := strpos(reverse(w), chr(10));
    if cut > 0 and cut < char_length(w) then
      w := left(w, char_length(w) - cut + 1);
    end if;
  end if;

  start_at := greatest(0, done - greatest(context_chars, 0));
  ctx := substring(tx from start_at + 1 for done - start_at);
  -- Context cut mid-line starts at the next whole line.
  if start_at > 0 and strpos(ctx, chr(10)) > 0 then
    ctx := substring(ctx from strpos(ctx, chr(10)) + 1);
  end if;

  return query select done, done + char_length(w), ctx, w;
end;
$$;

create or replace function public.team_call_live_turn_release(
  target_capture uuid,
  turn_lease uuid,
  turn_outcome text,
  sent_to integer,
  reason text,
  max_failures_in_row integer
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  r public.team_call_live_agent%rowtype;
  tx text;
  read_to integer;
begin
  if turn_outcome not in ('ok', 'unknown', 'failed', 'stopped') then
    raise exception 'live turns: unknown outcome' using errcode = '22023';
  end if;
  select a.* into r from public.team_call_live_agent a where a.capture_id = target_capture for update;
  if not found or r.lease_id is distinct from turn_lease then
    return 'stale';
  end if;

  if turn_outcome = 'stopped' then
    perform public.team_call_live_turn_stop(target_capture, coalesce(nullif(trim(reason), ''), 'stopped'));
    return 'stopped';
  end if;

  if turn_outcome in ('ok', 'unknown') then
    select coalesce(x.transcript, '') into tx from public.captures x where x.id = target_capture;
    read_to := greatest(r.done_offset, least(coalesce(sent_to, r.done_offset), char_length(coalesce(tx, ''))));
    -- 'unknown': the turn's answer never came back, and the route may still be writing. Its words
    -- count as sent (never twice), and its lease stays to its end, so the call's finish waits.
    update public.team_call_live_agent a
       set done_offset = read_to,
           done_tail = public.team_call_live_turn_tail(tx, read_to),
           failures_in_row = 0,
           last_ok_at = case when turn_outcome = 'ok' then now() else a.last_ok_at end,
           state = 'ready',
           lease_id = case when turn_outcome = 'ok' then null else a.lease_id end,
           lease_until = case when turn_outcome = 'ok' then null else a.lease_until end,
           updated_at = now()
     where a.capture_id = target_capture;
    perform public.team_call_live_notes_stamp(target_capture, 'ready', null, r.turns, null);
    return 'ready';
  end if;

  -- Failed: its words stay unread, so the next turn sends them.
  if r.failures_in_row + 1 >= greatest(max_failures_in_row, 1) then
    update public.team_call_live_agent a
       set failures = a.failures + 1, failures_in_row = a.failures_in_row + 1, updated_at = now()
     where a.capture_id = target_capture;
    perform public.team_call_live_turn_stop(target_capture, 'failing');
    return 'stopped';
  end if;
  update public.team_call_live_agent a
     set failures = a.failures + 1,
         failures_in_row = a.failures_in_row + 1,
         state = 'failed',
         lease_id = null,
         lease_until = null,
         updated_at = now()
   where a.capture_id = target_capture;
  perform public.team_call_live_notes_stamp(target_capture, 'failed', null, r.turns, null);
  return 'failed';
end;
$$;

-- When the running turn holding `lease` must stop writing (its lease's end), or null when `lease`
-- is not the running turn's: the live agent's route takes a server turn on a call's capture only
-- while it holds the lease, and stops its tools at the lease's end.
create or replace function public.team_call_live_turn_lease_until(target_capture uuid, turn_lease uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.lease_until from public.team_call_live_agent a
   where a.capture_id = target_capture and a.lease_id = turn_lease and a.lease_until > now();
$$;

create or replace function public.team_call_live_turn_busy(target_capture uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.team_call_live_agent a
     where a.capture_id = target_capture and a.lease_until is not null and a.lease_until > now()
  );
$$;

revoke all on function public.team_call_live_notes_stamp(uuid, text, timestamptz, integer, text) from public, anon, authenticated;
revoke all on function public.team_call_live_notes_summary_sync() from public, anon, authenticated;
revoke all on function public.team_call_live_turn_stop(uuid, text) from public, anon, authenticated;
revoke all on function public.team_call_live_turn_unwanted(uuid, uuid) from public, anon, authenticated;
revoke all on function public.team_call_live_turn_claim(uuid, integer, integer, integer, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.team_call_live_turn_lease_until(uuid, uuid) from public, anon, authenticated;
revoke all on function public.team_call_live_turn_begin(uuid, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.team_call_live_turn_unqueue(uuid, uuid) from public, anon, authenticated;
revoke all on function public.team_call_live_turn_tail(text, integer) from public, anon, authenticated;
revoke all on function public.team_call_live_turn_window(uuid, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.team_call_live_turn_release(uuid, uuid, text, integer, text, integer) from public, anon, authenticated;
revoke all on function public.team_call_live_turn_busy(uuid) from public, anon, authenticated;
grant execute on function public.team_call_live_notes_stamp(uuid, text, timestamptz, integer, text) to service_role;
grant execute on function public.team_call_live_notes_summary_sync() to service_role;
grant execute on function public.team_call_live_turn_stop(uuid, text) to service_role;
grant execute on function public.team_call_live_turn_unwanted(uuid, uuid) to service_role;
grant execute on function public.team_call_live_turn_claim(uuid, integer, integer, integer, integer, integer, integer, integer) to service_role;
grant execute on function public.team_call_live_turn_lease_until(uuid, uuid) to service_role;
grant execute on function public.team_call_live_turn_begin(uuid, uuid, integer, integer) to service_role;
grant execute on function public.team_call_live_turn_unqueue(uuid, uuid) to service_role;
grant execute on function public.team_call_live_turn_tail(text, integer) to service_role;
grant execute on function public.team_call_live_turn_window(uuid, uuid, integer, integer) to service_role;
grant execute on function public.team_call_live_turn_release(uuid, uuid, text, integer, text, integer) to service_role;
grant execute on function public.team_call_live_turn_busy(uuid) to service_role;

notify pgrst, 'reload schema';

commit;

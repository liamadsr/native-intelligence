-- ============================================================
-- 655: The live agent on a call's capture, driven by the server (one
-- recorder per call, phase 2). Since 587-589 the call recorder fills one
-- capture per call as people speak; nobody's device runs the live agent on
-- it, so until now the call's notes were written only once the call ended.
-- Now the app runs the live agent's own turns on that capture as the words
-- arrive (src/lib/team-calls/live-turns.ts), as the capture's owner, with no
-- device in the loop and whoever is in the call. This file is the record
-- that keeps those turns throttled, one at a time across every app process,
-- bounded per call, and stopped at the call's end.
-- ============================================================
--   team_call_live_agent  one row per call capture the live agent writes:
--                      its lease (the one turn running now, whichever
--                      process runs it: lease_id, lease_until), how far into
--                      the capture's transcript the turns have read
--                      (done_offset, in characters: what a turn that went
--                      through has sent; a failed turn leaves it, so its
--                      words go with the next one), how many turns ran
--                      (turns, the cost bound per call), when the last one
--                      started (the throttle), the failures (failures,
--                      failures_in_row: a run of them stops the agent for
--                      the call), and its state: 'idle' (no turn yet),
--                      'working' (a turn is running), 'ready' (the last one
--                      went through), 'failed' (the last one did not), or
--                      'stopped' (no more turns for this capture:
--                      stop_reason says why: the call ended, its capture was
--                      closed, the owner may no longer read the
--                      conversation, the bound was reached, a run of
--                      failures, or the owner's usage ran out).
--
-- Functions (the service role's alone; definers, search_path pinned):
--   team_call_live_turn_claim(capture, ...)  may a turn start now? It locks
--     the row, checks the call (live, this capture its current one, notes
--     on), the capture (open, its owner still in the conversation and the
--     workspace) and the bound, then the throttle: not within
--     min_interval_seconds of the last turn's start, never with fewer than
--     min_chars new characters, and with fewer than ready_chars only once
--     quiet_seconds have passed. A turn that may start takes the lease for
--     lease_seconds and counts.
--   team_call_live_turn_window(capture, lease, ...)  the words the turn
--     holding the lease sends: from done_offset on (at most max_chars, cut
--     at a line's end), and up to context_chars before it as context.
--     Nothing once the lease is not this turn's; nothing once the call is
--     over, and the agent is stopped then.
--   team_call_live_turn_release(capture, lease, outcome, ...)  the turn is
--     over: 'ok' moves done_offset to what it sent; 'failed' leaves it;
--     'stopped' ends the agent for the capture. A lease that is no longer
--     this turn's (it ran out and another took it) changes nothing.
--   team_call_live_turn_busy(capture)  is a turn running now (the call's
--     finish waits for it before the end-of-meeting pass).
--
-- What the people who can read the capture see of it: captures.metadata's
-- live_notes key ({ state, at, turns, reason }), written by claim and
-- release, so it reaches a reader's screen with the capture's row over
-- Realtime, as the fed transcript and the summary do, fenced as the capture
-- is (566's policy). The notes themselves are the capture's summary, which
-- the live agent's own tools write.
--
-- RLS on the new table; no client has a grant on it. Additive. Idempotent.
-- Safe on a live database with the deployed app running: one new empty
-- table and new functions; the deployed app never calls them. No
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
  lease_id uuid,
  lease_until timestamptz,
  last_turn_at timestamptz,
  last_ok_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_call_live_agent_lease check ((lease_id is null) = (lease_until is null)),
  constraint team_call_live_agent_stopped check ((state = 'stopped') = (stop_reason is not null))
);
create index if not exists team_call_live_agent_call_idx on public.team_call_live_agent (call_id);

alter table public.team_call_live_agent enable row level security;
revoke all on table public.team_call_live_agent from anon, authenticated;
grant select, insert, update, delete on table public.team_call_live_agent to service_role;

comment on table public.team_call_live_agent is
  'The live agent''s turns on a call''s capture, run by the server as the words arrive (655): the lease, the throttle, the bound, the stop. Server only.';

-- What a reader of the capture sees of the agent: merged into the capture's metadata (never
-- replacing it), so it travels with the row over Realtime.
create or replace function public.team_call_live_notes_stamp(target_capture uuid, notes_state text, turn_count integer, reason text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.captures x
     set metadata = coalesce(x.metadata, '{}'::jsonb)
                    || jsonb_build_object('live_notes', jsonb_strip_nulls(jsonb_build_object('state', notes_state, 'at', now(), 'turns', turn_count, 'reason', reason)))
   where x.id = target_capture;
$$;

-- Stop the agent for a capture, once (the row locked by the caller).
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
     set state = 'stopped', stop_reason = left(reason, 40), lease_id = null, lease_until = null, updated_at = now()
   where a.capture_id = target_capture and a.state <> 'stopped'
  returning a.turns into n;
  if n is not null then
    perform public.team_call_live_notes_stamp(target_capture, 'stopped', n, left(reason, 40));
  end if;
  return coalesce(n, 0);
end;
$$;

create or replace function public.team_call_live_turn_claim(
  target_capture uuid,
  min_interval_seconds integer,
  min_chars integer,
  ready_chars integer,
  quiet_seconds integer,
  max_turns integer,
  lease_seconds integer
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
  cap_owner uuid;
  cap_ended timestamptz;
  cap_locked boolean;
  cap_owner_out boolean;
  cap_length integer;
  r public.team_call_live_agent%rowtype;
  fresh integer;
  since double precision;
  made uuid;
begin
  -- The call this capture is of (587's record of every capture a call made).
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
  select x.workspace_id, x.user_id, x.ended_at, coalesce(x.is_transcript_locked, false), coalesce(x.notes_owner_out, false), char_length(coalesce(x.transcript, ''))
    into cap_workspace, cap_owner, cap_ended, cap_locked, cap_owner_out, cap_length
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
  -- The call is over, or this capture is no longer the call's (closed by hand, or another round's):
  -- no turn ever again for it.
  if c.status <> 'live' or c.capture_id is distinct from target_capture or cap_ended is not null or cap_locked then
    perform public.team_call_live_turn_stop(target_capture, 'call_ended');
    return query select 'stopped'::text, null::uuid, r.turns;
    return;
  end if;
  -- A turn runs as the capture's owner: one who may no longer read the conversation (568), or who
  -- left the workspace, writes nothing more into it.
  if cap_owner is null or cap_owner_out
     or not exists (select 1 from public.member m where m.user_id = cap_owner and m.workspace_id = cap_workspace) then
    perform public.team_call_live_turn_stop(target_capture, 'owner_out');
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
  if r.lease_until is not null and r.lease_until > now() then
    return query select 'busy'::text, null::uuid, r.turns;
    return;
  end if;

  fresh := cap_length - r.done_offset;
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
  update public.team_call_live_agent a
     set lease_id = made,
         lease_until = now() + make_interval(secs => greatest(lease_seconds, 30)),
         last_turn_at = now(),
         turns = a.turns + 1,
         state = 'working',
         updated_at = now()
   where a.capture_id = target_capture;
  perform public.team_call_live_notes_stamp(target_capture, 'working', r.turns + 1, null);
  return query select 'claimed'::text, made, r.turns + 1;
end;
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
begin
  select a.* into r from public.team_call_live_agent a where a.capture_id = target_capture;
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

  w := substring(tx from r.done_offset + 1 for greatest(max_chars, 1));
  -- More waits beyond the cap: end at the last whole line, so no line is split between two turns.
  if char_length(tx) - r.done_offset > char_length(w) then
    cut := strpos(reverse(w), chr(10));
    if cut > 0 and cut < char_length(w) then
      w := left(w, char_length(w) - cut + 1);
    end if;
  end if;

  start_at := greatest(0, r.done_offset - greatest(context_chars, 0));
  ctx := substring(tx from start_at + 1 for r.done_offset - start_at);
  -- Context cut mid-line starts at the next whole line.
  if start_at > 0 and strpos(ctx, chr(10)) > 0 then
    ctx := substring(ctx from strpos(ctx, chr(10)) + 1);
  end if;

  return query select r.done_offset, r.done_offset + char_length(w), ctx, w;
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
  cap_length integer;
begin
  if turn_outcome not in ('ok', 'failed', 'stopped') then
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

  if turn_outcome = 'ok' then
    select char_length(coalesce(x.transcript, '')) into cap_length from public.captures x where x.id = target_capture;
    update public.team_call_live_agent a
       set done_offset = greatest(a.done_offset, least(coalesce(sent_to, a.done_offset), coalesce(cap_length, a.done_offset))),
           failures_in_row = 0,
           last_ok_at = now(),
           state = 'ready',
           lease_id = null,
           lease_until = null,
           updated_at = now()
     where a.capture_id = target_capture;
    perform public.team_call_live_notes_stamp(target_capture, 'ready', r.turns, null);
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
  perform public.team_call_live_notes_stamp(target_capture, 'failed', r.turns, null);
  return 'failed';
end;
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

revoke all on function public.team_call_live_notes_stamp(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.team_call_live_turn_stop(uuid, text) from public, anon, authenticated;
revoke all on function public.team_call_live_turn_claim(uuid, integer, integer, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.team_call_live_turn_window(uuid, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.team_call_live_turn_release(uuid, uuid, text, integer, text, integer) from public, anon, authenticated;
revoke all on function public.team_call_live_turn_busy(uuid) from public, anon, authenticated;
grant execute on function public.team_call_live_notes_stamp(uuid, text, integer, text) to service_role;
grant execute on function public.team_call_live_turn_stop(uuid, text) to service_role;
grant execute on function public.team_call_live_turn_claim(uuid, integer, integer, integer, integer, integer, integer) to service_role;
grant execute on function public.team_call_live_turn_window(uuid, uuid, integer, integer) to service_role;
grant execute on function public.team_call_live_turn_release(uuid, uuid, text, integer, text, integer) to service_role;
grant execute on function public.team_call_live_turn_busy(uuid) to service_role;

notify pgrst, 'reload schema';

commit;

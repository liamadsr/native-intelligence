-- ============================================================
-- 571: Team calls on the phone (calls plan, phase 8): which rings were
-- pushed to a person's phones as calls, so each is pushed once and stopped
-- once. 570 is the VoIP tokens.
-- ============================================================
-- Apple's rule shapes this: on iOS 13 and later every VoIP push must become
-- an incoming call on the phone (CallKit) before its handler returns, so a
-- push the phone did not need still flashes a call on its screen. The
-- server therefore sends a ring's VoIP push only while that ring is
-- ringing, and its one follow-up (the cancel: stop ringing) only when the
-- ring left ringing before its time ran out (answered or declined on
-- another device, the caller hung up, the call ended). A ring that simply
-- ran out is stopped by the phone's own clock: no cancel goes.
--
--   team_call_ring_push  one row per ring pushed: whose (user_id), when it
--                     went (pushed_at), and when its cancel went
--                     (cancelled_at). The claim functions below write it, so
--                     two senders at once (a retried request, the answer
--                     route and LiveKit's join webhook together) send once.
--                     Service role only; no client reads it, and it is not
--                     in Realtime (564's ring rows carry what the apps
--                     show). The sweeper forgets rows after two days.
--   team_call_ring_push_claim(target_ring)  service role: the ring's VoIP
--                     push may go now (it is ringing, its time is not up,
--                     and no push went for it yet): its row is written and
--                     what the push says is returned. Else nothing.
--   team_call_ring_push_cancel(target_rings, for_call, for_member)  service
--                     role: the cancels that may go now, for these rings,
--                     for one member's rings in one call (their join, from
--                     LiveKit's webhook; their removal, from the eject
--                     outbox), or for a call's rings (for_member null: the
--                     call ended by a trigger): each was pushed, is no longer
--                     ringing, its time is not up, and no cancel went for it
--                     yet. Their rows are marked and they are returned with
--                     how they were settled.
--
-- Additive. Idempotent. Safe on a live database: one new empty table and
-- two new functions; nothing else changes. Lock order: the claim shares its
-- one ring row (it waits for an answer committing on it, then reads the
-- answer) and takes no call row; the cancel takes only push rows. Neither
-- holds a lock 565's functions want before theirs, so they never deadlock.
-- No backslashes anywhere in this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

create table if not exists public.team_call_ring_push (
  ring_id uuid primary key references public.team_call_ring(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  pushed_at timestamptz not null default now(),
  cancelled_at timestamptz,
  constraint team_call_ring_push_order check (cancelled_at is null or cancelled_at >= pushed_at)
);
-- The sweeper's prune.
create index if not exists team_call_ring_push_pushed_idx on public.team_call_ring_push (pushed_at);

alter table public.team_call_ring_push enable row level security;
revoke all on table public.team_call_ring_push from public, anon, authenticated;
grant select, insert, update, delete on table public.team_call_ring_push to service_role;

comment on table public.team_call_ring_push is
  'The team call rings pushed to a person''s phones as calls (571): each pushed once, its cancel sent once. Written by team_call_ring_push_claim and team_call_ring_push_cancel (service role). No client reads it.';

-- A ring's push may go now: it is ringing, its time is not up, and none went yet.
create or replace function public.team_call_ring_push_claim(target_ring uuid)
returns table (
  ring_id uuid, call_id uuid, workspace_id uuid, channel_id uuid, user_id uuid,
  caller_name text, channel_kind text, channel_name text, expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  r public.team_call_ring%rowtype;
  made uuid;
begin
  -- Shared: an answer committing now is waited for and read, so a ring settled a moment ago is never pushed.
  select * into r from public.team_call_ring x where x.id = target_ring for share;
  if not found or r.state <> 'ringing' or r.expires_at <= now() then
    return;
  end if;
  insert into public.team_call_ring_push (ring_id, user_id)
  values (r.id, r.user_id)
  on conflict do nothing
  returning team_call_ring_push.ring_id into made;
  if made is null then
    return;
  end if;
  return query select r.id, r.call_id, r.workspace_id, r.channel_id, r.user_id, r.caller_name, r.channel_kind, r.channel_name, r.expires_at;
end;
$$;

-- The cancels that may go now: pushed, settled before their time, not cancelled yet.
create or replace function public.team_call_ring_push_cancel(target_rings uuid[] default null, for_call uuid default null, for_member uuid default null)
returns table (ring_id uuid, call_id uuid, user_id uuid, state text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if target_rings is null and for_call is null then
    return;
  end if;
  return query
    update public.team_call_ring_push p
       set cancelled_at = now()
      from public.team_call_ring r
     where r.id = p.ring_id
       and p.cancelled_at is null
       and r.state not in ('ringing', 'busy')
       and r.expires_at > now()
       and (
         (target_rings is not null and p.ring_id = any (target_rings))
         or (target_rings is null and for_call is not null and r.call_id = for_call and (for_member is null or r.member_id = for_member))
       )
    returning p.ring_id, r.call_id, p.user_id, r.state;
end;
$$;

revoke all on function public.team_call_ring_push_claim(uuid) from public, anon, authenticated;
revoke all on function public.team_call_ring_push_cancel(uuid[], uuid, uuid) from public, anon, authenticated;
grant execute on function public.team_call_ring_push_claim(uuid) to service_role;
grant execute on function public.team_call_ring_push_cancel(uuid[], uuid, uuid) to service_role;

notify pgrst, 'reload schema';

commit;

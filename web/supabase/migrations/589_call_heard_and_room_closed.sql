-- ============================================================
-- 589: Two follow-ups to the call recorder (587-588).
-- ============================================================
--   team_call_recorder_work(producer_id, running, max_jobs)  588's, redefined
--                     from its body as merged, with one change: only calls
--                     that have had two people in them at the same time
--                     (565/575's peak_participants: members joined and guests
--                     in the call; the recorder is never counted) are
--                     offered, so a ringing or missed call, or one person
--                     waiting, is never heard, and an older such call can no
--                     longer take the place of a newer call two people are in
--                     (the app used to filter after a limit).
--   team_call_people_seen(target_call, people)  new: the app saw this many
--                     people in a live call's room (LiveKit's own list) when
--                     its counter says fewer than two were ever in it at once,
--                     so a lost join webhook never leaves a two-person call
--                     unheard; the peak is raised to it (never lowered).
--   team_call_close_room_on_end  new trigger on team_call: a call that ends,
--                     whatever ends it (565's team_call_end from any route,
--                     the webhook, the sweep, a meeting's host, the guest-only
--                     rule), puts its room on 564's eject outbox to be closed
--                     (identity null, reason 'ended'), drained by the app at
--                     once and every minute until LiveKit takes it, a room
--                     already gone being fine. Nobody sits in a dead room.
--   team_call_eject's reason check  564's, widened with 'ended'.
--
-- Additive. Idempotent. Needs 564-575 and 587-588. No backslashes anywhere in
-- this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

-- ── The recorder's work: two people first ─────────────────────────────────────

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
     and t.peak_participants >= 2
     and not (t.id = any (coalesce(p_running, '{}'::uuid[])))
     and (x.id is null or not public.capture_feed_capture_closed(x.capture_id))
     and (
       x.id is null
       or (x.status <> 'ended' and (x.producer_id = p_producer_id or x.status = 'lost' or x.heartbeat_at < now() - interval '30 seconds'))
     )
   order by t.notes_on_since
   limit greatest(coalesce(max_jobs, 0), 0);
$$;

-- ── People seen in the room ───────────────────────────────────────────────────

create or replace function public.team_call_people_seen(target_call uuid, people integer)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.team_call t
     set peak_participants = greatest(t.peak_participants, least(greatest(coalesce(people, 0), 0), 500)),
         updated_at = now()
   where t.id = target_call
     and t.status = 'live'
     and t.peak_participants < least(greatest(coalesce(people, 0), 0), 500)
  returning t.peak_participants;
$$;

-- ── A call that ends closes its room ──────────────────────────────────────────

alter table public.team_call_eject drop constraint if exists team_call_eject_reason_check;
alter table public.team_call_eject
  add constraint team_call_eject_reason_check check (reason in ('access', 'archived', 'deleted', 'ended')) not valid;
alter table public.team_call_eject validate constraint team_call_eject_reason_check;

create or replace function public.team_call_close_room_on_end()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- One pending close per room (564's index): an archive's own close, or a second end, adds none.
  insert into public.team_call_eject (call_id, room, identity, reason)
  values (new.id, new.room, null, 'ended')
  on conflict do nothing;
  return null;
end;
$$;

revoke all on function public.team_call_close_room_on_end() from public, anon, authenticated;

drop trigger if exists team_call_close_room_on_end on public.team_call;
create trigger team_call_close_room_on_end
  after update of status on public.team_call
  for each row
  when (old.status = 'live' and new.status = 'ended')
  execute function public.team_call_close_room_on_end();

revoke all on function public.team_call_recorder_work(text, uuid[], integer) from public, anon, authenticated;
revoke all on function public.team_call_people_seen(uuid, integer) from public, anon, authenticated;
grant execute on function public.team_call_recorder_work(text, uuid[], integer) to service_role;
grant execute on function public.team_call_people_seen(uuid, integer) to service_role;

notify pgrst, 'reload schema';

commit;

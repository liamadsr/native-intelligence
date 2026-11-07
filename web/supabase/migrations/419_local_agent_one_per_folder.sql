-- ============================================================
-- 419: Local agents, one live session per folder (docs/plans/teammate-agent.md
-- C4; workstream C). Apply it AFTER the deploy that ships with it, never
-- before: the code running before that deploy turns this index's unique
-- violation into a 503 on a second start in a folder. The code that ships
-- with it runs with or without the index: it enforces the rule itself
-- (store.ts createSession: join, end an idle one, or refuse), and the index
-- only closes the race between two starts (createSession decides again when
-- it loses one). Roll the index back (drop index
-- local_agent_session_one_live_per_folder) before rolling that code back.
--
-- The one row change: before it builds the index, it settles the sessions the
-- app already treats as expired and settles on its next read anyway (store.ts
-- staleness / reapIfStale): queued past expires_at, and waiting or
-- interrupted with no activity for 24 hours and no live lease. Same status,
-- error (a loop's job and a person's each in their own words) and ended_at
-- the reaper writes. Their ledger rows (tracked_job) are
-- left to the work reaper, which closes stale items.
--
-- If a folder still holds two live sessions after that (two Macs racing a
-- start before this index existed), the index is not built and a WARNING says
-- so: the server still enforces one per folder. Once they end, run the DO
-- block below again BY HAND (the SQL editor): the migration tool has recorded
-- 419 as applied by then and won't run it again. Check after applying:
--   select indexname from pg_indexes where indexname = 'local_agent_session_one_live_per_folder';
--
-- The table is locked against writes for the check and the build (reads go
-- on), so no start slips in between them. It is small: well under a second.
--
-- Also (no row change), first, before the folder block takes its lock:
-- message_teammate's counted question, one function (local_agent_teammate_ask:
-- the caps' count and the insert as one step under a per-person lock, so a
-- refused question is never written and two calls at once can't both slip
-- under a cap), and the partial index its per-person count reads. Building
-- that index scans the event table, which the folder block's lock must not
-- wait on. The code runs without them too: it counts, then inserts.
--
-- Not applied by the builder: Liam applies it (DEV, then PROD), after 418 and
-- after the deploy.
-- ============================================================

-- ── message_teammate's counted question (store.ts askTeammate) ──────────────
-- The per-person daily count reads the server's asks and reports by person, over a window of time.
create index if not exists local_agent_event_server_teammate_idx
  on public.local_agent_event (user_id, created_at)
  where source = 'server' and kind in ('ask', 'report');

-- Record the Mac body's question to its teammate only when it is under every
-- cap (per job per rolling hour, per job, per person per day). A per-person
-- advisory lock makes count-then-insert atomic: a refused question is never
-- written (the Agents panel shows inserts live), and two calls at once can't
-- both slip under a cap. A call whose key is already recorded (eve retried
-- it) gets that event back. Only a live session of this person's takes one,
-- checked under the lock. Every cap is required (a NULL one would never cap).
-- Answers jsonb: {status: 'recorded'|'duplicate', id}, {status: 'capped',
-- cap: 'hour'|'job'|'day'} or {status: 'ended'}.
create or replace function public.local_agent_teammate_ask(
  p_session_id uuid,
  p_user_id uuid,
  p_key text,
  p_question text,
  p_per_hour integer,
  p_per_job integer,
  p_per_day integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
  v_hour integer;
  v_job integer;
  v_day integer;
begin
  if p_per_hour is null or p_per_job is null or p_per_day is null then
    raise exception 'local_agent_teammate_ask: every cap is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('local_agent_teammate:' || p_user_id::text, 0));

  perform 1
  from public.local_agent_session
  where id = p_session_id and user_id = p_user_id
    and status not in ('cancelled', 'failed', 'expired');
  if not found then
    return jsonb_build_object('status', 'ended');
  end if;

  select id into v_id
  from public.local_agent_event
  where session_id = p_session_id and user_id = p_user_id
    and source = 'server' and kind = 'ask' and payload->>'key' = p_key
  order by id desc
  limit 1;
  if v_id is not null then
    return jsonb_build_object('status', 'duplicate', 'id', v_id);
  end if;

  select
    count(*) filter (where session_id = p_session_id and created_at >= now() - interval '1 hour'),
    count(*) filter (where session_id = p_session_id),
    count(*) filter (where created_at >= now() - interval '24 hours')
  into v_hour, v_job, v_day
  from public.local_agent_event
  where user_id = p_user_id and source = 'server' and kind = 'ask'
    and payload->>'via' = 'message_teammate'
    and (session_id = p_session_id or created_at >= now() - interval '24 hours');
  if v_hour >= p_per_hour then
    return jsonb_build_object('status', 'capped', 'cap', 'hour');
  end if;
  if v_job >= p_per_job then
    return jsonb_build_object('status', 'capped', 'cap', 'job');
  end if;
  if v_day >= p_per_day then
    return jsonb_build_object('status', 'capped', 'cap', 'day');
  end if;

  insert into public.local_agent_event (session_id, user_id, source, kind, payload)
  values (
    p_session_id, p_user_id, 'server', 'ask',
    jsonb_build_object('question', p_question, 'via', 'message_teammate', 'key', p_key)
  )
  returning id into v_id;
  return jsonb_build_object('status', 'recorded', 'id', v_id);
end;
$$;

revoke all on function public.local_agent_teammate_ask(uuid, uuid, text, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.local_agent_teammate_ask(uuid, uuid, text, text, integer, integer, integer) to service_role;

-- ── One live session per folder ──────────────────────────────────────────────
do $$
declare
  dup_folders integer;
begin
  lock table public.local_agent_session in share row exclusive mode;

  -- What lazy reaping would write on the next read (store.ts reapIfStale).
  -- A loop's job (its key) waits 15 minutes, a person's 6 hours: each in its own words.
  update public.local_agent_session
    set status = 'expired',
      error = case when idempotency_key like 'local-agent-loop:%'
        then 'your Mac didn''t pick it up within 15 minutes'
        else 'your Mac didn''t connect within 6 hours' end,
      ended_at = now(), lease_expires_at = null
    where status = 'queued' and expires_at < now();
  update public.local_agent_session
    set status = 'expired', error = 'it sat idle for 24 hours', ended_at = now(), lease_expires_at = null
    where status in ('waiting', 'interrupted')
      and updated_at < now() - interval '24 hours'
      and (lease_expires_at is null or lease_expires_at < now());

  select count(*) into dup_folders from (
    select folder_id
    from public.local_agent_session
    where status in ('queued', 'starting', 'running', 'waiting', 'interrupted')
    group by folder_id
    having count(*) > 1
  ) d;

  if dup_folders > 0 then
    raise warning '419: % folder(s) hold more than one live local agent, so local_agent_session_one_live_per_folder was NOT created. The server still enforces one per folder; once they end, run this DO block again by hand (the migration tool has recorded 419 as applied).', dup_folders;
  else
    create unique index if not exists local_agent_session_one_live_per_folder
      on public.local_agent_session (folder_id)
      where status in ('queued', 'starting', 'running', 'waiting', 'interrupted');
  end if;
end $$;

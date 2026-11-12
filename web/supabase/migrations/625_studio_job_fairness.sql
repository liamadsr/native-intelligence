-- ============================================================
-- 625: Studio: fair turns at the worker, cancels that stay cancelled, and
--      the bytes a workspace holds.
-- ============================================================
-- The Studio worker is shared by every workspace (620). Until now it took
-- the oldest queued job whoever queued it, so one member queuing a long run
-- of exports held every other workspace's imports and frames behind theirs.
-- And a running job the person asked to stop went back in the queue when its
-- worker went quiet (620's stale rule), where no worker would ever take it
-- again: it sat queued for good.
--
--   1. studio_claim_job      replaced, same signature and grants. Before it
--                            picks, a stale running PAID job (a generated
--                            shot, a narration) ends failed, never queued
--                            again: the provider may have charged for the
--                            first attempt, and a second attempt refuses to
--                            spend anyway, so the person is told to check the
--                            costs before trying again. Then a stale running
--                            job the person asked to stop ends cancelled (not
--                            queued again), and a queued job asked to stop
--                            ends cancelled. Stale jobs past three tries
--                            fail, other stale ones go back in the queue, as
--                            before. Then it takes,
--                            among the queued jobs of the kinds it does, one
--                            of the workspace with the fewest jobs running
--                            now, the oldest first: a busy workspace waits its
--                            turn behind a quiet one.
--   2. studio_job_running_idx the running jobs of a workspace, which the pick
--                            counts for every queued job it weighs.
--   3. studio_workspace_bytes what a workspace's Studio holds: its stored
--                            files plus the uploads still pending. The app
--                            checks it before every new file (a per-workspace
--                            limit, 50 GB unless STUDIO_WORKSPACE_BYTES says
--                            otherwise). One indexed aggregate:
--                            studio_blob_workspace_bytes_idx lets it read the
--                            sizes from the index alone.
--
-- The app also caps what one workspace may have open (20 jobs, 5 exports;
-- src/lib/studio/server/jobs.ts) and removes old uploads, frames and exports
-- every hour (src/lib/studio/server/sweep.ts); neither needs the database.
--
-- Service role only, as 620. Additive. Idempotent. No backslashes anywhere
-- in this file (one MCP transport decodes escapes).
--
-- Order: apply before the app code that calls studio_workspace_bytes is
-- rolled out. That code reads the same sum row by row while the function is
-- missing, so it keeps working either way, only slower.
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. studio_claim_job
-- ------------------------------------------------------------

create or replace function public.studio_claim_job(
  p_worker text,
  p_kinds text[],
  p_stale_seconds integer default 180
)
returns setof public.studio_job
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  picked uuid;
begin
  -- A paid job whose worker went quiet: the provider may have charged for it.
  -- It ends failed and says so; queued again it would only refuse to spend.
  update public.studio_job
     set status = 'failed',
         error = 'The worker stopped while making this, after it may have asked the provider: it may have charged. Check the costs before trying again.',
         updated_at = now()
   where status = 'running'
     and kind in ('shot', 'narration')
     and coalesce(heartbeat_at, claimed_at, created_at) < now() - make_interval(secs => p_stale_seconds);

  -- A running job the person asked to stop, whose worker went quiet: it ends
  -- cancelled. Going back in the queue it would never be taken again.
  update public.studio_job
     set status = 'cancelled',
         error = coalesce(error, 'Cancelled.'),
         updated_at = now()
   where status = 'running'
     and cancel_requested
     and coalesce(heartbeat_at, claimed_at, created_at) < now() - make_interval(secs => p_stale_seconds);

  -- A queued job the person asked to stop ends cancelled.
  update public.studio_job
     set status = 'cancelled',
         error = coalesce(error, 'Cancelled.'),
         updated_at = now()
   where status = 'queued'
     and cancel_requested;

  update public.studio_job
     set status = 'failed',
         error = 'The worker stopped while doing this, three times. Try again.',
         updated_at = now()
   where status = 'running'
     and attempts >= 3
     and coalesce(heartbeat_at, claimed_at, created_at) < now() - make_interval(secs => p_stale_seconds);

  update public.studio_job
     set status = 'queued',
         worker_id = null,
         updated_at = now()
   where status = 'running'
     and attempts < 3
     and coalesce(heartbeat_at, claimed_at, created_at) < now() - make_interval(secs => p_stale_seconds);

  -- Fair turns: the workspace with the fewest jobs running goes first, then
  -- the oldest job.
  select j.id into picked
    from public.studio_job j
   where j.status = 'queued'
     and j.cancel_requested = false
     and j.kind = any (p_kinds)
   order by (
              select count(*)
                from public.studio_job r
               where r.workspace_id = j.workspace_id
                 and r.status = 'running'
            ),
            j.created_at
   limit 1
   for update of j skip locked;

  if picked is null then
    return;
  end if;

  return query
    update public.studio_job
       set status = 'running',
           worker_id = p_worker,
           attempts = attempts + 1,
           claimed_at = now(),
           heartbeat_at = now(),
           updated_at = now()
     where id = picked
    returning *;
end;
$$;

revoke execute on function public.studio_claim_job(text, text[], integer) from public, anon, authenticated;
grant execute on function public.studio_claim_job(text, text[], integer) to service_role;

-- ------------------------------------------------------------
-- 2. studio_job_running_idx
-- ------------------------------------------------------------

create index if not exists studio_job_running_idx
  on public.studio_job (workspace_id) where status = 'running';

-- ------------------------------------------------------------
-- 3. studio_workspace_bytes
-- ------------------------------------------------------------

create index if not exists studio_blob_workspace_bytes_idx
  on public.studio_blob (workspace_id) include (bytes);

create or replace function public.studio_workspace_bytes(p_workspace uuid)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select sum(b.bytes) from public.studio_blob b where b.workspace_id = p_workspace), 0)::bigint
       + coalesce((
           select sum(case when (r.value ->> 'bytes') ~ '^[0-9]{1,15}$' then (r.value ->> 'bytes')::bigint else 0 end)
             from public.studio_record r
            where r.workspace_id = p_workspace
              and r.collection = 'blob-writes'
         ), 0)::bigint;
$$;

revoke execute on function public.studio_workspace_bytes(uuid) from public, anon, authenticated;
grant execute on function public.studio_workspace_bytes(uuid) to service_role;

notify pgrst, 'reload schema';

commit;

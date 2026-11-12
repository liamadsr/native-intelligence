-- ============================================================
-- 627: Studio: the open-job caps hold under requests at once.
-- ============================================================
-- One workspace may have 20 Studio jobs waiting or running, 5 of them
-- exports (src/lib/studio/server/jobs.ts). The app counted them, then
-- inserted the new job: two requests at once could both count 19 and both
-- insert, and a burst could pass the cap by as many requests as arrived
-- together.
--
--   1. studio_queue_job   counts the workspace's open jobs and inserts the
--                         new one in one transaction, holding a lock on that
--                         workspace's queue (a transaction-scoped advisory
--                         lock: requests of other workspaces never wait).
--                         Past a cap it inserts nothing and answers no row;
--                         the app then says which cap.
--
-- The byte quota needs no database change: the app records a pending write
-- before it checks the total, which counts it (src/lib/studio/server/blobs.ts).
--
-- Service role only, as 620. Additive. Idempotent. Studio objects only. No
-- backslashes anywhere in this file (one MCP transport decodes escapes).
--
-- Order: either way. Until this function exists the app counts first and
-- inserts after, as before (it reads PostgREST's PGRST202 as "not there").
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. studio_queue_job
-- ------------------------------------------------------------

create or replace function public.studio_queue_job(
  p_workspace uuid,
  p_kind text,
  p_input jsonb,
  p_video uuid,
  p_created_by uuid,
  p_max_open integer,
  p_max_exports integer
)
returns setof public.studio_job
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  open_jobs integer;
  open_exports integer;
begin
  -- One queue per workspace at a time, until this transaction ends.
  perform pg_advisory_xact_lock(hashtextextended('studio_queue_job:' || p_workspace::text, 0));

  select count(*),
         count(*) filter (where j.kind = 'export')
    into open_jobs, open_exports
    from public.studio_job j
   where j.workspace_id = p_workspace
     and j.status in ('queued', 'running')
     and j.cancel_requested = false;

  if open_jobs >= p_max_open or (p_kind = 'export' and open_exports >= p_max_exports) then
    return;
  end if;

  return query
    insert into public.studio_job (workspace_id, video_id, kind, input, created_by)
    values (p_workspace, p_video, p_kind, coalesce(p_input, '{}'::jsonb), p_created_by)
    returning *;
end;
$$;

revoke execute on function public.studio_queue_job(uuid, text, jsonb, uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.studio_queue_job(uuid, text, jsonb, uuid, uuid, integer, integer) to service_role;

notify pgrst, 'reload schema';

commit;

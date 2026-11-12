-- ============================================================
-- 631: Studio: the paid job kinds a stale claim fails, never queues again.
-- ============================================================
-- 625 made studio_claim_job end a stale running PAID job as failed instead of
-- putting it back in the queue: the provider may have charged for the first
-- attempt, and a second attempt refuses to spend anyway, so the person is
-- told to check the costs before trying again. 625 named the two paid kinds
-- there were then (a generated shot, a narration). The Studio has three more
-- now: a re-voiced take, designed sound effects and a music bed. Left out,
-- one of those whose worker went quiet would go back in the queue, be taken
-- again, refuse to spend, and end with a plain "interrupted" failure that
-- says nothing about a possible charge.
--
--   1. studio_claim_job      replaced whole, same signature and grants. The
--                            body is 625's, word for word, but for the list
--                            of paid kinds, which is now the list jobs.ts
--                            names in PAID_KINDS: shot, narration, revoice,
--                            sound-effect, music. A test holds the two lists
--                            equal and the rest of the body equal to 625's.
--
-- Service role only, as 620. Idempotent. No backslashes anywhere in this file
-- (one MCP transport decodes escapes).
--
-- Order: apply after 625 and before the app code that queues the new paid
-- kinds is rolled out. Applied late, nothing breaks and nothing is charged
-- twice: only the sentence a person reads after a worker died is the plainer
-- one.
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
     and kind in ('shot', 'narration', 'revoice', 'sound-effect', 'music')
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

notify pgrst, 'reload schema';

commit;

-- ============================================================
-- 517: run the activity log's backfill (516).
-- ============================================================
-- Schedules the pg_cron job 'entity-activity-backfill': every 2 seconds it
-- runs ONE batch (entity_activity_backfill_tick, 1000 rows of one source),
-- each tick its own transaction, so no lock is held past a batch and the
-- run works however this file is applied (inside a transaction or not). The
-- job unschedules itself once every source is done, and in every other case
-- 516's tick lists (30 failures in a row, a merge queued past 10 minutes, no
-- batch moving for 10 minutes, 60 minutes since this file ran), with the
-- reason on entity_activity_backfill_run.
--
-- Watch it:   select source, seen, inserted, failures, last_error, done_at
--               from public.entity_activity_backfill_progress order by ord;
--             select * from public.entity_activity_backfill_run;
-- Stop it:    select cron.unschedule('entity-activity-backfill');
-- Run again:  update public.entity_activity_backfill_progress
--               set after_id = null, done_at = null, failures = 0;
--             then apply this file again. Nothing is written twice.
--
-- After 516. Idempotent: cron.schedule with a job name replaces the job of
-- that name; nothing is scheduled when every source is already done. No
-- backslashes anywhere in this file.
-- ------------------------------------------------------------

do $$
begin
  if exists (select 1 from public.entity_activity_backfill_progress where done_at is null) then
    insert into public.entity_activity_backfill_run (id, scheduled_at, last_progress_at, stopped_at, stop_reason)
    values (true, now(), now(), null, null)
    on conflict (id) do update
      set scheduled_at = excluded.scheduled_at, last_progress_at = excluded.last_progress_at, stopped_at = null, stop_reason = null;
    perform cron.schedule('entity-activity-backfill', '2 seconds', 'select public.entity_activity_backfill_tick()');
  end if;
end;
$$;

notify pgrst, 'reload schema';

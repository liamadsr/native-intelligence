-- Migration 331: a job's plan (docs/plans/always-on-agent.md §4b, A4 slice 2).
--
-- An agent working a job writes a short checklist of how it will get it done
-- (`update_plan`), rewritten as it learns: steps that are pending,
-- in_progress, done or skipped, one in progress at a time. It shows in the
-- job's detail panel, as a "3/5" badge on the job's row, and in the main
-- agent's reads of its helpers (list_bot_work, get_bot_item).
--
-- Why its own column and not progress.plan: the recorder rewrites the whole
-- `progress` object from its in-memory copy on every step, finish and fail,
-- and the agent-run mirror, the reaper and resolve write it whole too. A plan
-- written into `progress` from another process would be lost to whichever
-- write landed next. Those writes never name this column.
--
-- What lands:
--   tracked_job.plan   jsonb, null until an agent writes one:
--                      { steps: [{ text, status }], updated_at }. The one
--                      writer (src/lib/work/plan.ts setWorkPlan) validates
--                      every write (at most 12 steps, 140 characters each).
--                      The check keeps it a JSON object.
--
-- Realtime already carries it: tracked_job has replica identity full and is
-- in the supabase_realtime publication (migration 272). RLS is unchanged
-- (owner-only, migration 170). No backfill: existing rows have no plan.
--
-- Safe to run twice.

alter table public.tracked_job
  add column if not exists plan jsonb;

alter table public.tracked_job drop constraint if exists tracked_job_plan_object_check;
alter table public.tracked_job
  add constraint tracked_job_plan_object_check
  check (plan is null or jsonb_typeof(plan) = 'object');

comment on column public.tracked_job.plan is
  'The agent''s plan for this job: { steps: [{ text, status }], updated_at }. Written only by src/lib/work/plan.ts setWorkPlan, never part of progress.';

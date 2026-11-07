-- Migration 156: loop engine — schedule-trigger groundwork for Flows.
-- (docs/loop-engine/DESIGN.md; DESIGN says 155 but that number was taken.)
--
-- Flows becomes the loop engine: schedule + capture_processed triggers driving
-- run_skill actions. This migration is only the schema seam the scheduler
-- needs — flow.next_run_at is the scheduler's queue. The 5-minute Vercel-cron
-- tick (/api/cron/flow-schedule) scans `trigger_type='schedule' AND enabled
-- AND next_run_at <= now()` and compare-and-sets next_run_at forward per fire
-- (the CAS is the double-fire guard across overlapping ticks).
--
-- Verified against the current schema, so NOT re-touched here:
--   - flow.trigger_type is text + CHECK since migration 135, and that CHECK
--     already permits all four trigger types (entity_status_change,
--     capture_processed, pr_status_changed, schedule).
--   - flow.created_by exists since migration 107 (uuid NOT NULL references
--     auth.users) — the run-as identity for headless skill runs resolves
--     from it (created_by ?? workspace owner).
--   - flow.team_id is already nullable (migration 135 step 8) — schedule /
--     capture_processed flows are workspace-scoped and store team_id NULL.
--
-- Idempotent: safe to re-run.

ALTER TABLE public.flow
  ADD COLUMN IF NOT EXISTS next_run_at timestamptz;

COMMENT ON COLUMN public.flow.next_run_at IS
  'Next due instant (UTC) for schedule-trigger flows. Set by the API on create/update via computeNextRun (src/lib/flows/schedule.ts) and compare-and-set forward by the cron tick on each fire. NULL for non-schedule flows.';

-- Partial index for the schedule tick's hot-path scan. Partial on
-- trigger_type so the (large) non-schedule majority of rows never enter it.
CREATE INDEX IF NOT EXISTS idx_flow_schedule_due
  ON public.flow (enabled, next_run_at)
  WHERE trigger_type = 'schedule';

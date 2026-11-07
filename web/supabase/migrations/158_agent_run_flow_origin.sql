-- Migration 158: flow-origin agent runs
-- Depends on: 146_agent_run.sql, 156_loop_engine.sql (flow table)
--
-- (docs/loop-engine/RUN-AGENT-DESIGN.md; DESIGN says 156 but 156/157 were taken —
--  next free number is 158.)
--
-- A run_agent flow action dispatches a coding run that references its
-- originating FLOW, not an action. schedule/capture_processed flows have no
-- triggering action at all, so action_id must be nullable; and even an
-- action-triggered flow should point at the flow so provenance is honest.
--
-- NOT applied in v1: run_agent dispatch is disarmed behind
-- RUN_AGENT_DISPATCH_ENABLED (default false), so no flow-origin agent_run row is
-- ever written until the feature is armed. Applying this migration (DEV → PROD)
-- is a PREREQUISITE of arming, documented in the rollout — not of shipping.
--
-- Idempotent: safe to re-run.

-- action_id was NOT NULL (146:16). A flow-origin run has no bound action for
-- schedule/capture_processed triggers, so drop the constraint.
ALTER TABLE public.agent_run ALTER COLUMN action_id DROP NOT NULL;

-- Back-reference to the originating flow. SET NULL (not cascade) so deleting a
-- flow leaves its run history intact (the run still carries workspace_id).
ALTER TABLE public.agent_run
  ADD COLUMN IF NOT EXISTS flow_id UUID REFERENCES public.flow (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS agent_run_flow_idx ON public.agent_run (flow_id, created_at DESC);

-- A run must have at least one origin (an action, a flow, or both). Guarded so
-- a re-run doesn't error on the already-present constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_run_has_origin'
  ) THEN
    ALTER TABLE public.agent_run
      ADD CONSTRAINT agent_run_has_origin CHECK (action_id IS NOT NULL OR flow_id IS NOT NULL);
  END IF;
END $$;

-- RLS is unchanged — every policy already keys on workspace_id (146:51-65),
-- which flow-origin runs still carry.

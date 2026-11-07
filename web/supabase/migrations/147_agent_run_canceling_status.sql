-- Add a transient `canceling` status to agent_run.
--
-- When a user hits Stop on a running cloud agent run, the cancel API flips the
-- run to `canceling` for immediate UI feedback, then emits agent/run.cancel.
-- The agentRunCancel Inngest function stops the Vercel Sandbox and settles the
-- run to the terminal `canceled` state. `canceling` is the in-between.

ALTER TABLE agent_run DROP CONSTRAINT IF EXISTS agent_run_status_check;

ALTER TABLE agent_run ADD CONSTRAINT agent_run_status_check
  CHECK (status = ANY (ARRAY[
    'queued'::text,
    'running'::text,
    'canceling'::text,
    'pr_open'::text,
    'completed'::text,
    'failed'::text,
    'canceled'::text
  ]));

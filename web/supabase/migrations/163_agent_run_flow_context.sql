-- Migration 163: carry a flow-origin agent run's context on the row (GEN-146 arming).
-- Depends on: 146_agent_run.sql, 158_agent_run_flow_origin.sql.
--
-- An action-origin agent run derives everything it needs from the triggering
-- action: the <issue> task prompt (from the action's title/description/status)
-- and the agent persona (from the action's ai_team_member assignee). A
-- FLOW-origin run (run_agent flow action; action_id NULL) has no action — its
-- task text comes from the flow's template-rendered `instructions` and its
-- persona from a config-picked `recipe` (category 'agent'). Those two facts have
-- nowhere to live on agent_run today, so the sandbox loader can't reconstruct
-- them for a null-action_id run.
--
-- Add two nullable columns:
--   * task_prompt      — the fully-rendered task text the flow executor built at
--                        dispatch (issue block + rendered instructions). The
--                        loader uses it verbatim when action_id IS NULL.
--   * agent_recipe_id  — the config-picked agent recipe (category 'agent'). The
--                        loader resolves the persona from it when there's no
--                        ai_team_member_id assignee.
--
-- The action path leaves both NULL and is completely unchanged. This is a
-- PREREQUISITE of arming run_agent (RUN_AGENT_DISPATCH_ENABLED), not of shipping
-- — no run_agent row is ever written until the flag is flipped, so these columns
-- stay NULL on every existing row.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE public.agent_run
  ADD COLUMN IF NOT EXISTS task_prompt TEXT;

ALTER TABLE public.agent_run
  ADD COLUMN IF NOT EXISTS agent_recipe_id UUID REFERENCES public.recipe (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.agent_run.task_prompt IS
  'Flow-origin runs only (action_id NULL): the fully-rendered task text built by the run_agent flow executor. NULL for action-origin runs, which derive their prompt from the action.';
COMMENT ON COLUMN public.agent_run.agent_recipe_id IS
  'Flow-origin runs only: the config-picked agent recipe (category ''agent'') whose persona the run uses. NULL for action-origin runs, which resolve the persona from ai_team_member_id.';

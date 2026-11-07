-- Add 'eval_case' and 'eval_run' to view_entity_type.
--
-- The suite detail page's Cases and Runs tabs become scoped views-system lists
-- (UnifiedViewLayout with entityType="eval_case" / "eval_run" and a fixed
-- suite_id scope), the way a project's Actions tab embeds a scoped actions
-- view. GET /api/account/views?entity_type=<x> filters the `view` table on this
-- enum, so both values must exist before the code ships. Mirrors 254 (which
-- added 'eval_suite'), 230 and 249.
--
-- Note: ALTER TYPE ... ADD VALUE cannot be USED in the transaction that adds
-- it — this file adds the values and nothing else.
ALTER TYPE public.view_entity_type ADD VALUE IF NOT EXISTS 'eval_case';
ALTER TYPE public.view_entity_type ADD VALUE IF NOT EXISTS 'eval_run';

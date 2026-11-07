-- Migration 246: let existing run_skill flow actions follow the workspace's
-- "Loops & flows" model (Settings → AI Models) instead of a pinned default.
--
-- Migration 209 materialized config.model = 'deepseek-v4-flash' on every
-- run_skill action that had no explicit choice, so the (then new) per-action
-- picker had a value to render. That value was the DEFAULT, not a user's pick.
-- Now that the default is a per-workspace setting and the editor renders an
-- absent model as "Workspace default · <current model>", a materialized default
-- is worse than absent: it silently pins the loop to whatever the default was
-- at backfill time and ignores the workspace setting.
--
-- So: strip config.model from run_skill actions whose value is exactly the code
-- default 'deepseek-v4-flash'. Any other explicit value (Sonnet, Kimi, Pro…) is
-- an intentional pin and is left alone. A user who deliberately picked Flash
-- lands on "Workspace default", which resolves to Flash today — the only
-- observable difference is that a future setting change now reaches them,
-- which is the intended semantic.
--
-- Same jsonb rewrite shape as 209 (WITH ORDINALITY preserves order; the WHERE
-- guard makes re-runs a no-op). Additive/zero-downtime: run-skill.ts resolves
-- an absent model to the workspace setting whether or not this has run.
--
-- Apply AFTER the editor code that renders an absent model is deployed (an old
-- editor client hydrates absent → 'deepseek-v4-flash' and would re-stamp it on
-- its next save; harmless, but it undoes this for that flow).

update public.flow f
set actions = (
  select jsonb_agg(
    case
      when a->>'type' = 'run_skill'
       and a->'config'->>'model' = 'deepseek-v4-flash'
      then jsonb_set(a, '{config}', (a->'config') - 'model')
      else a
    end
    order by idx
  )
  from jsonb_array_elements(f.actions) with ordinality as t(a, idx)
)
where exists (
  select 1
  from jsonb_array_elements(f.actions) as a
  where a->>'type' = 'run_skill'
    and a->'config'->>'model' = 'deepseek-v4-flash'
);

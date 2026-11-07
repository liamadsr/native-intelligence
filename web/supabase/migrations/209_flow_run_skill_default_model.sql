-- Migration 209: backfill the per-action `model` key on every run_skill flow
-- action whose config has no explicit choice — loops/flows now default to
-- DeepSeek Flash ('deepseek-v4-flash', provider 'deepseek', priced in
-- ai_model_costs). The run_skill seam already resolves config.model
-- (RunSkillActionConfig.model → validateRunSkillConfig → resolveModel() in
-- assembleSkillRun); backfilling makes the default an explicit, stored value so
-- the new per-action model picker in the flow editor renders the real choice
-- instead of an empty field, rather than leaving it implicit.
--
-- flow.actions is a jsonb ARRAY of action objects; each run_skill action's
-- `config` object may carry a `model` key. We rebuild the array setting
-- config.model to 'deepseek-v4-flash' for exactly those run_skill elements whose
-- model is absent, null, or the empty string, leaving non-run_skill elements and
-- already-set non-empty model values untouched, and preserving element order
-- (WITH ORDINALITY, ORDER BY idx). The WHERE guard keeps this a no-op on flows
-- with no such element and makes re-running it idempotent — once backfilled, no
-- row matches. Empty actions arrays match neither the guard nor the rewrite and
-- are skipped.
--
-- MUST be applied AFTER the app code that reads/writes config.model in the editor
-- is deployed: the old editor save path (actionToEditor/buildSavePayload) did not
-- round-trip `model` and drops unknown config keys, so a save from an old client
-- against a backfilled flow would silently wipe the value written here.
--
-- Additive/idempotent, zero-downtime: an in-flight run resolves the same default
-- via resolveModel() whether or not config.model is materialized, so a run
-- mid-migration is unaffected either way.

update public.flow f
set actions = (
  select coalesce(
    jsonb_agg(
      case
        when action ->> 'type' = 'run_skill'
          and coalesce(action #>> '{config,model}', '') = ''
        then jsonb_set(
          action,
          '{config,model}',
          '"deepseek-v4-flash"'::jsonb,
          true
        )
        else action
      end
      order by idx
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(f.actions) with ordinality as elems(action, idx)
)
where jsonb_typeof(actions) = 'array'
  and exists (
    select 1
    from jsonb_array_elements(f.actions) as a(action)
    where a.action ->> 'type' = 'run_skill'
      and coalesce(a.action #>> '{config,model}', '') = ''
  );

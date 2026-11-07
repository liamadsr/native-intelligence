-- Migration 204: strip the per-action `runtime` key from every flow action's
-- config — Runtime Controller W-C.
--
-- Design: docs/loop-engine/RUNTIME-CONTROLLER-DESIGN.md (W-C data migration).
-- LIAM 2026-07-18 (Decisions §2): per-loop runtime is REMOVED outright and legacy
-- values are WIPED. The workspace-level compute_policy (workspace.settings jsonb,
-- resolved in src/lib/flows/compute-policy.ts) is the only control — no silent
-- legacy override may survive on a flow action's config.
--
-- flow.actions is a jsonb ARRAY of action objects; each run_skill action's
-- `config` object may carry a `runtime` key ('gateway' | 'local' | 'eve'). We
-- rebuild the array with `config` minus that key, for every flow whose action
-- list actually contains one (the WHERE guard keeps this a no-op on the rest and
-- makes re-running it idempotent — once stripped, no row matches).
--
-- Additive/idempotent, zero-downtime: the executor no longer reads config.runtime
-- (it resolves the workspace compute_policy), so a run mid-migration is
-- unaffected either way.

update public.flow f
set actions = (
  select coalesce(
    jsonb_agg(
      case
        when action ? 'config'
        then jsonb_set(action, '{config}', (action -> 'config') - 'runtime')
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
    where (a.action -> 'config') ? 'runtime'
  );

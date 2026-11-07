-- Migration 205: fold each workspace's EXPLICIT auto_accept_policy into the new
-- trust_policy (One Accept Authority, W-2 / D3).
--
-- Design: docs/loop-engine/ONE-ACCEPT-AUTHORITY-DESIGN.md (W-2, trap "Mig 205 is
-- a data migration over workspace.settings JSONB — read-modify-write per row,
-- never a blind jsonb_set over all workspaces in one statement without the
-- existing-keys merge").
--
-- The single trust authority lives at workspace.settings.trust_policy. Before
-- this, extraction judged auto-apply from settings.auto_accept_policy (flat
-- per-type thresholds: { enabled, claims, actions, decisions, allow_external }).
-- This lifts each workspace's existing values into the per-entity trust_policy
-- shape so a workspace that tuned auto-accept keeps its tuning.
--
-- EXPLICIT-POLICY-ONLY FOLD: only rows that HAVE an auto_accept_policy key are
-- folded. A workspace with neither key gets NO trust_policy row and reads pure
-- defaults at resolve time (trust-policy.ts DEFAULT_TRUST_POLICY) — this keeps
-- untuned fleets on per-channel historic defaults (extraction 0.8, verdict
-- 0.85; see resolveTrust's explicit-only inheritance), and keeps future DEFAULT
-- changes reachable without another data migration.
--
-- SHAPE FOLD RULES (mirrors trust-policy.ts liftLegacyPolicy + the D2 upgrade):
--   - actions.min_confidence    ← auto_accept_policy.actions   (default 0.8)
--   - decisions.min_confidence  ← auto_accept_policy.decisions (default 0.85)
--   - milestones.min_confidence ← the legacy ACTIONS threshold (milestones were
--       historically bucketed into the actions threshold)
--   - claims.min_confidence     ← auto_accept_policy.claims    (default 0.85)
--   - decisions + milestones gain require_explicit=true (the D2 rule — the
--       track's deliberate change); actions/claims stay require_explicit=false.
--   - allow_external ← auto_accept_policy.allow_external (default false)
--   - enabled ← auto_accept_policy.enabled (default true)
--
-- CAST HARDENING: every ::boolean / ::numeric cast is guarded by jsonb_typeof so
-- one malformed hand-edited row (e.g. "enabled": "yes") degrades to the default
-- for that field instead of aborting the whole migration.
--
-- IDEMPOTENT: only touches rows that do NOT already have settings.trust_policy,
-- so a re-run is a no-op. The legacy auto_accept_policy key is LEFT IN PLACE —
-- resolveTrustPolicy still reads it as a fallback for one release, and the
-- trust-settings PATCH keeps dual-writing its claims keys for the legacy claim
-- consumers until PR-2 migrates them.
--
-- ZERO-DOWNTIME: read-modify-write merges trust_policy INTO the existing
-- settings jsonb per row (jsonb_set), so no other settings key is disturbed.

update public.workspace w
set settings = jsonb_set(
  coalesce(w.settings, '{}'::jsonb),
  '{trust_policy}',
  jsonb_build_object(
    'enabled',
    case
      when jsonb_typeof(w.settings #> '{auto_accept_policy,enabled}') = 'boolean'
        then (w.settings #> '{auto_accept_policy,enabled}')::boolean
      else true
    end,
    'actions', jsonb_build_object(
      'enabled', true,
      'min_confidence',
        case
          when jsonb_typeof(w.settings #> '{auto_accept_policy,actions}') = 'number'
            then (w.settings #>> '{auto_accept_policy,actions}')::numeric
          else 0.8
        end,
      'require_explicit', false
    ),
    'decisions', jsonb_build_object(
      'enabled', true,
      'min_confidence',
        case
          when jsonb_typeof(w.settings #> '{auto_accept_policy,decisions}') = 'number'
            then (w.settings #>> '{auto_accept_policy,decisions}')::numeric
          else 0.85
        end,
      'require_explicit', true
    ),
    'milestones', jsonb_build_object(
      'enabled', true,
      -- Milestones were bucketed into the legacy ACTIONS threshold; carry that
      -- floor forward (default 0.8), then apply the D2 explicitness rule.
      'min_confidence',
        case
          when jsonb_typeof(w.settings #> '{auto_accept_policy,actions}') = 'number'
            then (w.settings #>> '{auto_accept_policy,actions}')::numeric
          else 0.8
        end,
      'require_explicit', true
    ),
    'claims', jsonb_build_object(
      'enabled', true,
      'min_confidence',
        case
          when jsonb_typeof(w.settings #> '{auto_accept_policy,claims}') = 'number'
            then (w.settings #>> '{auto_accept_policy,claims}')::numeric
          else 0.85
        end,
      'require_explicit', false
    ),
    'allow_external',
    case
      when jsonb_typeof(w.settings #> '{auto_accept_policy,allow_external}') = 'boolean'
        then (w.settings #> '{auto_accept_policy,allow_external}')::boolean
      else false
    end
  ),
  true
)
where jsonb_typeof(coalesce(w.settings, '{}'::jsonb)) = 'object'
  and (coalesce(w.settings, '{}'::jsonb) ? 'auto_accept_policy')
  and not (coalesce(w.settings, '{}'::jsonb) ? 'trust_policy');

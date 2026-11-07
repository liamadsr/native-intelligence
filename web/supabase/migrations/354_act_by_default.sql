-- ============================================================
-- 354: agents act by default; Dial8's trust defaults for everyone
-- ============================================================
-- Decision, 2026-10-17 (Liam): opinionated platform, no configuration
-- fatigue. Agents make a first pass on drafting work by default, every
-- workspace runs Dial8's tuned trust defaults, and the knobs for both go.
--
-- The code that ships with this file already behaves this way for a
-- workspace with nothing stored: workspace.settings.agent_autonomy.mode
-- defaults to 'attempt' (src/lib/work/agent-autonomy-policy.ts), the
-- auto-attempt gate creates a workspace's role teammates on first need
-- (ensureRoleTeammates, src/lib/work/role-routing.ts), and a missing
-- trust_policy resolves to DEFAULT_TRUST_POLICY
-- (src/lib/proposed-changes/trust-policy.ts). This file brings the stored
-- rows in line, so no workspace keeps the old opt-in state:
--
--   1. Autonomy: every workspace whose agent_autonomy.mode is unset,
--      'propose' or not a known mode becomes 'attempt'. A workspace an admin
--      switched 'off' stays off (the kill switch is the one choice left), and
--      'attempt' is left as it is. Every other key of agent_autonomy and of
--      settings is kept. A settings value that is not a jsonb object is left
--      alone (the app reads it as the defaults anyway).
--   2. Trust: the Trust page and its write API are gone, so every stored
--      override goes: settings.trust_policy, and the legacy
--      settings.auto_accept_policy that resolveTrustPolicyFromSettings still
--      lifts when trust_policy is absent. Every workspace then resolves
--      DEFAULT_TRUST_POLICY, in which external actions always wait for a
--      person (allow_external false).
--
-- Role teammates are NOT seeded here: the auto-attempt gate creates a
-- workspace's role teammates the first time its work needs one
-- (ensureRoleTeammates). Seeding all of them up front would add four agents
-- to every workspace's lists (about 580 on PROD) before any of them has
-- anything to do.
--
-- HubSpot meeting logging needs no rows: a missing log_meetings_to_hubspot
-- now means on (src/lib/crm/hubspot-meeting-log.ts), and an explicit false is
-- a choice someone made, so it is left alone.
--
-- Order: apply after the web deploy of the branch that ships this file
-- (claude/learn-by-default). Before it, step 1 would turn attempts on under
-- code that still reads AGENT_AUTO_ATTEMPT_ENABLED as opt-in (so nothing
-- would attempt), and step 2 would remove overrides the old Trust page could
-- still write back. Nothing breaks either way; the deploy first keeps the
-- story simple.
--
-- Idempotent: step 1 only touches rows not already 'attempt' or 'off', step 2
-- only rows that still hold a key it removes. A second run changes nothing.
-- Each step reports its count with RAISE NOTICE. This file holds no backslash
-- anywhere: one MCP transport decodes escapes, so the applied SQL would
-- differ from the file.
-- ============================================================

-- SET LOCAL holds for the transaction MCP apply_migration wraps this file in.
SET LOCAL lock_timeout = '5s';

-- ── 1. Autonomy: attempt unless switched off ────────────────────────────────
DO $autonomy$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.workspace w
  SET settings = jsonb_set(
    coalesce(w.settings, '{}'::jsonb),
    '{agent_autonomy}',
    CASE
      WHEN jsonb_typeof(w.settings -> 'agent_autonomy') = 'object' THEN w.settings -> 'agent_autonomy'
      ELSE '{}'::jsonb
    END || '{"mode": "attempt"}'::jsonb
  )
  WHERE (w.settings IS NULL OR jsonb_typeof(w.settings) = 'object')
    AND coalesce(w.settings -> 'agent_autonomy' ->> 'mode', '') NOT IN ('off', 'attempt');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '354 step 1: % workspace(s) switched to agent_autonomy.mode attempt', v_count;
END
$autonomy$;

-- ── 2. Trust: every workspace on Dial8's defaults ───────────────────────────
DO $trust$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.workspace w
  SET settings = w.settings - 'trust_policy' - 'auto_accept_policy'
  WHERE jsonb_typeof(w.settings) = 'object'
    AND (w.settings ? 'trust_policy' OR w.settings ? 'auto_accept_policy');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '354 step 2: % workspace(s) lost their stored trust overrides', v_count;
END
$trust$;

-- ============================================================
-- 449: every feature on, for every workspace (founder decision, 10-27)
-- ============================================================
-- The code half (src/lib/editions/manifest.ts, invariant 5) makes every
-- edition's preset 'all' and drops the opt-in flag from Evals and the Agent
-- browser, so a workspace with nothing stored has the whole app. Onboarding no
-- longer writes anything from the role chips either.
--
-- This file clears what the old rules left in workspace.settings, so every
-- workspace follows that default instead of a stored choice:
--
--   feature_overrides       every per-feature 'on' / 'off'. Under the new
--                           code an 'on' changes nothing and an 'off' is the
--                           only thing that could still hide a feature.
--   weaver.anchor_types     the knowledge anchor set onboarding derived from
--                           the role chips (it could only NARROW the set). With
--                           it gone the weaver anchors to what the features
--                           give: project, company and campaign.
--
-- settings.edition stays: it now picks only the persona (a sales workspace's
-- default meeting agents), never a feature.
--
-- ORDER: apply AFTER the code is live on the environment. Before it, a
-- 'sales' workspace's 'on' keys are what give it Projects, Flows and the rest,
-- and a 'full' one's are what give it Evals and the browser.
--
-- Idempotent: each UPDATE only touches rows that still hold the key. This file
-- holds no backslash anywhere: one MCP transport decodes escapes, so the
-- applied SQL would differ from the file.
-- ============================================================

SET LOCAL lock_timeout = '5s';

UPDATE public.workspace w
SET settings = w.settings - 'feature_overrides'
WHERE jsonb_typeof(w.settings) = 'object'
  AND w.settings ? 'feature_overrides';

UPDATE public.workspace w
SET settings = w.settings #- '{weaver,anchor_types}'
WHERE jsonb_typeof(w.settings) = 'object'
  AND jsonb_typeof(w.settings -> 'weaver') = 'object'
  AND w.settings -> 'weaver' ? 'anchor_types';

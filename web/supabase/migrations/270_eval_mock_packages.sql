-- ============================================================
-- 270: Eval mock packages
-- ============================================================
-- RECORD OF AN ALREADY-APPLIED MIGRATION. This ran on both Supabase
-- projects on 2026-09-15 under the name `270_eval_mock_packages` — Dial8
-- PRD (version 20260915145237) and Dial8 DEV (version 20260915145239) —
-- with no matching file in this directory. The statements below are
-- transcribed verbatim from `supabase_migrations.schema_migrations` on
-- PRD, whose body is the complete one: DEV received the same DDL (both
-- columns and the index) but not the three COMMENT ON COLUMN statements.
-- Every statement is idempotent, so re-applying is harmless and only the
-- comments would take effect on DEV.
--
-- As of this commit no code on main reads `eval_case.mock_packages`; the
-- feature that consumes these columns is still on its own branch. This
-- file exists so the repo ledger matches the databases.
--
-- What it adds: an eval case can carry authored mock context packages
-- (`mock_packages`) and the ids of the packages attached to every capture
-- it produces (`package_ids`); a knowledge package materialized for an
-- eval is flagged `is_eval` so list readers can default-exclude it, with
-- a partial index per workspace for that fence.

ALTER TABLE public.eval_case
  ADD COLUMN IF NOT EXISTS mock_packages jsonb NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN public.eval_case.mock_packages IS
  'Authored mock context packages: [{key, name, description?, content, package_id?}]. '
  '`content` is the markdown the agent must be able to pull with get_package (≤16KB each); '
  '`package_id` is the knowledge_package row createEvalCase/updateEvalCase materialized for it.';
ALTER TABLE public.eval_case
  ADD COLUMN IF NOT EXISTS package_ids uuid[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN public.eval_case.package_ids IS
  'Packages attached to every capture this case produces — the materialized ids from '
  'mock_packages, plus any REAL workspace package ids passed explicitly at create/update '
  '(validated with package_visible_to for the caller). Copied onto captures.package_ids by '
  'insertTemplateCapture and cloneTrialCapture, which is what makes the live-agent route '
  'build a manifest and promote get_package for the trial.';
ALTER TABLE public.knowledge_package
  ADD COLUMN IF NOT EXISTS is_eval boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.knowledge_package.is_eval IS
  'A synthetic package materialized for an eval case (migration 270). Every reader that '
  'LISTS packages for a human or an agent must default-exclude these; a read that resolves '
  'one BY ID must NOT, because get_package(package_id) is how the agent under test pulls it.';
CREATE INDEX IF NOT EXISTS idx_knowledge_package_is_eval
  ON public.knowledge_package (workspace_id) WHERE is_eval = true;

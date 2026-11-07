-- Migration 160: flow.seed_key — mark the default loop-set seeded on workspace
-- creation (GEN-148, docs/loop-engine/SEED-LOOPS-DESIGN.md).
--
-- The design proposed "159_flow_seed_key" but 159 was taken by the catalog
-- rebuild, so this is 160.
--
-- seed_key is a stable machine tag ('seed:triage', 'seed:groom',
-- 'seed:reconcile', 'seed:brief') stamped on each flow that seedDefaultLoops()
-- inserts. It serves two purposes:
--   1. Idempotency — the partial unique index below is the DB-level guard
--      against a concurrent double-seed of the SAME workspace: the second
--      seeder's plain INSERT violates it with 23505, which the seeder catches
--      and treats as "already seeded". (Note: the seeder uses a plain INSERT,
--      NOT an ON CONFLICT upsert — Postgres cannot infer a PARTIAL index as an
--      ON CONFLICT arbiter without its predicate restated, which PostgREST
--      can't emit, so an upsert would raise 42P10. The app-level "read existing
--      seed_keys first" check is the primary idempotency mechanism.)
--   2. UI predicate — "is this a seeded loop?" is `seed_key IS NOT NULL`, which
--      drives the onboarding panel's loop list and the flows-canvas "Seeded"
--      badge.
--
-- User-created flows never set seed_key (it stays NULL), so they are unaffected
-- by the unique index and are never mistaken for seeded loops.
--
-- Idempotent: safe to re-run.

ALTER TABLE public.flow
  ADD COLUMN IF NOT EXISTS seed_key text;

COMMENT ON COLUMN public.flow.seed_key IS
  'Stable machine tag for a default loop seeded on workspace creation (GEN-148): seed:triage | seed:groom | seed:reconcile | seed:brief. NULL for user-created flows. Unique per workspace (partial index below) so seeding can never duplicate.';

-- Partial unique index: at most one flow per (workspace, seed_key). Partial on
-- `seed_key IS NOT NULL` so the (large) majority of user-created flows — all
-- with NULL seed_key — never enter the index and are never constrained by it.
-- This is the DB-level double-seed guard the seeder's ON CONFLICT targets.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flow_workspace_seed_key
  ON public.flow (workspace_id, seed_key)
  WHERE seed_key IS NOT NULL;

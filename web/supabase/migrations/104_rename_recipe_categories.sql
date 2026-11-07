-- Migration 104: Rename recipe_category enum values
--
-- Phase 1 of the Recipes → Skills / Agents / Meeting Types rebrand.
--
-- The user-visible concepts are being renamed to align with the
-- Anthropic/OpenAI vocabulary that users already know. The underlying
-- table is NOT renamed — `public.recipe` stays as-is because it is an
-- internal name only and renaming a table touched by ~15 migrations,
-- foreign keys, and RLS policies would be high-risk churn for zero
-- user benefit.
--
-- Value mapping:
--   'capture'    → 'meeting_type'   (Meeting types: 1:1, Project Update, etc.)
--   'agent'      → 'skill'          (Chat-invoked context+tools presets)
--   'live_agent' → 'agent'          (Autonomous agents running during a live capture)
--
-- Note the collision: the old value 'agent' and the new value 'agent'
-- mean different things. We rename in dependency order using a 3-step
-- dance: free up 'agent' first, then reclaim it for the old live_agent.
--
-- ALTER TYPE ... RENAME VALUE is supported in PG 10+ and is atomic.
-- No data migration is needed — existing rows automatically reference
-- the renamed values.
--
-- Audit (verified): no DB views, functions, triggers, or RLS policies
-- hardcode the recipe_category string values. The only hardcoded
-- reference is the column default below, which is updated in the same
-- transaction.
--
-- Idempotent: each step is wrapped in a check so re-runs are safe.

-- ────────────────────────────────────────────────────────────────────
-- Step 1: free up the name 'agent' (old 'agent' → new 'skill')
-- ────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'recipe_category' AND e.enumlabel = 'agent'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'recipe_category' AND e.enumlabel = 'skill'
  ) THEN
    ALTER TYPE public.recipe_category RENAME VALUE 'agent' TO 'skill';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────
-- Step 2: claim the now-unused 'agent' for old 'live_agent'
-- ────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'recipe_category' AND e.enumlabel = 'live_agent'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'recipe_category' AND e.enumlabel = 'agent'
  ) THEN
    ALTER TYPE public.recipe_category RENAME VALUE 'live_agent' TO 'agent';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────
-- Step 3: rename 'capture' → 'meeting_type'
-- ────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'recipe_category' AND e.enumlabel = 'capture'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'recipe_category' AND e.enumlabel = 'meeting_type'
  ) THEN
    ALTER TYPE public.recipe_category RENAME VALUE 'capture' TO 'meeting_type';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────
-- Step 4: update the column default to the new value
-- The default was 'capture' (migration 027). After the rename above,
-- the literal 'capture' no longer exists, which would break any new
-- INSERT that omits the category column.
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.recipe
  ALTER COLUMN category SET DEFAULT 'meeting_type'::public.recipe_category;

-- ────────────────────────────────────────────────────────────────────
-- Verification (commented sanity checks — uncomment when running by hand)
-- ────────────────────────────────────────────────────────────────────

-- SELECT enumlabel FROM pg_enum e
-- JOIN pg_type t ON t.oid = e.enumtypid
-- WHERE t.typname = 'recipe_category'
-- ORDER BY e.enumsortorder;
-- → Expected: meeting_type, skill, agent

-- SELECT category, COUNT(*) FROM public.recipe GROUP BY category;
-- → Expected: rows distributed across the three new values, none with old names

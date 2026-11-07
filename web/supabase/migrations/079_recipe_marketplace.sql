-- Migration 079: Recipe Marketplace
-- Adds visibility, authorship tracking, fork tracking, and marketplace metadata
-- to enable a public recipe marketplace.
-- Idempotent: safe to re-run.

-- ============================================================
-- 1. Recipe visibility enum
-- ============================================================

DO $$ BEGIN
  CREATE TYPE public.recipe_visibility AS ENUM ('personal', 'workspace', 'public');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 2. Add new columns to recipe table
-- ============================================================

ALTER TABLE public.recipe
  ADD COLUMN IF NOT EXISTS visibility public.recipe_visibility NOT NULL DEFAULT 'workspace';

ALTER TABLE public.recipe
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.recipe
  ADD COLUMN IF NOT EXISTS forked_from uuid REFERENCES public.recipe(id) ON DELETE SET NULL;

ALTER TABLE public.recipe
  ADD COLUMN IF NOT EXISTS fork_count int NOT NULL DEFAULT 0;

ALTER TABLE public.recipe
  ADD COLUMN IF NOT EXISTS author_name text;

ALTER TABLE public.recipe
  ADD COLUMN IF NOT EXISTS author_avatar_url text;

ALTER TABLE public.recipe
  ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;

ALTER TABLE public.recipe
  ADD COLUMN IF NOT EXISTS marketplace_category text;

-- ============================================================
-- 3. Indexes for marketplace queries
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_recipe_visibility_public
  ON public.recipe (visibility) WHERE visibility = 'public';

CREATE INDEX IF NOT EXISTS idx_recipe_created_by
  ON public.recipe (created_by) WHERE created_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_recipe_forked_from
  ON public.recipe (forked_from) WHERE forked_from IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_recipe_featured
  ON public.recipe (featured) WHERE featured = true;

CREATE INDEX IF NOT EXISTS idx_recipe_marketplace_category
  ON public.recipe (marketplace_category) WHERE marketplace_category IS NOT NULL;

-- ============================================================
-- 4. Backfill created_by for existing workspace recipes
--    Sets created_by to the workspace owner for recipes that
--    have a workspace_id but no created_by yet.
-- ============================================================

UPDATE public.recipe r
SET created_by = m.user_id
FROM public.member m
WHERE r.workspace_id IS NOT NULL
  AND r.created_by IS NULL
  AND r.is_system = false
  AND m.workspace_id = r.workspace_id
  AND m.role = 'owner';

-- ============================================================
-- 5. Update RLS SELECT policy
--    Additive change: preserves existing paths, adds public read.
-- ============================================================

DROP POLICY IF EXISTS "Anyone can view system recipes" ON public.recipe;
DROP POLICY IF EXISTS "recipe_select_visibility" ON public.recipe;

CREATE POLICY "recipe_select_visibility"
  ON public.recipe FOR SELECT
  USING (
    is_system = true
    OR (visibility = 'public')
    OR (
      public.is_workspace_member(workspace_id)
      AND (
        visibility = 'workspace'
        OR (visibility = 'personal' AND created_by = auth.uid())
      )
    )
  );

-- INSERT/UPDATE/DELETE policies remain unchanged (admin-only, workspace-scoped).

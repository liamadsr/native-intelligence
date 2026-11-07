-- Migration 023: Projects Upgrade, Initiatives & Milestones
-- Drops legacy goals/milestones, creates initiative table, upgrades projects, creates new milestone table
-- Idempotent: safe to re-run if partially applied.

-- ============================================================
-- 1. Drop legacy tables
-- ============================================================

DROP TABLE IF EXISTS public.milestones CASCADE;
DROP TABLE IF EXISTS public.goals CASCADE;

-- ============================================================
-- 2. Create initiative table
-- ============================================================

DO $$ BEGIN
  CREATE TYPE public.initiative_status AS ENUM ('planned', 'active', 'completed', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.initiative (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  owner_id uuid REFERENCES public.member (id) ON DELETE SET NULL,
  status public.initiative_status NOT NULL DEFAULT 'planned',
  target_date date,
  color text,
  icon text,
  sort_order real NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS initiative_workspace_idx ON public.initiative (workspace_id);
CREATE INDEX IF NOT EXISTS initiative_status_idx ON public.initiative (status);

-- ============================================================
-- 3. Upgrade projects table
-- ============================================================

DO $$ BEGIN
  CREATE TYPE public.project_status AS ENUM ('planned', 'active', 'paused', 'completed', 'canceled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS initiative_id uuid REFERENCES public.initiative (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES public.member (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS start_date date,
  ADD COLUMN IF NOT EXISTS target_date date,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Add status column separately since IF NOT EXISTS + type default is tricky
DO $$ BEGIN
  ALTER TABLE public.projects ADD COLUMN status public.project_status NOT NULL DEFAULT 'active';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS project_initiative_idx ON public.projects (initiative_id) WHERE initiative_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS project_status_idx ON public.projects (status);

-- ============================================================
-- 4. Create new milestone table (linked to projects, not goals)
-- ============================================================

DO $$ BEGIN
  CREATE TYPE public.milestone_status AS ENUM ('pending', 'in_progress', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.milestone (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id uuid NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  status public.milestone_status NOT NULL DEFAULT 'pending',
  target_date date,
  sort_order real NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS milestone_project_idx ON public.milestone (project_id);

-- ============================================================
-- 5. Add project_id and milestone_id to actions
-- ============================================================

ALTER TABLE public.actions
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS milestone_id uuid REFERENCES public.milestone (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS actions_project_idx ON public.actions (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS actions_milestone_idx ON public.actions (milestone_id) WHERE milestone_id IS NOT NULL;

-- ============================================================
-- 6. RLS policies
-- ============================================================

ALTER TABLE public.initiative ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.milestone ENABLE ROW LEVEL SECURITY;

-- Initiative policies (drop first for idempotency)
DROP POLICY IF EXISTS "Workspace members can view initiatives" ON public.initiative;
CREATE POLICY "Workspace members can view initiatives"
  ON public.initiative FOR SELECT
  USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Workspace members can create initiatives" ON public.initiative;
CREATE POLICY "Workspace members can create initiatives"
  ON public.initiative FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Owner and admins can update initiatives" ON public.initiative;
CREATE POLICY "Owner and admins can update initiatives"
  ON public.initiative FOR UPDATE
  USING (
    public.get_member_role(workspace_id) IN ('owner', 'admin')
    OR owner_id = (
      SELECT id FROM public.member
      WHERE user_id = auth.uid() AND workspace_id = initiative.workspace_id
      LIMIT 1
    )
  );

DROP POLICY IF EXISTS "Admins can delete initiatives" ON public.initiative;
CREATE POLICY "Admins can delete initiatives"
  ON public.initiative FOR DELETE
  USING (public.get_member_role(workspace_id) IN ('owner', 'admin'));

-- Milestone policies (drop first for idempotency)
DROP POLICY IF EXISTS "Workspace members can view milestones" ON public.milestone;
CREATE POLICY "Workspace members can view milestones"
  ON public.milestone FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = milestone.project_id
        AND public.is_workspace_member(p.workspace_id)
    )
  );

DROP POLICY IF EXISTS "Workspace members can manage milestones" ON public.milestone;
CREATE POLICY "Workspace members can manage milestones"
  ON public.milestone FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = milestone.project_id
        AND public.is_workspace_member(p.workspace_id)
    )
  );

DROP POLICY IF EXISTS "Workspace members can update milestones" ON public.milestone;
CREATE POLICY "Workspace members can update milestones"
  ON public.milestone FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = milestone.project_id
        AND public.is_workspace_member(p.workspace_id)
    )
  );

DROP POLICY IF EXISTS "Workspace members can delete milestones" ON public.milestone;
CREATE POLICY "Workspace members can delete milestones"
  ON public.milestone FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = milestone.project_id
        AND public.is_workspace_member(p.workspace_id)
    )
  );

-- ============================================================
-- 7. Triggers for updated_at
-- ============================================================

DROP TRIGGER IF EXISTS initiative_updated_at ON public.initiative;
CREATE TRIGGER initiative_updated_at
  BEFORE UPDATE ON public.initiative
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS project_updated_at ON public.projects;
CREATE TRIGGER project_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS milestone_updated_at ON public.milestone;
CREATE TRIGGER milestone_updated_at
  BEFORE UPDATE ON public.milestone
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

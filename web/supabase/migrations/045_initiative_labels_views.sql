-- Migration 045: Initiative Labels + Views Support
-- Adds initiative_label join table and adds 'initiative' to view_entity_type enum.

-- ============================================================
-- 1. Create initiative_label join table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.initiative_label (
  initiative_id uuid NOT NULL REFERENCES public.initiative (id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES public.label (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (initiative_id, label_id)
);

CREATE INDEX initiative_label_initiative_idx ON public.initiative_label (initiative_id);
CREATE INDEX initiative_label_label_idx ON public.initiative_label (label_id);

ALTER TABLE public.initiative_label ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view initiative labels"
  ON public.initiative_label FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.initiative i
      WHERE i.id = initiative_id
        AND public.is_workspace_member(i.workspace_id)
    )
  );

CREATE POLICY "Workspace members can manage initiative labels"
  ON public.initiative_label FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.initiative i
      WHERE i.id = initiative_id
        AND public.is_workspace_member(i.workspace_id)
    )
  );

-- ============================================================
-- 2. Add 'initiative' to view_entity_type enum
-- ============================================================

ALTER TYPE public.view_entity_type ADD VALUE IF NOT EXISTS 'initiative';

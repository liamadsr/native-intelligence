-- Migration 044: Project Labels
-- Adds project_label join table so projects can be tagged with workspace labels,
-- enabling filtering and display on the new projects page.

CREATE TABLE IF NOT EXISTS public.project_label (
  project_id uuid NOT NULL REFERENCES public.projects (id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES public.label (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, label_id)
);

CREATE INDEX project_label_project_idx ON public.project_label (project_id);
CREATE INDEX project_label_label_idx ON public.project_label (label_id);

ALTER TABLE public.project_label ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view project labels"
  ON public.project_label FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_id
        AND public.is_workspace_member(p.workspace_id)
    )
  );

CREATE POLICY "Workspace members can manage project labels"
  ON public.project_label FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_id
        AND public.is_workspace_member(p.workspace_id)
    )
  );

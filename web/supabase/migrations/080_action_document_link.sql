-- Migration 080: Action ↔ Document many-to-many link
-- Allows documents to be attached to multiple actions and vice versa.

CREATE TABLE IF NOT EXISTS public.action_document (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  action_id uuid NOT NULL REFERENCES public.actions (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.document (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (action_id, document_id)
);

CREATE INDEX IF NOT EXISTS action_document_action_idx ON public.action_document (action_id);
CREATE INDEX IF NOT EXISTS action_document_document_idx ON public.action_document (document_id);

-- RLS
ALTER TABLE public.action_document ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace members can view action documents" ON public.action_document;
CREATE POLICY "Workspace members can view action documents"
  ON public.action_document FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.actions a
    WHERE a.id = action_id AND public.is_workspace_member(a.workspace_id)
  ));

DROP POLICY IF EXISTS "Workspace members can manage action documents" ON public.action_document;
CREATE POLICY "Workspace members can manage action documents"
  ON public.action_document FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.actions a
    WHERE a.id = action_id AND public.is_workspace_member(a.workspace_id)
  ));

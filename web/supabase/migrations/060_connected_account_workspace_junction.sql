-- Migration 060: Many-to-many junction for connected accounts ↔ workspaces
-- Allows one integration (e.g. Gmail) to be visible in multiple workspaces

CREATE TABLE public.connected_account_workspace (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.connected_account(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(account_id, workspace_id)
);

CREATE INDEX idx_caw_account ON public.connected_account_workspace(account_id);
CREATE INDEX idx_caw_workspace ON public.connected_account_workspace(workspace_id);

ALTER TABLE public.connected_account_workspace ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view junction entries"
  ON public.connected_account_workspace FOR SELECT
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "Users can manage their own junction entries"
  ON public.connected_account_workspace FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.connected_account ca
      WHERE ca.id = account_id AND ca.user_id = auth.uid()
    )
  );

-- Backfill: existing accounts get their current workspace
INSERT INTO public.connected_account_workspace (account_id, workspace_id)
SELECT id, workspace_id FROM public.connected_account
WHERE workspace_id IS NOT NULL
ON CONFLICT (account_id, workspace_id) DO NOTHING;

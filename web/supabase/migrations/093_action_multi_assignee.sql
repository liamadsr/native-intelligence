-- Multi-assignee support for actions
-- Adds action_assignee join table, migrates existing assignee_id data

-- ============================================================
-- 1. Create action_assignee join table
-- ============================================================

CREATE TABLE public.action_assignee (
  action_id UUID NOT NULL REFERENCES public.actions (id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES public.member (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (action_id, member_id)
);

CREATE INDEX idx_action_assignee_member ON public.action_assignee (member_id);

-- ============================================================
-- 2. RLS — mirrors action_label pattern
-- ============================================================

ALTER TABLE public.action_assignee ENABLE ROW LEVEL SECURITY;

CREATE POLICY "action_assignee_all"
  ON public.action_assignee FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.actions a
    JOIN public.team t ON t.id = a.team_id
    WHERE a.id = action_id AND public.is_workspace_member(t.workspace_id)
  ));

-- ============================================================
-- 3. Migrate existing assignee_id data into join table
-- ============================================================

INSERT INTO public.action_assignee (action_id, member_id)
SELECT id, assignee_id
FROM public.actions
WHERE assignee_id IS NOT NULL
ON CONFLICT DO NOTHING;

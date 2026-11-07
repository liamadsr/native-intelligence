-- Migration 020: Workflow States, Labels & Action Status Migration
--
-- Replaces the plain text `status` column on actions with a proper
-- workflow_state FK. Each team gets customisable workflow states that
-- map to a fixed category enum for cross-team reporting.
-- Also adds workspace-wide labels and an action↔label join table.

-- ──────────────────────────────────────────────────────────────────
-- 1. workflow_category enum
-- ──────────────────────────────────────────────────────────────────
CREATE TYPE public.workflow_category AS ENUM (
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled'
);

-- ──────────────────────────────────────────────────────────────────
-- 2. workflow_state table
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE public.workflow_state (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id UUID NOT NULL REFERENCES public.team (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category public.workflow_category NOT NULL,
  color TEXT NOT NULL DEFAULT '#6b7280',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (team_id, name)
);

CREATE INDEX idx_workflow_state_team ON public.workflow_state (team_id);
CREATE INDEX idx_workflow_state_category ON public.workflow_state (category);

-- Only one default state per team
CREATE UNIQUE INDEX workflow_state_default_per_team
  ON public.workflow_state (team_id) WHERE (is_default = true);

-- ──────────────────────────────────────────────────────────────────
-- 3. label table (workspace-wide)
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE public.label (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6b7280',
  group_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, name)
);

CREATE INDEX idx_label_workspace ON public.label (workspace_id);
CREATE INDEX idx_label_workspace_group ON public.label (workspace_id, group_name);

-- ──────────────────────────────────────────────────────────────────
-- 4. action_label join table
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE public.action_label (
  action_id UUID NOT NULL REFERENCES public.actions (id) ON DELETE CASCADE,
  label_id UUID NOT NULL REFERENCES public.label (id) ON DELETE CASCADE,
  PRIMARY KEY (action_id, label_id)
);

CREATE INDEX idx_action_label_label ON public.action_label (label_id);

-- ──────────────────────────────────────────────────────────────────
-- 5. Trigger: auto-seed workflow states on team creation
-- ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_team_workflow_states()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.workflow_state (team_id, name, category, color, sort_order, is_default) VALUES
    (NEW.id, 'Backlog',     'backlog',    '#6b7280', 0, false),
    (NEW.id, 'Todo',        'unstarted',  '#3b82f6', 1, true),
    (NEW.id, 'In Progress', 'started',    '#a855f7', 2, false),
    (NEW.id, 'Done',        'completed',  '#22c55e', 3, false),
    (NEW.id, 'Canceled',    'canceled',   '#6b7280', 4, false);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_team_created_seed_workflow_states
  AFTER INSERT ON public.team
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_team_workflow_states();

-- ──────────────────────────────────────────────────────────────────
-- 6. Backfill workflow states for ALL existing teams
-- ──────────────────────────────────────────────────────────────────
INSERT INTO public.workflow_state (team_id, name, category, color, sort_order, is_default)
SELECT t.id, ws.name, ws.category::public.workflow_category, ws.color, ws.sort_order, ws.is_default
FROM public.team t
CROSS JOIN (VALUES
  ('Backlog',     'backlog',    '#6b7280', 0, false),
  ('Todo',        'unstarted',  '#3b82f6', 1, true),
  ('In Progress', 'started',    '#a855f7', 2, false),
  ('Done',        'completed',  '#22c55e', 3, false),
  ('Canceled',    'canceled',   '#6b7280', 4, false)
) AS ws(name, category, color, sort_order, is_default)
WHERE NOT EXISTS (
  SELECT 1 FROM public.workflow_state ws2 WHERE ws2.team_id = t.id
);

-- ──────────────────────────────────────────────────────────────────
-- 7. Add status_id and confirmation columns to actions
-- ──────────────────────────────────────────────────────────────────
ALTER TABLE public.actions
  ADD COLUMN status_id UUID REFERENCES public.workflow_state (id);

ALTER TABLE public.actions
  ADD COLUMN confirmation TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (confirmation IN ('suggested', 'confirmed', 'dismissed'));

-- ──────────────────────────────────────────────────────────────────
-- 8. Backfill status_id from old text status column
-- ──────────────────────────────────────────────────────────────────
-- Also migrate 'suggested' status into the confirmation column
UPDATE public.actions a
SET
  status_id = (
    SELECT ws.id
    FROM public.workflow_state ws
    WHERE ws.team_id = a.team_id
      AND ws.name = CASE a.status
        WHEN 'in_progress' THEN 'In Progress'
        WHEN 'completed'   THEN 'Done'
        WHEN 'cancelled'   THEN 'Canceled'
        ELSE 'Todo'  -- confirmed, suggested, or any unexpected value
      END
    LIMIT 1
  ),
  confirmation = CASE a.status
    WHEN 'suggested' THEN 'suggested'
    ELSE 'confirmed'
  END;

-- ──────────────────────────────────────────────────────────────────
-- 9. Make status_id NOT NULL, drop old status column
-- ──────────────────────────────────────────────────────────────────
ALTER TABLE public.actions ALTER COLUMN status_id SET NOT NULL;
ALTER TABLE public.actions DROP COLUMN status;

CREATE INDEX idx_actions_status_id ON public.actions (status_id);

-- ──────────────────────────────────────────────────────────────────
-- 10. RLS policies for new tables
-- ──────────────────────────────────────────────────────────────────

-- workflow_state
ALTER TABLE public.workflow_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view workflow states"
  ON public.workflow_state FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.team t
      WHERE t.id = workflow_state.team_id
        AND public.is_workspace_member(t.workspace_id)
    )
  );

CREATE POLICY "Admins and leads can manage workflow states"
  ON public.workflow_state FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.team t
      WHERE t.id = workflow_state.team_id
        AND (
          public.get_member_role(t.workspace_id) IN ('owner', 'admin')
          OR EXISTS (
            SELECT 1 FROM public.team_member tm
            JOIN public.member m ON m.id = tm.member_id
            WHERE tm.team_id = workflow_state.team_id
              AND tm.team_role = 'lead'
              AND m.user_id = auth.uid()
          )
        )
    )
  );

-- label
ALTER TABLE public.label ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view labels"
  ON public.label FOR SELECT
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "Admins can manage labels"
  ON public.label FOR ALL
  USING (public.get_member_role(workspace_id) IN ('owner', 'admin'));

-- action_label
ALTER TABLE public.action_label ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Action label access follows action access"
  ON public.action_label FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.actions a
      WHERE a.id = action_label.action_id
    )
  );

CREATE POLICY "Action owners can manage action labels"
  ON public.action_label FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.actions a
      WHERE a.id = action_label.action_id
        AND a.user_id = auth.uid()
    )
  );

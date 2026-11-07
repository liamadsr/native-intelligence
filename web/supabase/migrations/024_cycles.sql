-- Migration 024: Cycles (Sprints)
-- Time-boxed iterations per team. Only one active cycle per team at a time.
-- Actions link to cycles; unfinished actions can roll to next cycle on completion.

-- ============================================================
-- 1. Create cycle table
-- ============================================================

CREATE TYPE public.cycle_status AS ENUM ('upcoming', 'active', 'completed');

CREATE TABLE public.cycle (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id uuid NOT NULL REFERENCES public.team (id) ON DELETE CASCADE,
  name text,
  number integer NOT NULL DEFAULT 0,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status public.cycle_status NOT NULL DEFAULT 'upcoming',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CHECK (end_date > start_date)
);

CREATE INDEX cycle_team_idx ON public.cycle (team_id);
CREATE INDEX cycle_status_idx ON public.cycle (team_id, status);

-- Only one active cycle per team at a time
CREATE UNIQUE INDEX cycle_active_per_team_idx
  ON public.cycle (team_id)
  WHERE (status = 'active');

-- ============================================================
-- 2. Add cycle_id to actions
-- ============================================================

ALTER TABLE public.actions
  ADD COLUMN IF NOT EXISTS cycle_id uuid REFERENCES public.cycle (id) ON DELETE SET NULL;

CREATE INDEX actions_cycle_idx ON public.actions (cycle_id) WHERE cycle_id IS NOT NULL;

-- ============================================================
-- 3. Auto-generate cycle number and name
-- ============================================================

CREATE OR REPLACE FUNCTION public.generate_cycle_number()
RETURNS trigger AS $$
DECLARE
  next_number integer;
BEGIN
  SELECT coalesce(max(number), 0) + 1
  INTO next_number
  FROM public.cycle
  WHERE team_id = new.team_id;

  new.number := next_number;

  IF new.name IS NULL OR new.name = '' THEN
    new.name := 'Cycle ' || next_number;
  END IF;

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER cycle_generate_number
  BEFORE INSERT ON public.cycle
  FOR EACH ROW
  EXECUTE FUNCTION public.generate_cycle_number();

-- ============================================================
-- 4. updated_at trigger
-- ============================================================

CREATE TRIGGER cycle_updated_at
  BEFORE UPDATE ON public.cycle
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 5. RLS policies
-- ============================================================

ALTER TABLE public.cycle ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view cycles"
  ON public.cycle FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.team t
      WHERE t.id = cycle.team_id
        AND public.is_workspace_member(t.workspace_id)
    )
  );

CREATE POLICY "Team leads and admins can create cycles"
  ON public.cycle FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.team t
      WHERE t.id = cycle.team_id
        AND (
          public.get_member_role(t.workspace_id) IN ('owner', 'admin')
          OR EXISTS (
            SELECT 1 FROM public.team_member tm
            JOIN public.member m ON m.id = tm.member_id
            WHERE tm.team_id = t.id
              AND tm.team_role = 'lead'
              AND m.user_id = auth.uid()
          )
        )
    )
  );

CREATE POLICY "Team leads and admins can update cycles"
  ON public.cycle FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.team t
      WHERE t.id = cycle.team_id
        AND (
          public.get_member_role(t.workspace_id) IN ('owner', 'admin')
          OR EXISTS (
            SELECT 1 FROM public.team_member tm
            JOIN public.member m ON m.id = tm.member_id
            WHERE tm.team_id = t.id
              AND tm.team_role = 'lead'
              AND m.user_id = auth.uid()
          )
        )
    )
  );

CREATE POLICY "Team leads and admins can delete cycles"
  ON public.cycle FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.team t
      WHERE t.id = cycle.team_id
        AND (
          public.get_member_role(t.workspace_id) IN ('owner', 'admin')
          OR EXISTS (
            SELECT 1 FROM public.team_member tm
            JOIN public.member m ON m.id = tm.member_id
            WHERE tm.team_id = t.id
              AND tm.team_role = 'lead'
              AND m.user_id = auth.uid()
          )
        )
    )
  );

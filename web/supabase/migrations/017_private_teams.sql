-- Migration 017: Private teams
-- Depends on: 015_teams_team_members.sql (team table, is_team_member function)

-- Add is_private flag to teams (default false = public)
ALTER TABLE public.team ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;

-- Add missing DELETE policy (was absent from 015)
DROP POLICY IF EXISTS "Admins can delete teams" ON public.team;
CREATE POLICY "Admins can delete teams"
  ON public.team FOR DELETE
  USING (public.get_member_role(workspace_id) IN ('owner', 'admin'));

-- Auto-add team creator as lead (SECURITY DEFINER bypasses RLS chicken-and-egg)
CREATE OR REPLACE FUNCTION public.handle_new_team_creator()
RETURNS TRIGGER AS $$
DECLARE
  creator_member_id UUID;
BEGIN
  SELECT id INTO creator_member_id
  FROM public.member
  WHERE user_id = auth.uid()
    AND workspace_id = NEW.workspace_id
  LIMIT 1;

  IF creator_member_id IS NOT NULL THEN
    INSERT INTO public.team_member (team_id, member_id, team_role)
    VALUES (NEW.id, creator_member_id, 'lead')
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_team_created_add_creator ON public.team;
CREATE TRIGGER on_team_created_add_creator
  AFTER INSERT ON public.team
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_team_creator();

-- Helper: check workspace membership for a team_member row without touching team RLS
-- This breaks the circular dependency: team_member policy -> team RLS -> is_team_member -> team_member
CREATE OR REPLACE FUNCTION public.is_workspace_member_via_team(t_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team t
    JOIN public.member m ON m.workspace_id = t.workspace_id AND m.user_id = auth.uid()
    WHERE t.id = t_id
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Helper: check if current user is admin/owner OR team lead (without going through team RLS)
CREATE OR REPLACE FUNCTION public.can_manage_team_members(t_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team t
    JOIN public.member m ON m.workspace_id = t.workspace_id AND m.user_id = auth.uid()
    WHERE t.id = t_id
      AND (
        m.role IN ('owner', 'admin')
        OR EXISTS (
          SELECT 1 FROM public.team_member tm
          JOIN public.member m2 ON m2.id = tm.member_id
          WHERE tm.team_id = t_id
            AND tm.team_role = 'lead'
            AND m2.user_id = auth.uid()
        )
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Replace team_member SELECT policy to use SECURITY DEFINER helper (avoids recursion)
DROP POLICY IF EXISTS "Workspace members can view team members" ON public.team_member;
CREATE POLICY "Workspace members can view team members"
  ON public.team_member FOR SELECT
  USING (public.is_workspace_member_via_team(team_id));

-- Replace team_member FOR ALL policy (also had recursion via team RLS)
DROP POLICY IF EXISTS "Admins and leads can manage team members" ON public.team_member;
CREATE POLICY "Admins and leads can manage team members"
  ON public.team_member FOR ALL
  USING (public.can_manage_team_members(team_id));

-- Replace SELECT policy: workspace members see public teams + their own private teams
DROP POLICY IF EXISTS "Workspace members can view teams" ON public.team;
DROP POLICY IF EXISTS "Users can view accessible teams" ON public.team;
CREATE POLICY "Users can view accessible teams"
  ON public.team FOR SELECT
  USING (
    public.is_workspace_member(workspace_id)
    AND (
      NOT is_private
      OR public.is_team_member(id)
    )
  );

-- Migration 015: Teams & Team Membership
-- Depends on: 013_workspaces_members_invites.sql (workspace, member, helper functions)

-- ============================================================
-- 1. Tables
-- ============================================================

CREATE TABLE public.team (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  issue_prefix TEXT NOT NULL,
  issue_counter INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, slug),
  UNIQUE (workspace_id, issue_prefix)
);

CREATE INDEX team_workspace_idx ON public.team (workspace_id);

CREATE TABLE public.team_member (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id UUID NOT NULL REFERENCES public.team (id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES public.member (id) ON DELETE CASCADE,
  team_role TEXT NOT NULL DEFAULT 'member' CHECK (team_role IN ('lead', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (team_id, member_id)
);

CREATE INDEX team_member_team_idx ON public.team_member (team_id);
CREATE INDEX team_member_member_idx ON public.team_member (member_id);

-- ============================================================
-- 2. Helper Function
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_team_member(t_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_member tm
    JOIN public.member m ON m.id = tm.member_id
    WHERE tm.team_id = t_id
      AND m.user_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- 3. RLS Policies
-- ============================================================

ALTER TABLE public.team ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_member ENABLE ROW LEVEL SECURITY;

-- team: all workspace members can see all teams
CREATE POLICY "Workspace members can view teams"
  ON public.team FOR SELECT
  USING (public.is_workspace_member(workspace_id));

-- team: admins+ can create teams
CREATE POLICY "Admins can create teams"
  ON public.team FOR INSERT
  WITH CHECK (public.get_member_role(workspace_id) IN ('owner', 'admin'));

-- team: admins+ or team leads can update
CREATE POLICY "Admins and leads can update teams"
  ON public.team FOR UPDATE
  USING (
    public.get_member_role(workspace_id) IN ('owner', 'admin')
    OR EXISTS (
      SELECT 1 FROM public.team_member tm
      JOIN public.member m ON m.id = tm.member_id
      WHERE tm.team_id = team.id
        AND tm.team_role = 'lead'
        AND m.user_id = auth.uid()
    )
  );

-- team_member: workspace members can see team membership
CREATE POLICY "Workspace members can view team members"
  ON public.team_member FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.team t
      WHERE t.id = team_id
        AND public.is_workspace_member(t.workspace_id)
    )
  );

-- team_member: admins+ or team leads can manage team membership
CREATE POLICY "Admins and leads can manage team members"
  ON public.team_member FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.team t
      WHERE t.id = team_id
        AND (
          public.get_member_role(t.workspace_id) IN ('owner', 'admin')
          OR EXISTS (
            SELECT 1 FROM public.team_member tm2
            JOIN public.member m ON m.id = tm2.member_id
            WHERE tm2.team_id = team_id
              AND tm2.team_role = 'lead'
              AND m.user_id = auth.uid()
          )
        )
    )
  );

-- ============================================================
-- 4. Triggers
-- ============================================================

-- Auto-create default "General" team when workspace is created
CREATE OR REPLACE FUNCTION public.handle_new_workspace_team()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.team (workspace_id, name, slug, issue_prefix, color)
  VALUES (NEW.id, 'General', 'general', 'GEN', '#6366f1');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_workspace_created_create_team
  AFTER INSERT ON public.workspace
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_workspace_team();

-- Auto-add workspace owner to default team as lead
CREATE OR REPLACE FUNCTION public.handle_new_owner_team_membership()
RETURNS TRIGGER AS $$
DECLARE
  default_team_id UUID;
BEGIN
  IF NEW.role = 'owner' THEN
    SELECT id INTO default_team_id
    FROM public.team
    WHERE workspace_id = NEW.workspace_id
    ORDER BY created_at ASC
    LIMIT 1;

    IF default_team_id IS NOT NULL THEN
      INSERT INTO public.team_member (team_id, member_id, team_role)
      VALUES (default_team_id, NEW.id, 'lead')
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_member_created_add_to_default_team
  AFTER INSERT ON public.member
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_owner_team_membership();

-- updated_at trigger for team
CREATE TRIGGER team_updated_at
  BEFORE UPDATE ON public.team
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 5. Backfill: Create default team for existing workspaces
-- ============================================================

-- Create "General" team for any workspace that doesn't have one yet
INSERT INTO public.team (workspace_id, name, slug, issue_prefix, color)
SELECT w.id, 'General', 'general', 'GEN', '#6366f1'
FROM public.workspace w
WHERE NOT EXISTS (
  SELECT 1 FROM public.team t WHERE t.workspace_id = w.id
);

-- Add existing owners to their workspace's default team as lead
INSERT INTO public.team_member (team_id, member_id, team_role)
SELECT t.id, m.id, 'lead'
FROM public.member m
JOIN public.team t ON t.workspace_id = m.workspace_id
WHERE m.role = 'owner'
  AND t.slug = 'general'
  AND NOT EXISTS (
    SELECT 1 FROM public.team_member tm
    WHERE tm.team_id = t.id AND tm.member_id = m.id
  );

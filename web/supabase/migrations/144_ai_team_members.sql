-- Migration 144: AI Team Members
-- Depends on: 015_teams_team_members.sql (team, team_member, is_team_member,
--             get_member_role, is_workspace_member, update_updated_at)
--             025/079 (recipe table — agents & skills)
--
-- An "AI team member" is a first-class teammate that BUNDLES one agent recipe
-- with N skill recipes, and carries its OWN identity (name + avatar) distinct
-- from the reusable underlying agent. It sits on a team alongside human members
-- (public.team_member) but lives in its own table so the human-membership path
-- is left completely untouched.

-- ============================================================
-- 1. Tables
-- ============================================================

CREATE TABLE public.ai_team_member (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES public.team (id) ON DELETE CASCADE,
  -- Own identity (not the agent's). Lets two teams field the "same" agent under
  -- different teammate names/avatars.
  name TEXT NOT NULL,
  avatar_url TEXT,
  -- The base agent this teammate is built on (recipe.category = 'agent').
  -- RESTRICT: don't let an agent be deleted out from under a live teammate.
  agent_recipe_id UUID NOT NULL REFERENCES public.recipe (id) ON DELETE RESTRICT,
  team_role TEXT NOT NULL DEFAULT 'member' CHECK (team_role IN ('lead', 'member')),
  created_by UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ai_team_member_team_idx ON public.ai_team_member (team_id);
CREATE INDEX ai_team_member_workspace_idx ON public.ai_team_member (workspace_id);
CREATE INDEX ai_team_member_agent_idx ON public.ai_team_member (agent_recipe_id);

-- The skills this AI teammate can run (recipe.category = 'skill').
CREATE TABLE public.ai_team_member_skill (
  ai_team_member_id UUID NOT NULL REFERENCES public.ai_team_member (id) ON DELETE CASCADE,
  skill_recipe_id UUID NOT NULL REFERENCES public.recipe (id) ON DELETE CASCADE,
  sort_order REAL NOT NULL DEFAULT 0,

  PRIMARY KEY (ai_team_member_id, skill_recipe_id)
);

CREATE INDEX ai_team_member_skill_member_idx ON public.ai_team_member_skill (ai_team_member_id);

-- ============================================================
-- 2. RLS
-- ============================================================

ALTER TABLE public.ai_team_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_team_member_skill ENABLE ROW LEVEL SECURITY;

-- ai_team_member: workspace members can view (private teams gated like team_member
-- via is_team_member on the parent team).
CREATE POLICY "Workspace members can view AI team members"
  ON public.ai_team_member FOR SELECT
  USING (
    public.is_workspace_member(workspace_id)
    AND EXISTS (
      SELECT 1 FROM public.team t
      WHERE t.id = team_id
        AND (NOT t.is_private OR public.is_team_member(t.id))
    )
  );

-- ai_team_member: admins+ or team leads can manage (insert/update/delete).
-- Mirrors team_member's "Admins and leads can manage team members" policy.
CREATE POLICY "Admins and leads can manage AI team members"
  ON public.ai_team_member FOR ALL
  USING (
    public.get_member_role(workspace_id) IN ('owner', 'admin')
    OR EXISTS (
      SELECT 1 FROM public.team_member tm
      JOIN public.member m ON m.id = tm.member_id
      WHERE tm.team_id = ai_team_member.team_id
        AND tm.team_role = 'lead'
        AND m.user_id = auth.uid()
    )
  )
  WITH CHECK (
    public.get_member_role(workspace_id) IN ('owner', 'admin')
    OR EXISTS (
      SELECT 1 FROM public.team_member tm
      JOIN public.member m ON m.id = tm.member_id
      WHERE tm.team_id = ai_team_member.team_id
        AND tm.team_role = 'lead'
        AND m.user_id = auth.uid()
    )
  );

-- ai_team_member_skill: inherit access from the parent ai_team_member row.
CREATE POLICY "View AI team member skills via parent"
  ON public.ai_team_member_skill FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.ai_team_member atm
      WHERE atm.id = ai_team_member_id
        AND public.is_workspace_member(atm.workspace_id)
        AND EXISTS (
          SELECT 1 FROM public.team t
          WHERE t.id = atm.team_id
            AND (NOT t.is_private OR public.is_team_member(t.id))
        )
    )
  );

CREATE POLICY "Manage AI team member skills via parent"
  ON public.ai_team_member_skill FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.ai_team_member atm
      WHERE atm.id = ai_team_member_id
        AND (
          public.get_member_role(atm.workspace_id) IN ('owner', 'admin')
          OR EXISTS (
            SELECT 1 FROM public.team_member tm
            JOIN public.member m ON m.id = tm.member_id
            WHERE tm.team_id = atm.team_id
              AND tm.team_role = 'lead'
              AND m.user_id = auth.uid()
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.ai_team_member atm
      WHERE atm.id = ai_team_member_id
        AND (
          public.get_member_role(atm.workspace_id) IN ('owner', 'admin')
          OR EXISTS (
            SELECT 1 FROM public.team_member tm
            JOIN public.member m ON m.id = tm.member_id
            WHERE tm.team_id = atm.team_id
              AND tm.team_role = 'lead'
              AND m.user_id = auth.uid()
          )
        )
    )
  );

-- ============================================================
-- 3. Triggers
-- ============================================================

CREATE TRIGGER ai_team_member_updated_at
  BEFORE UPDATE ON public.ai_team_member
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

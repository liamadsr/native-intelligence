-- Migration 028: RLS Overhaul
-- Comprehensive audit and fix of all Row-Level Security policies.
-- Ensures workspace-aware access control on every user-facing table.
--
-- Tables that were MISSING RLS: actions, captures, capture_chunks, capture_references, projects
-- Tables with INCOMPLETE policies: workspace, member, invite, action_label, action_relation, comment
-- Tables already correct: team, team_member, workflow_state, label, cycle, recipe, document,
--   capture_participant, decision, milestone, initiative

-- ============================================================
-- 0. Helper functions — ensure they exist and are correct
-- ============================================================

-- is_workspace_member: already exists from 013, re-create for safety
CREATE OR REPLACE FUNCTION public.is_workspace_member(ws_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.member
    WHERE workspace_id = ws_id
      AND user_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- get_member_role: already exists from 013, re-create for safety
CREATE OR REPLACE FUNCTION public.get_member_role(ws_id UUID)
RETURNS TEXT AS $$
  SELECT role FROM public.member
  WHERE workspace_id = ws_id
    AND user_id = auth.uid()
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- is_team_member: already exists from 015
CREATE OR REPLACE FUNCTION public.is_team_member(t_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_member tm
    JOIN public.member m ON m.id = tm.member_id
    WHERE tm.team_id = t_id
      AND m.user_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- get_team_member_role: new helper for consistency
CREATE OR REPLACE FUNCTION public.get_team_member_role(t_id UUID)
RETURNS TEXT AS $$
  SELECT tm.team_role FROM public.team_member tm
  JOIN public.member m ON m.id = tm.member_id
  WHERE tm.team_id = t_id
    AND m.user_id = auth.uid()
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- 1. workspace — add missing DELETE policy
-- ============================================================

ALTER TABLE public.workspace ENABLE ROW LEVEL SECURITY;

-- Keep existing SELECT, INSERT, UPDATE policies (already correct)
-- Add missing DELETE
DROP POLICY IF EXISTS "workspace_delete" ON public.workspace;
CREATE POLICY "workspace_delete"
  ON public.workspace FOR DELETE
  USING (public.get_member_role(id) = 'owner');

-- ============================================================
-- 2. member — add admin management + delete
-- ============================================================

ALTER TABLE public.member ENABLE ROW LEVEL SECURITY;

-- SELECT is already correct (workspace members can see all)
-- UPDATE: allow admins to update any member (not just own profile)
DROP POLICY IF EXISTS "Users can update own member profile" ON public.member;
DROP POLICY IF EXISTS "member_update" ON public.member;
CREATE POLICY "member_update"
  ON public.member FOR UPDATE
  USING (
    user_id = auth.uid()
    OR public.get_member_role(workspace_id) IN ('owner', 'admin')
  );

-- INSERT: keep existing (users can create own member record for invite acceptance)
-- But also allow admins to add members
DROP POLICY IF EXISTS "Authenticated users can insert members" ON public.member;
DROP POLICY IF EXISTS "member_insert" ON public.member;
CREATE POLICY "member_insert"
  ON public.member FOR INSERT
  WITH CHECK (
    public.get_member_role(workspace_id) IN ('owner', 'admin')
    OR user_id = auth.uid()
  );

-- DELETE: only owners can remove members
DROP POLICY IF EXISTS "member_delete" ON public.member;
CREATE POLICY "member_delete"
  ON public.member FOR DELETE
  USING (public.get_member_role(workspace_id) = 'owner');

-- ============================================================
-- 3. invite — split FOR ALL into granular policies
-- ============================================================

ALTER TABLE public.invite ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage invites" ON public.invite;

DROP POLICY IF EXISTS "invite_select" ON public.invite;
CREATE POLICY "invite_select"
  ON public.invite FOR SELECT
  USING (public.get_member_role(workspace_id) IN ('owner', 'admin'));

DROP POLICY IF EXISTS "invite_insert" ON public.invite;
CREATE POLICY "invite_insert"
  ON public.invite FOR INSERT
  WITH CHECK (public.get_member_role(workspace_id) IN ('owner', 'admin'));

DROP POLICY IF EXISTS "invite_update" ON public.invite;
CREATE POLICY "invite_update"
  ON public.invite FOR UPDATE
  USING (public.get_member_role(workspace_id) IN ('owner', 'admin'));

DROP POLICY IF EXISTS "invite_delete" ON public.invite;
CREATE POLICY "invite_delete"
  ON public.invite FOR DELETE
  USING (public.get_member_role(workspace_id) IN ('owner', 'admin'));

-- ============================================================
-- 4. actions — ENABLE RLS + add workspace-aware policies (CRITICAL)
-- ============================================================

ALTER TABLE public.actions ENABLE ROW LEVEL SECURITY;

-- Drop any legacy user-scoped policies that may exist
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'actions'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.actions', pol.policyname);
  END LOOP;
END $$;

-- All workspace members can view all actions
CREATE POLICY "actions_select"
  ON public.actions FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.team t
    WHERE t.id = team_id AND public.is_workspace_member(t.workspace_id)
  ));

-- All workspace members can create actions
CREATE POLICY "actions_insert"
  ON public.actions FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.team t
    WHERE t.id = team_id AND public.is_workspace_member(t.workspace_id)
  ));

-- All workspace members can update actions
CREATE POLICY "actions_update"
  ON public.actions FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.team t
    WHERE t.id = team_id AND public.is_workspace_member(t.workspace_id)
  ));

-- Only admins+ can delete actions
CREATE POLICY "actions_delete"
  ON public.actions FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.team t
    WHERE t.id = team_id
      AND public.get_member_role(t.workspace_id) IN ('owner', 'admin')
  ));

-- ============================================================
-- 5. action_label — fix creator-only policy to workspace-aware
-- ============================================================

-- Drop old policies
DROP POLICY IF EXISTS "Action label access follows action access" ON public.action_label;
DROP POLICY IF EXISTS "Action owners can manage action labels" ON public.action_label;
DROP POLICY IF EXISTS "action_label_all" ON public.action_label;

CREATE POLICY "action_label_all"
  ON public.action_label FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.actions a
    JOIN public.team t ON t.id = a.team_id
    WHERE a.id = action_id AND public.is_workspace_member(t.workspace_id)
  ));

-- ============================================================
-- 6. action_relation — add missing UPDATE policy
-- ============================================================

-- Drop and recreate all for consistency
DROP POLICY IF EXISTS "Workspace members can view action relations" ON public.action_relation;
DROP POLICY IF EXISTS "Workspace members can insert action relations" ON public.action_relation;
DROP POLICY IF EXISTS "Workspace members can delete action relations" ON public.action_relation;
DROP POLICY IF EXISTS "action_relation_all" ON public.action_relation;

CREATE POLICY "action_relation_all"
  ON public.action_relation FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.actions a
    JOIN public.team t ON t.id = a.team_id
    WHERE a.id = action_id AND public.is_workspace_member(t.workspace_id)
  ));

-- ============================================================
-- 7. captures — ENABLE RLS + add workspace-aware policies (CRITICAL)
-- ============================================================

ALTER TABLE public.captures ENABLE ROW LEVEL SECURITY;

-- Drop any legacy user-scoped policies
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'captures'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.captures', pol.policyname);
  END LOOP;
END $$;

-- All workspace members can view captures
CREATE POLICY "captures_select"
  ON public.captures FOR SELECT
  USING (public.is_workspace_member(workspace_id));

-- All workspace members can create captures
CREATE POLICY "captures_insert"
  ON public.captures FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id));

-- All workspace members can update captures
CREATE POLICY "captures_update"
  ON public.captures FOR UPDATE
  USING (public.is_workspace_member(workspace_id));

-- Creator and admins can delete captures
CREATE POLICY "captures_delete"
  ON public.captures FOR DELETE
  USING (
    public.get_member_role(workspace_id) IN ('owner', 'admin')
    OR user_id = auth.uid()
  );

-- ============================================================
-- 8. capture_chunks — ENABLE RLS (was missing)
-- ============================================================

ALTER TABLE public.capture_chunks ENABLE ROW LEVEL SECURITY;

-- Drop any legacy policies
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'capture_chunks'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.capture_chunks', pol.policyname);
  END LOOP;
END $$;

-- Accessible via capture's workspace
CREATE POLICY "capture_chunks_select"
  ON public.capture_chunks FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.captures c
    WHERE c.id = capture_id AND public.is_workspace_member(c.workspace_id)
  ));

CREATE POLICY "capture_chunks_insert"
  ON public.capture_chunks FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.captures c
    WHERE c.id = capture_id AND public.is_workspace_member(c.workspace_id)
  ));

CREATE POLICY "capture_chunks_delete"
  ON public.capture_chunks FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.captures c
    WHERE c.id = capture_id AND public.is_workspace_member(c.workspace_id)
  ));

-- ============================================================
-- 9. capture_references — ENABLE RLS (was missing)
-- ============================================================

ALTER TABLE public.capture_references ENABLE ROW LEVEL SECURITY;

-- Drop any legacy policies
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'capture_references'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.capture_references', pol.policyname);
  END LOOP;
END $$;

-- Accessible via capture's workspace
CREATE POLICY "capture_references_all"
  ON public.capture_references FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.captures c
    WHERE c.id = capture_id AND public.is_workspace_member(c.workspace_id)
  ));

-- ============================================================
-- 10. projects — ENABLE RLS + add workspace-aware policies
-- ============================================================

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

-- Drop any legacy user-scoped policies
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'projects'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.projects', pol.policyname);
  END LOOP;
END $$;

-- All workspace members can view projects
CREATE POLICY "projects_select"
  ON public.projects FOR SELECT
  USING (public.is_workspace_member(workspace_id));

-- All workspace members can create projects
CREATE POLICY "projects_insert"
  ON public.projects FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id));

-- All workspace members can update projects
CREATE POLICY "projects_update"
  ON public.projects FOR UPDATE
  USING (public.is_workspace_member(workspace_id));

-- Only admins+ and project lead can delete
CREATE POLICY "projects_delete"
  ON public.projects FOR DELETE
  USING (
    public.get_member_role(workspace_id) IN ('owner', 'admin')
    OR lead_id = (
      SELECT id FROM public.member
      WHERE user_id = auth.uid() AND workspace_id = projects.workspace_id
      LIMIT 1
    )
  );

-- ============================================================
-- 11. comment — add admin delete capability
-- ============================================================

-- Replace delete policy: allow authors AND admins
DROP POLICY IF EXISTS "Authors can delete own comments" ON public.comment;
DROP POLICY IF EXISTS "comment_delete" ON public.comment;

CREATE POLICY "comment_delete"
  ON public.comment FOR DELETE
  USING (
    -- Author can delete own comments
    author_id IN (
      SELECT m.id FROM public.member m
      WHERE m.user_id = auth.uid()
    )
    -- Admins can delete any comment in their workspace
    OR (
      commentable_type = 'action' AND EXISTS (
        SELECT 1 FROM public.actions a
        JOIN public.team t ON t.id = a.team_id
        WHERE a.id = commentable_id
          AND public.get_member_role(t.workspace_id) IN ('owner', 'admin')
      )
    )
    OR (
      commentable_type = 'capture' AND EXISTS (
        SELECT 1 FROM public.captures c
        WHERE c.id = commentable_id
          AND public.get_member_role(c.workspace_id) IN ('owner', 'admin')
      )
    )
    OR (
      commentable_type = 'document' AND EXISTS (
        SELECT 1 FROM public.document d
        WHERE d.id = commentable_id
          AND public.get_member_role(d.workspace_id) IN ('owner', 'admin')
      )
    )
  );

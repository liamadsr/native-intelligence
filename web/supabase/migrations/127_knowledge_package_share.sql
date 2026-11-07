-- Migration 127: Individual + team grants on knowledge packages.
--
-- Visibility (personal/team/workspace) covers the broad audiences; this adds
-- the "share with Sarah specifically" grant the audit flagged as missing —
-- mirroring the proven contact_share pattern (migration 058): exactly one of
-- member/team per row, with view|edit access.
--
-- Shares ADD access on top of visibility (the SELECT policy ORs them in), and
-- an `edit` share also grants update rights.
--
-- RLS recursion note: knowledge_package's policies reference
-- knowledge_package_share, so share policies must NOT query knowledge_package
-- for SELECT (workspace membership suffices — who-can-see-a-package is not a
-- secret within the workspace). Only the share WRITE policies look at the
-- package, which terminates: package_select → share_select → member check.

CREATE TABLE IF NOT EXISTS public.knowledge_package_share (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL REFERENCES public.knowledge_package(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  shared_with_member_id UUID REFERENCES public.member(id) ON DELETE CASCADE,
  shared_with_team_id UUID REFERENCES public.team(id) ON DELETE CASCADE,
  access_level TEXT NOT NULL DEFAULT 'view' CHECK (access_level IN ('view', 'edit')),
  created_by UUID,                       -- auth.users id
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((shared_with_member_id IS NULL) <> (shared_with_team_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pkg_share_member
  ON public.knowledge_package_share (package_id, shared_with_member_id)
  WHERE shared_with_member_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pkg_share_team
  ON public.knowledge_package_share (package_id, shared_with_team_id)
  WHERE shared_with_team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pkg_share_package
  ON public.knowledge_package_share (package_id);

ALTER TABLE public.knowledge_package_share ENABLE ROW LEVEL SECURITY;

-- SELECT: any workspace member can see who a package is shared with. Must not
-- reference knowledge_package (recursion).
DROP POLICY IF EXISTS knowledge_package_share_select ON public.knowledge_package_share;
CREATE POLICY knowledge_package_share_select ON public.knowledge_package_share
  FOR SELECT USING (public.is_workspace_member(workspace_id));

-- Manage shares: the package's creator, or a workspace admin/owner.
DROP POLICY IF EXISTS knowledge_package_share_insert ON public.knowledge_package_share;
CREATE POLICY knowledge_package_share_insert ON public.knowledge_package_share
  FOR INSERT WITH CHECK (
    public.is_workspace_member(workspace_id)
    AND EXISTS (
      SELECT 1 FROM public.knowledge_package p
      WHERE p.id = package_id
        AND (
          p.created_by = auth.uid()
          OR public.get_member_role(p.workspace_id) IN ('admin', 'owner')
        )
    )
  );

DROP POLICY IF EXISTS knowledge_package_share_delete ON public.knowledge_package_share;
CREATE POLICY knowledge_package_share_delete ON public.knowledge_package_share
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.knowledge_package p
      WHERE p.id = package_id
        AND (
          p.created_by = auth.uid()
          OR public.get_member_role(p.workspace_id) IN ('admin', 'owner')
        )
    )
  );

-- ------------------------------------------------------------
-- Extend knowledge_package access with shares.
-- ------------------------------------------------------------

DROP POLICY IF EXISTS knowledge_package_select ON public.knowledge_package;
CREATE POLICY knowledge_package_select ON public.knowledge_package
  FOR SELECT USING (
    public.is_workspace_member(workspace_id)
    AND (
      (visibility = 'personal' AND created_by = auth.uid())
      OR (visibility = 'team' AND team_id IS NOT NULL AND public.is_team_member(team_id))
      OR (visibility = 'workspace')
      OR EXISTS (
        SELECT 1 FROM public.knowledge_package_share s
        JOIN public.member m ON m.id = s.shared_with_member_id
        WHERE s.package_id = knowledge_package.id AND m.user_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.knowledge_package_share s
        WHERE s.package_id = knowledge_package.id
          AND s.shared_with_team_id IS NOT NULL
          AND public.is_team_member(s.shared_with_team_id)
      )
    )
  );

-- An `edit` share also grants update rights.
DROP POLICY IF EXISTS knowledge_package_update ON public.knowledge_package;
CREATE POLICY knowledge_package_update ON public.knowledge_package
  FOR UPDATE USING (
    created_by = auth.uid()
    OR (visibility = 'workspace' AND public.get_member_role(workspace_id) IN ('admin', 'owner'))
    OR EXISTS (
      SELECT 1 FROM public.knowledge_package_share s
      JOIN public.member m ON m.id = s.shared_with_member_id
      WHERE s.package_id = knowledge_package.id
        AND m.user_id = auth.uid()
        AND s.access_level = 'edit'
    )
    OR EXISTS (
      SELECT 1 FROM public.knowledge_package_share s
      WHERE s.package_id = knowledge_package.id
        AND s.shared_with_team_id IS NOT NULL
        AND s.access_level = 'edit'
        AND public.is_team_member(s.shared_with_team_id)
    )
  );

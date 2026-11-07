-- ============================================================
-- 058: Contact Visibility & Sharing
-- Adds owner-scoped contacts with flexible sharing.
-- Existing contacts backfilled to 'workspace' (no breaking change).
-- ============================================================

-- ============================================================
-- 1. Add columns to contact
-- ============================================================

ALTER TABLE public.contact
  ADD COLUMN IF NOT EXISTS created_by_member_id UUID REFERENCES public.member(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'workspace'
    CHECK (visibility IN ('private', 'team', 'workspace'));

-- After backfill we'll change the default to 'private' for new contacts
-- For now, default 'workspace' ensures existing rows pass the NOT NULL constraint

CREATE INDEX IF NOT EXISTS contact_visibility_idx
  ON public.contact (workspace_id, visibility);

CREATE INDEX IF NOT EXISTS contact_created_by_idx
  ON public.contact (created_by_member_id)
  WHERE created_by_member_id IS NOT NULL;

-- ============================================================
-- 2. Backfill existing contacts
-- ============================================================

-- Set created_by_member_id to workspace owner for all existing contacts
UPDATE public.contact c
SET created_by_member_id = (
  SELECT m.id FROM public.member m
  WHERE m.workspace_id = c.workspace_id
    AND m.role = 'owner'
  LIMIT 1
)
WHERE c.created_by_member_id IS NULL;

-- All existing contacts stay 'workspace' (already the default)

-- Now change the default for NEW contacts to 'private'
ALTER TABLE public.contact ALTER COLUMN visibility SET DEFAULT 'private';

-- ============================================================
-- 3. Create contact_share table
-- ============================================================

CREATE TABLE public.contact_share (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID NOT NULL REFERENCES public.contact(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,

  -- Share target (exactly one must be set)
  shared_with_member_id UUID REFERENCES public.member(id) ON DELETE CASCADE,
  shared_with_team_id UUID REFERENCES public.team(id) ON DELETE CASCADE,

  -- Access level
  access_level TEXT NOT NULL DEFAULT 'view'
    CHECK (access_level IN ('view', 'edit')),

  -- Who shared it
  shared_by_member_id UUID NOT NULL REFERENCES public.member(id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Exactly one target
  CONSTRAINT contact_share_one_target CHECK (
    (shared_with_member_id IS NOT NULL AND shared_with_team_id IS NULL) OR
    (shared_with_member_id IS NULL AND shared_with_team_id IS NOT NULL)
  )
);

-- Partial unique indexes (only where the column is not null)
CREATE UNIQUE INDEX contact_share_member_unique_idx
  ON public.contact_share (contact_id, shared_with_member_id)
  WHERE shared_with_member_id IS NOT NULL;

CREATE UNIQUE INDEX contact_share_team_unique_idx
  ON public.contact_share (contact_id, shared_with_team_id)
  WHERE shared_with_team_id IS NOT NULL;

CREATE INDEX contact_share_contact_idx ON public.contact_share (contact_id);
CREATE INDEX contact_share_workspace_idx ON public.contact_share (workspace_id);
CREATE INDEX contact_share_member_idx ON public.contact_share (shared_with_member_id)
  WHERE shared_with_member_id IS NOT NULL;
CREATE INDEX contact_share_team_idx ON public.contact_share (shared_with_team_id)
  WHERE shared_with_team_id IS NOT NULL;

-- ============================================================
-- 4. RLS helper: can_view_contact
-- ============================================================

CREATE OR REPLACE FUNCTION public.can_view_contact(
  p_contact_id UUID,
  p_workspace_id UUID,
  p_visibility TEXT,
  p_created_by_member_id UUID
)
RETURNS BOOLEAN AS $$
DECLARE
  v_user_id UUID;
  v_member_id UUID;
  v_role TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Must be a workspace member
  IF NOT public.is_workspace_member(p_workspace_id) THEN
    RETURN FALSE;
  END IF;

  -- Workspace-wide contacts: everyone sees them
  IF p_visibility = 'workspace' THEN
    RETURN TRUE;
  END IF;

  -- Resolve current user's member_id in this workspace
  SELECT m.id, m.role INTO v_member_id, v_role
  FROM public.member m
  WHERE m.user_id = v_user_id
    AND m.workspace_id = p_workspace_id
  LIMIT 1;

  -- Owner always sees their own contacts
  IF v_member_id = p_created_by_member_id THEN
    RETURN TRUE;
  END IF;

  -- Workspace owner/admin can see all contacts
  IF v_role IN ('owner', 'admin') THEN
    RETURN TRUE;
  END IF;

  -- Team visibility: user shares a team with the contact creator
  IF p_visibility = 'team' AND p_created_by_member_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.team_member tm1
      JOIN public.team_member tm2 ON tm2.team_id = tm1.team_id
      WHERE tm1.member_id = v_member_id
        AND tm2.member_id = p_created_by_member_id
    ) THEN
      RETURN TRUE;
    END IF;
  END IF;

  -- Explicit share to this member
  IF EXISTS (
    SELECT 1 FROM public.contact_share cs
    WHERE cs.contact_id = p_contact_id
      AND cs.shared_with_member_id = v_member_id
  ) THEN
    RETURN TRUE;
  END IF;

  -- Explicit share to a team this member is in
  IF EXISTS (
    SELECT 1 FROM public.contact_share cs
    JOIN public.team_member tm ON tm.team_id = cs.shared_with_team_id
    WHERE cs.contact_id = p_contact_id
      AND tm.member_id = v_member_id
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Helper for edit access check
CREATE OR REPLACE FUNCTION public.can_edit_contact(
  p_contact_id UUID,
  p_workspace_id UUID,
  p_visibility TEXT,
  p_created_by_member_id UUID
)
RETURNS BOOLEAN AS $$
DECLARE
  v_user_id UUID;
  v_member_id UUID;
  v_role TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF NOT public.is_workspace_member(p_workspace_id) THEN
    RETURN FALSE;
  END IF;

  -- Resolve member
  SELECT m.id, m.role INTO v_member_id, v_role
  FROM public.member m
  WHERE m.user_id = v_user_id
    AND m.workspace_id = p_workspace_id
  LIMIT 1;

  -- Creator has full access
  IF v_member_id = p_created_by_member_id THEN
    RETURN TRUE;
  END IF;

  -- Admins have full access
  IF v_role IN ('owner', 'admin') THEN
    RETURN TRUE;
  END IF;

  -- Workspace-visible: any member can edit
  IF p_visibility = 'workspace' THEN
    RETURN TRUE;
  END IF;

  -- Explicit edit share to this member
  IF EXISTS (
    SELECT 1 FROM public.contact_share cs
    WHERE cs.contact_id = p_contact_id
      AND cs.shared_with_member_id = v_member_id
      AND cs.access_level = 'edit'
  ) THEN
    RETURN TRUE;
  END IF;

  -- Explicit edit share to a team this member is in
  IF EXISTS (
    SELECT 1 FROM public.contact_share cs
    JOIN public.team_member tm ON tm.team_id = cs.shared_with_team_id
    WHERE cs.contact_id = p_contact_id
      AND tm.member_id = v_member_id
      AND cs.access_level = 'edit'
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ============================================================
-- 5. Replace RLS policies on contact
-- ============================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Workspace members can view contacts" ON public.contact;
DROP POLICY IF EXISTS "Workspace members can manage contacts" ON public.contact;

-- SELECT: visibility-aware
CREATE POLICY "contact_select_visibility"
  ON public.contact FOR SELECT
  USING (
    public.can_view_contact(id, workspace_id, visibility, created_by_member_id)
  );

-- INSERT: any workspace member can create contacts
CREATE POLICY "contact_insert"
  ON public.contact FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id));

-- UPDATE: creator, admin, workspace-visible, or explicit edit share
CREATE POLICY "contact_update"
  ON public.contact FOR UPDATE
  USING (
    public.can_edit_contact(id, workspace_id, visibility, created_by_member_id)
  );

-- DELETE: only creator or admin
CREATE POLICY "contact_delete"
  ON public.contact FOR DELETE
  USING (
    public.is_workspace_member(workspace_id)
    AND (
      -- Creator
      EXISTS (
        SELECT 1 FROM public.member m
        WHERE m.id = created_by_member_id
          AND m.user_id = auth.uid()
      )
      -- Admin/owner
      OR public.get_member_role(workspace_id) IN ('owner', 'admin')
    )
  );

-- ============================================================
-- 6. RLS for contact_share
-- ============================================================

ALTER TABLE public.contact_share ENABLE ROW LEVEL SECURITY;

-- Anyone who can view the contact can view its shares
CREATE POLICY "contact_share_select"
  ON public.contact_share FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.contact c
      WHERE c.id = contact_id
        AND public.can_view_contact(c.id, c.workspace_id, c.visibility, c.created_by_member_id)
    )
  );

-- Creator or admin can manage shares
CREATE POLICY "contact_share_insert"
  ON public.contact_share FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.contact c
      WHERE c.id = contact_id
        AND (
          -- Creator
          EXISTS (
            SELECT 1 FROM public.member m
            WHERE m.id = c.created_by_member_id
              AND m.user_id = auth.uid()
          )
          -- Admin/owner
          OR public.get_member_role(c.workspace_id) IN ('owner', 'admin')
        )
    )
  );

CREATE POLICY "contact_share_delete"
  ON public.contact_share FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.contact c
      WHERE c.id = contact_id
        AND (
          EXISTS (
            SELECT 1 FROM public.member m
            WHERE m.id = c.created_by_member_id
              AND m.user_id = auth.uid()
          )
          OR public.get_member_role(c.workspace_id) IN ('owner', 'admin')
        )
    )
  );

-- ============================================================
-- 7. Update contact_interaction RLS to follow contact visibility
-- ============================================================

DROP POLICY IF EXISTS "Workspace members can view interactions" ON public.contact_interaction;
DROP POLICY IF EXISTS "Workspace members can manage interactions" ON public.contact_interaction;

CREATE POLICY "interaction_select_via_contact"
  ON public.contact_interaction FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.contact c
      WHERE c.id = contact_id
        AND public.can_view_contact(c.id, c.workspace_id, c.visibility, c.created_by_member_id)
    )
  );

CREATE POLICY "interaction_manage_via_contact"
  ON public.contact_interaction FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.contact c
      WHERE c.id = contact_id
        AND public.can_edit_contact(c.id, c.workspace_id, c.visibility, c.created_by_member_id)
    )
  );

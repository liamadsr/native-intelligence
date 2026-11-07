-- Migration 191: recipe INSERT/UPDATE/DELETE — creator-owns-their-work authoring.
--
-- WHY (the RLS trap this fixes): the Agents & Skills page tells every workspace
-- member they can create and manage their own agents/skills, but migration 025's
-- write policies gated ALL of it on `get_member_role(workspace_id) IN
-- ('owner','admin')`. Consequence: a regular member could not CREATE a recipe at
-- all, and — because there was NO `created_by` exception — could not UPDATE or
-- DELETE a "personal" recipe they authored either. The page was lying to them:
-- items appear (the SELECT policy in mig 079 lets a member read their own
-- `personal` rows and all `workspace` rows) but are unmanageable. Route handlers
-- rely on RLS alone, so the row simply refused every write.
--
-- The fix mirrors the `view` table's creator exception (mig 039): the creator
-- owns their work, and workspace owners/admins manage everything. `created_by`
-- references `auth.users(id)` (mig 079) so it compares directly to `auth.uid()`.
--
--   INSERT — any workspace member may create their own non-system rows.
--   UPDATE/DELETE — the creator, OR an owner/admin, may manage the row; and the
--     row may not be flipped to a system recipe or moved to another workspace.
--
-- System recipes (is_system = true) remain untouched here: they are seeded, never
-- authored through these policies, and the `is_system = false` guard keeps this
-- surface from ever creating or mutating one.
--
-- Idempotent: drops each policy BY NAME before recreating. Safe to re-run.

-- ── INSERT ────────────────────────────────────────────────────────────────────
-- Any workspace member may author a non-system recipe, stamped as their own.
DROP POLICY IF EXISTS "Admins can create workspace recipes" ON public.recipe;
DROP POLICY IF EXISTS "Members can create workspace recipes" ON public.recipe;
CREATE POLICY "Members can create workspace recipes"
  ON public.recipe FOR INSERT
  WITH CHECK (
    is_system = false
    AND public.is_workspace_member(workspace_id)
    AND created_by = auth.uid()
  );

-- ── UPDATE ────────────────────────────────────────────────────────────────────
-- The creator manages their own work; owners/admins manage all. USING gates which
-- rows are visible to the update; WITH CHECK pins the post-image so a member can
-- neither promote a row to a system recipe nor smuggle it into another workspace.
DROP POLICY IF EXISTS "Admins can update workspace recipes" ON public.recipe;
DROP POLICY IF EXISTS "Members can update their own or admins all recipes" ON public.recipe;
CREATE POLICY "Members can update their own or admins all recipes"
  ON public.recipe FOR UPDATE
  USING (
    is_system = false
    AND public.is_workspace_member(workspace_id)
    AND (
      created_by = auth.uid()
      OR public.get_member_role(workspace_id) IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    is_system = false
    AND public.is_workspace_member(workspace_id)
    AND (
      created_by = auth.uid()
      OR public.get_member_role(workspace_id) IN ('owner', 'admin')
    )
    -- Pin workspace_id to the PRE-image so an UPDATE can never relocate a row
    -- across workspaces. A creator who belongs to two workspaces would otherwise
    -- pass every clause above for BOTH the old and a new workspace_id; without
    -- this, they could move their row into another workspace they're in. A policy
    -- subquery reads the statement-start snapshot (the pre-image), so this
    -- compares the NEW workspace_id against the row's ORIGINAL workspace_id.
    AND workspace_id = (SELECT r.workspace_id FROM public.recipe r WHERE r.id = recipe.id)
  );

-- ── DELETE ────────────────────────────────────────────────────────────────────
-- Same predicate as UPDATE: the creator, or an owner/admin, may remove the row.
DROP POLICY IF EXISTS "Admins can delete workspace recipes" ON public.recipe;
DROP POLICY IF EXISTS "Members can delete their own or admins all recipes" ON public.recipe;
CREATE POLICY "Members can delete their own or admins all recipes"
  ON public.recipe FOR DELETE
  USING (
    is_system = false
    AND public.is_workspace_member(workspace_id)
    AND (
      created_by = auth.uid()
      OR public.get_member_role(workspace_id) IN ('owner', 'admin')
    )
  );

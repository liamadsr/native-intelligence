-- Migration 055: Update trigger + RLS policies for project comments
-- Runs after 054 commits the new 'project' enum value.

-- ============================================================
-- 1. Update the polymorphic FK validation trigger
-- ============================================================

CREATE OR REPLACE FUNCTION public.validate_commentable_exists()
RETURNS trigger AS $$
BEGIN
  IF new.commentable_type = 'action' THEN
    IF NOT EXISTS (SELECT 1 FROM public.actions WHERE id = new.commentable_id) THEN
      RAISE EXCEPTION 'Referenced action does not exist';
    END IF;
  ELSIF new.commentable_type = 'capture' THEN
    IF NOT EXISTS (SELECT 1 FROM public.captures WHERE id = new.commentable_id) THEN
      RAISE EXCEPTION 'Referenced capture does not exist';
    END IF;
  ELSIF new.commentable_type = 'document' THEN
    IF NOT EXISTS (SELECT 1 FROM public.document WHERE id = new.commentable_id) THEN
      RAISE EXCEPTION 'Referenced document does not exist';
    END IF;
  ELSIF new.commentable_type = 'project' THEN
    IF NOT EXISTS (SELECT 1 FROM public.projects WHERE id = new.commentable_id) THEN
      RAISE EXCEPTION 'Referenced project does not exist';
    END IF;
  END IF;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 2. Update RLS policies to include project
-- ============================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Workspace members can view comments" ON public.comment;
DROP POLICY IF EXISTS "Workspace members can create comments" ON public.comment;

-- Recreate SELECT policy with project support
CREATE POLICY "Workspace members can view comments"
  ON public.comment FOR SELECT
  USING (
    CASE commentable_type
      WHEN 'action' THEN EXISTS (
        SELECT 1 FROM public.actions a
        JOIN public.team t ON t.id = a.team_id
        WHERE a.id = commentable_id
          AND public.is_workspace_member(t.workspace_id)
      )
      WHEN 'capture' THEN EXISTS (
        SELECT 1 FROM public.captures c
        WHERE c.id = commentable_id
          AND public.is_workspace_member(c.workspace_id)
      )
      WHEN 'document' THEN EXISTS (
        SELECT 1 FROM public.document d
        WHERE d.id = commentable_id
          AND public.is_workspace_member(d.workspace_id)
      )
      WHEN 'project' THEN EXISTS (
        SELECT 1 FROM public.projects p
        WHERE p.id = commentable_id
          AND public.is_workspace_member(p.workspace_id)
      )
    END
  );

-- Recreate INSERT policy with project support
CREATE POLICY "Workspace members can create comments"
  ON public.comment FOR INSERT
  WITH CHECK (
    CASE commentable_type
      WHEN 'action' THEN EXISTS (
        SELECT 1 FROM public.actions a
        JOIN public.team t ON t.id = a.team_id
        WHERE a.id = commentable_id
          AND public.is_workspace_member(t.workspace_id)
      )
      WHEN 'capture' THEN EXISTS (
        SELECT 1 FROM public.captures c
        WHERE c.id = commentable_id
          AND public.is_workspace_member(c.workspace_id)
      )
      WHEN 'document' THEN EXISTS (
        SELECT 1 FROM public.document d
        WHERE d.id = commentable_id
          AND public.is_workspace_member(d.workspace_id)
      )
      WHEN 'project' THEN EXISTS (
        SELECT 1 FROM public.projects p
        WHERE p.id = commentable_id
          AND public.is_workspace_member(p.workspace_id)
      )
    END
  );

-- Migration 026: Threaded Comments
-- Polymorphic comments that can attach to actions, captures, or documents.
-- Supports threaded replies via parent_id.

-- ============================================================
-- 1. Comment table
-- ============================================================

CREATE TYPE public.commentable_type AS ENUM ('action', 'capture', 'document');

CREATE TABLE public.comment (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  body text NOT NULL,
  author_id uuid NOT NULL REFERENCES public.member (id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.comment (id) ON DELETE CASCADE,
  commentable_type public.commentable_type NOT NULL,
  commentable_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz
);

CREATE INDEX comment_target_idx ON public.comment (commentable_type, commentable_id);
CREATE INDEX comment_author_idx ON public.comment (author_id);
CREATE INDEX comment_parent_idx ON public.comment (parent_id) WHERE parent_id IS NOT NULL;

-- ============================================================
-- 2. Polymorphic FK validation
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
  END IF;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER comment_validate_target
  BEFORE INSERT OR UPDATE ON public.comment
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_commentable_exists();

-- ============================================================
-- 3. Set edited_at on body update
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_comment_edited_at()
RETURNS trigger AS $$
BEGIN
  IF new.body IS DISTINCT FROM old.body THEN
    new.edited_at := now();
  END IF;
  RETURN new;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER comment_set_edited_at
  BEFORE UPDATE ON public.comment
  FOR EACH ROW
  EXECUTE FUNCTION public.set_comment_edited_at();

-- ============================================================
-- 4. RLS policies
-- ============================================================

ALTER TABLE public.comment ENABLE ROW LEVEL SECURITY;

-- View: workspace members can see comments on entities they can access
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
    END
  );

-- Insert: workspace members can create comments on entities they can see
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
    END
  );

-- Update: authors can edit their own comments
CREATE POLICY "Authors can update own comments"
  ON public.comment FOR UPDATE
  USING (
    author_id IN (
      SELECT m.id FROM public.member m
      WHERE m.user_id = auth.uid()
    )
  );

-- Delete: authors can delete their own comments
CREATE POLICY "Authors can delete own comments"
  ON public.comment FOR DELETE
  USING (
    author_id IN (
      SELECT m.id FROM public.member m
      WHERE m.user_id = auth.uid()
    )
  );

-- ============================================================
-- 5. Enable Realtime (for future use)
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE public.comment;

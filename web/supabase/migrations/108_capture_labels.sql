-- Migration 108: Capture Labels
--
-- Allows users to attach workspace-scoped labels/tags to captures for
-- better organisation and filtering. Follows the same pattern as
-- action_label (migration 020).

-- ──────────────────────────────────────────────────────────────────
-- 1. capture_label join table
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE public.capture_label (
  capture_id UUID NOT NULL REFERENCES public.captures (id) ON DELETE CASCADE,
  label_id   UUID NOT NULL REFERENCES public.label    (id) ON DELETE CASCADE,
  PRIMARY KEY (capture_id, label_id)
);

CREATE INDEX idx_capture_label_label ON public.capture_label (label_id);

-- ──────────────────────────────────────────────────────────────────
-- 2. Add 'capture' to the label.scopes comment (documentation only)
-- ──────────────────────────────────────────────────────────────────
COMMENT ON COLUMN public.label.scopes IS
  'Entity types where this label appears. NULL = visible everywhere. Values: action, email_thread, project, initiative, capture.';

-- ──────────────────────────────────────────────────────────────────
-- 3. RLS policies for capture_label
-- ──────────────────────────────────────────────────────────────────
ALTER TABLE public.capture_label ENABLE ROW LEVEL SECURITY;

-- Workspace members can view labels on any capture in their workspace
CREATE POLICY "Workspace members can view capture labels"
  ON public.capture_label FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.captures c
      WHERE c.id = capture_label.capture_id
        AND public.is_workspace_member(c.workspace_id)
    )
  );

-- Any workspace member can manage labels on workspace captures
-- (captures are workspace-shared for metadata edits, same rule as
--  the PATCH handler in captures/[id]/route.ts).
CREATE POLICY "Workspace members can manage capture labels"
  ON public.capture_label FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.captures c
      WHERE c.id = capture_label.capture_id
        AND public.is_workspace_member(c.workspace_id)
    )
  );

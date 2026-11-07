-- Add inline comment anchor columns to the `comment` table (authenticated app).
-- Comments with anchor_text IS NULL remain general thread comments (backward compatible).
-- Comments with anchor_text are inline highlights attached to content text.

ALTER TABLE public.comment
  ADD COLUMN IF NOT EXISTS anchor_text text,
  ADD COLUMN IF NOT EXISTS anchor_prefix text,
  ADD COLUMN IF NOT EXISTS anchor_suffix text,
  ADD COLUMN IF NOT EXISTS anchor_section text,
  ADD COLUMN IF NOT EXISTS anchor_occurrence int,
  ADD COLUMN IF NOT EXISTS is_resolved boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS comment_inline_idx
  ON public.comment (commentable_id) WHERE anchor_text IS NOT NULL;

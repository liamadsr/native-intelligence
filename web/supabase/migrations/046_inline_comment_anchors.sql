-- Migration 046: Inline comment anchors
-- Adds text-anchoring data to share_comment for Google Docs-style inline commenting.
-- Comments with anchor_text IS NULL remain general bottom-of-page comments (backward compatible).
-- Comments with anchor_text IS NOT NULL are inline comments anchored to specific text.

ALTER TABLE public.share_comment
  ADD COLUMN anchor_text text,           -- The selected/highlighted text
  ADD COLUMN anchor_prefix text,         -- ~50 chars before selection for disambiguation
  ADD COLUMN anchor_suffix text,         -- ~50 chars after selection for disambiguation
  ADD COLUMN anchor_section text,        -- 'notes' | 'summary' | 'transcript' | 'decisions' | 'document'
  ADD COLUMN anchor_occurrence int,      -- Nth occurrence of text (0-indexed) if text repeats
  ADD COLUMN is_resolved boolean NOT NULL DEFAULT false;

-- Index for quickly finding inline comments per share
CREATE INDEX share_comment_inline_idx
  ON public.share_comment (share_id)
  WHERE anchor_text IS NOT NULL;

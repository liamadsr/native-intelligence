-- Add note_attributions column to captures for tracking which AI-enhanced
-- sections were derived from the user's original notes.
ALTER TABLE public.captures
  ADD COLUMN IF NOT EXISTS note_attributions jsonb;

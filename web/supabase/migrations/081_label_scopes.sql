-- Migration 081: Label Scopes
--
-- Adds a `scopes` column to the label table so labels can be restricted
-- to specific entity types (action, email_thread, project, initiative).
-- NULL means the label is visible everywhere (universal).

ALTER TABLE public.label
  ADD COLUMN scopes TEXT[] DEFAULT NULL;

-- GIN index for fast array-containment queries (@> operator)
CREATE INDEX idx_label_scopes ON public.label USING GIN (scopes);

COMMENT ON COLUMN public.label.scopes IS
  'Entity types where this label appears. NULL = visible everywhere. Values: action, email_thread, project, initiative.';

-- Allow attachments to be linked to an action without requiring a note/capture.
-- Previously note_id was NOT NULL, which prevented attaching files directly to actions.
-- Now either note_id or action_id (or both) can be set.

ALTER TABLE attachments ALTER COLUMN note_id DROP NOT NULL;

-- Add a check constraint to ensure at least one parent is set
ALTER TABLE attachments ADD CONSTRAINT attachments_has_parent
  CHECK (note_id IS NOT NULL OR action_id IS NOT NULL);

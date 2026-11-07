-- Add created_by column to message_campaigns
-- Tracks which admin created the campaign
-- Safe to re-run: uses IF NOT EXISTS

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'message_campaigns' AND column_name = 'created_by'
  ) THEN
    ALTER TABLE message_campaigns ADD COLUMN created_by TEXT;
  END IF;
END $$;

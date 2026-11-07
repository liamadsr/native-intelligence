-- Add feedback_type to message_responses
-- Allows categorizing user feedback as: feature_request, general_feedback, bug_report
-- Safe to re-run: uses IF NOT EXISTS

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'message_responses' AND column_name = 'feedback_type'
  ) THEN
    ALTER TABLE message_responses ADD COLUMN feedback_type TEXT DEFAULT 'general_feedback';
  END IF;
END $$;

-- Drop the tags column from actions (replaced by the labels system)
ALTER TABLE actions DROP COLUMN IF EXISTS tags;

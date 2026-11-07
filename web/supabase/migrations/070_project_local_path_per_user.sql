-- Move local_path from projects table to a per-user table
-- Each developer can have their own local path for the same project
ALTER TABLE projects DROP COLUMN IF EXISTS local_path;

CREATE TABLE IF NOT EXISTS project_local_path (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  local_path text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(project_id, user_id)
);

ALTER TABLE project_local_path ENABLE ROW LEVEL SECURITY;

-- Users can only see and manage their own local paths
CREATE POLICY "Users manage own local paths"
  ON project_local_path FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

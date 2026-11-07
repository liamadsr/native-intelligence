-- ============================================================
-- Migration 014: Workspace-scope all content tables
-- Adds workspace_id to user-data tables, backfills from member,
-- updates rag_search to filter by workspace.
-- ============================================================

-- ============================================================
-- ADD COLUMNS (nullable first, backfill, then set NOT NULL)
-- ============================================================

-- Core content
ALTER TABLE notes ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE note_chunks ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE note_references ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspace(id) ON DELETE CASCADE;

-- Tasks
ALTER TABLE actions ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE action_lists ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspace(id) ON DELETE CASCADE;

-- Contacts
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE contact_groups ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspace(id) ON DELETE CASCADE;

-- Goals
ALTER TABLE goals ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspace(id) ON DELETE CASCADE;

-- Chat
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspace(id) ON DELETE CASCADE;

-- ============================================================
-- BACKFILL: Assign existing rows to the user's first workspace
-- ============================================================

-- Helper: get user's first workspace (earliest membership)
CREATE OR REPLACE FUNCTION _first_workspace(uid UUID) RETURNS UUID AS $$
  SELECT m.workspace_id FROM member m
  WHERE m.user_id = uid
  ORDER BY m.created_at ASC
  LIMIT 1;
$$ LANGUAGE sql STABLE;

-- Backfill each table
UPDATE notes SET workspace_id = _first_workspace(user_id) WHERE workspace_id IS NULL;
UPDATE projects SET workspace_id = _first_workspace(user_id) WHERE workspace_id IS NULL;
UPDATE note_chunks SET workspace_id = _first_workspace(user_id) WHERE workspace_id IS NULL;
UPDATE attachments SET workspace_id = _first_workspace(user_id) WHERE workspace_id IS NULL;
UPDATE note_references SET workspace_id = _first_workspace(user_id) WHERE workspace_id IS NULL;
UPDATE actions SET workspace_id = _first_workspace(user_id) WHERE workspace_id IS NULL;
UPDATE action_lists SET workspace_id = _first_workspace(user_id) WHERE workspace_id IS NULL;
UPDATE contacts SET workspace_id = _first_workspace(user_id) WHERE workspace_id IS NULL;
UPDATE contact_groups SET workspace_id = _first_workspace(user_id) WHERE workspace_id IS NULL;
UPDATE goals SET workspace_id = _first_workspace(user_id) WHERE workspace_id IS NULL;
UPDATE milestones SET workspace_id = _first_workspace(user_id) WHERE workspace_id IS NULL;
UPDATE chat_conversations SET workspace_id = _first_workspace(user_id) WHERE workspace_id IS NULL;
UPDATE chat_messages SET workspace_id = _first_workspace(user_id) WHERE workspace_id IS NULL;

-- Drop helper function
DROP FUNCTION IF EXISTS _first_workspace(UUID);

-- ============================================================
-- SET NOT NULL (after backfill)
-- ============================================================

-- Only set NOT NULL on tables where user_id is always present.
-- goals and milestones have nullable user_id (device-based rows),
-- so we skip NOT NULL for those.
ALTER TABLE notes ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE projects ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE note_chunks ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE attachments ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE note_references ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE actions ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE action_lists ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE contacts ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE contact_groups ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE chat_conversations ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE chat_messages ALTER COLUMN workspace_id SET NOT NULL;
-- goals: NOT NULL only where user_id is present
-- milestones: NOT NULL only where user_id is present

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_notes_workspace ON notes (workspace_id);
CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects (workspace_id);
CREATE INDEX IF NOT EXISTS idx_note_chunks_workspace ON note_chunks (workspace_id);
CREATE INDEX IF NOT EXISTS idx_attachments_workspace ON attachments (workspace_id);
CREATE INDEX IF NOT EXISTS idx_note_references_workspace ON note_references (workspace_id);
CREATE INDEX IF NOT EXISTS idx_actions_workspace ON actions (workspace_id);
CREATE INDEX IF NOT EXISTS idx_action_lists_workspace ON action_lists (workspace_id);
CREATE INDEX IF NOT EXISTS idx_contacts_workspace ON contacts (workspace_id);
CREATE INDEX IF NOT EXISTS idx_contact_groups_workspace ON contact_groups (workspace_id);
CREATE INDEX IF NOT EXISTS idx_goals_workspace ON goals (workspace_id);
CREATE INDEX IF NOT EXISTS idx_milestones_workspace ON milestones (workspace_id);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_workspace ON chat_conversations (workspace_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_workspace ON chat_messages (workspace_id);

-- Composite indexes for common query patterns (user + workspace)
CREATE INDEX IF NOT EXISTS idx_notes_user_workspace ON notes (user_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_actions_user_workspace ON actions (user_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_projects_user_workspace ON projects (user_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_contacts_user_workspace ON contacts (user_id, workspace_id);

-- ============================================================
-- UPDATE rag_search to support workspace filtering
-- ============================================================

CREATE OR REPLACE FUNCTION rag_search(
    p_user_id TEXT,
    p_project_ids TEXT[],
    p_note_ids TEXT[],
    p_embedding TEXT,
    p_limit INTEGER DEFAULT 10,
    p_threshold FLOAT DEFAULT 0.0,
    p_workspace_id TEXT DEFAULT NULL
)
RETURNS TABLE (
    chunk_id UUID,
    note_id UUID,
    project_id UUID,
    chunk_text TEXT,
    chunk_index INTEGER,
    note_title TEXT,
    note_type note_type,
    similarity FLOAT
) AS $$
DECLARE
    v_user_id UUID := p_user_id::UUID;
    v_embedding vector(1536) := p_embedding::vector(1536);
    v_has_project_filter BOOLEAN := COALESCE(array_length(p_project_ids, 1), 0) > 0;
    v_has_note_filter BOOLEAN := COALESCE(array_length(p_note_ids, 1), 0) > 0;
    v_workspace_id UUID := CASE WHEN p_workspace_id IS NOT NULL THEN p_workspace_id::UUID ELSE NULL END;
    v_project_ids UUID[];
    v_note_ids UUID[];
BEGIN
    IF v_has_project_filter THEN
        v_project_ids := ARRAY(SELECT unnest(p_project_ids)::UUID);
    ELSE
        v_project_ids := NULL;
    END IF;

    IF v_has_note_filter THEN
        v_note_ids := ARRAY(SELECT unnest(p_note_ids)::UUID);
    ELSE
        v_note_ids := NULL;
    END IF;

    RETURN QUERY
    SELECT
        nc.id as chunk_id,
        nc.note_id,
        nc.project_id,
        nc.chunk_text,
        nc.chunk_index,
        n.title as note_title,
        n.type as note_type,
        1 - (nc.embedding <=> v_embedding) as similarity
    FROM note_chunks nc
    JOIN notes n ON n.id = nc.note_id
    WHERE nc.user_id = v_user_id
      AND nc.embedding IS NOT NULL
      AND 1 - (nc.embedding <=> v_embedding) >= p_threshold
      AND (v_workspace_id IS NULL OR nc.workspace_id = v_workspace_id)
      AND (
          (NOT v_has_project_filter AND NOT v_has_note_filter)
          OR (v_has_project_filter AND nc.project_id = ANY(v_project_ids))
          OR (v_has_note_filter AND nc.note_id = ANY(v_note_ids))
      )
    ORDER BY nc.embedding <=> v_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Re-grant permissions (function signature changed due to new parameter)
GRANT EXECUTE ON FUNCTION rag_search(TEXT, TEXT[], TEXT[], TEXT, INTEGER, FLOAT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION rag_search(TEXT, TEXT[], TEXT[], TEXT, INTEGER, FLOAT, TEXT) TO anon;

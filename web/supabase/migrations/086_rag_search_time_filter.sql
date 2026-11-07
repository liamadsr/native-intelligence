-- ============================================================
-- Migration 086: Add time-window + transcript filtering to rag_search
-- 1. Adds `source` column to capture_chunks ('summary' | 'transcript')
-- 2. Adds p_created_after and p_include_transcripts params to rag_search
-- ============================================================

-- Add source column to capture_chunks (defaults to 'summary' for existing rows)
ALTER TABLE public.capture_chunks ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'summary';

-- Index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_capture_chunks_source ON public.capture_chunks (source);

-- Drop old signature so we can recreate with new parameters
DROP FUNCTION IF EXISTS public.rag_search(TEXT, TEXT[], TEXT[], TEXT, INTEGER, FLOAT, TEXT);

CREATE OR REPLACE FUNCTION rag_search(
    p_user_id TEXT,
    p_project_ids TEXT[],
    p_note_ids TEXT[],
    p_embedding TEXT,
    p_limit INTEGER DEFAULT 10,
    p_threshold FLOAT DEFAULT 0.0,
    p_workspace_id TEXT DEFAULT NULL,
    p_created_after TIMESTAMPTZ DEFAULT NULL,
    p_include_transcripts BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
    chunk_id UUID,
    capture_id UUID,
    project_id UUID,
    chunk_text TEXT,
    chunk_index INTEGER,
    capture_title TEXT,
    recipe_name TEXT,
    similarity FLOAT
) AS $$
DECLARE
    v_user_id UUID := p_user_id::UUID;
    v_embedding vector(1536) := p_embedding::vector(1536);
    v_has_project_filter BOOLEAN := COALESCE(array_length(p_project_ids, 1), 0) > 0;
    v_has_capture_filter BOOLEAN := COALESCE(array_length(p_note_ids, 1), 0) > 0;
    v_workspace_id UUID := CASE WHEN p_workspace_id IS NOT NULL THEN p_workspace_id::UUID ELSE NULL END;
    v_project_ids UUID[];
    v_capture_ids UUID[];
BEGIN
    IF v_has_project_filter THEN
        v_project_ids := ARRAY(SELECT unnest(p_project_ids)::UUID);
    ELSE
        v_project_ids := NULL;
    END IF;

    IF v_has_capture_filter THEN
        v_capture_ids := ARRAY(SELECT unnest(p_note_ids)::UUID);
    ELSE
        v_capture_ids := NULL;
    END IF;

    RETURN QUERY
    SELECT
        cc.id as chunk_id,
        cc.capture_id,
        cc.project_id,
        cc.chunk_text,
        cc.chunk_index,
        c.title as capture_title,
        r.name as recipe_name,
        1 - (cc.embedding <=> v_embedding) as similarity
    FROM capture_chunks cc
    JOIN captures c ON c.id = cc.capture_id
    LEFT JOIN recipe r ON r.id = c.recipe_id
    WHERE cc.user_id = v_user_id
      AND cc.embedding IS NOT NULL
      AND 1 - (cc.embedding <=> v_embedding) >= p_threshold
      AND (v_workspace_id IS NULL OR cc.workspace_id = v_workspace_id)
      AND (p_created_after IS NULL OR c.created_at >= p_created_after)
      AND (p_include_transcripts OR cc.source <> 'transcript')
      AND (
          (NOT v_has_project_filter AND NOT v_has_capture_filter)
          OR (v_has_project_filter AND cc.project_id = ANY(v_project_ids))
          OR (v_has_capture_filter AND cc.capture_id = ANY(v_capture_ids))
      )
    ORDER BY cc.embedding <=> v_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION rag_search(TEXT, TEXT[], TEXT[], TEXT, INTEGER, FLOAT, TEXT, TIMESTAMPTZ, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION rag_search(TEXT, TEXT[], TEXT[], TEXT, INTEGER, FLOAT, TEXT, TIMESTAMPTZ, BOOLEAN) TO anon;

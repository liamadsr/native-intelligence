-- ============================================================
-- Migration 087: Multimodal attachment embeddings via Gemini
-- 1. Adds embedding status columns to attachments table
-- 2. Creates attachment_chunks table with halfvec(3072) for Gemini embeddings
-- 3. Creates attachment_rag_search RPC for semantic search over attachments
-- ============================================================

-- 1. Add embedding status columns to attachments
ALTER TABLE public.attachments
  ADD COLUMN IF NOT EXISTS embedding_status TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS embedding_error TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS embedding_completed_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_attachments_embedding_status
  ON public.attachments (embedding_status) WHERE embedding_status IS NOT NULL;

-- 2. Create attachment_chunks table
CREATE TABLE IF NOT EXISTS public.attachment_chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  attachment_id UUID NOT NULL REFERENCES public.attachments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  workspace_id UUID,
  project_id UUID,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  chunk_text TEXT,
  chunk_type TEXT NOT NULL DEFAULT 'full',
  page_number INTEGER,
  embedding halfvec(3072) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attachment_chunks_attachment_id ON public.attachment_chunks (attachment_id);
CREATE INDEX IF NOT EXISTS idx_attachment_chunks_user_id ON public.attachment_chunks (user_id);
CREATE INDEX IF NOT EXISTS idx_attachment_chunks_workspace_id ON public.attachment_chunks (workspace_id);
CREATE INDEX IF NOT EXISTS idx_attachment_chunks_user_workspace ON public.attachment_chunks (user_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_attachment_chunks_embedding ON public.attachment_chunks
  USING hnsw (embedding halfvec_cosine_ops);

-- 3. RLS on attachment_chunks (mirrors capture_chunks pattern)
ALTER TABLE public.attachment_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "attachment_chunks_select"
  ON public.attachment_chunks FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.attachments a
    WHERE a.id = attachment_chunks.attachment_id
      AND a.user_id = auth.uid()
  ));

CREATE POLICY "attachment_chunks_insert"
  ON public.attachment_chunks FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.attachments a
    WHERE a.id = attachment_chunks.attachment_id
      AND a.user_id = auth.uid()
  ));

CREATE POLICY "attachment_chunks_delete"
  ON public.attachment_chunks FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.attachments a
    WHERE a.id = attachment_chunks.attachment_id
      AND a.user_id = auth.uid()
  ));

-- 4. Create attachment_rag_search RPC
CREATE OR REPLACE FUNCTION attachment_rag_search(
    p_user_id TEXT,
    p_embedding TEXT,
    p_workspace_id TEXT DEFAULT NULL,
    p_project_ids TEXT[] DEFAULT '{}',
    p_limit INTEGER DEFAULT 10,
    p_threshold FLOAT DEFAULT 0.3
)
RETURNS TABLE (
    chunk_id UUID,
    attachment_id UUID,
    project_id UUID,
    chunk_text TEXT,
    chunk_type TEXT,
    page_number INTEGER,
    file_name TEXT,
    file_category TEXT,
    mime_type TEXT,
    storage_path TEXT,
    parent_capture_id UUID,
    parent_action_id UUID,
    similarity FLOAT
) AS $$
DECLARE
    v_user_id UUID := p_user_id::UUID;
    v_embedding halfvec(3072) := p_embedding::halfvec(3072);
    v_workspace_id UUID := CASE WHEN p_workspace_id IS NOT NULL THEN p_workspace_id::UUID ELSE NULL END;
    v_has_project_filter BOOLEAN := COALESCE(array_length(p_project_ids, 1), 0) > 0;
    v_project_ids UUID[];
BEGIN
    IF v_has_project_filter THEN
        v_project_ids := ARRAY(SELECT unnest(p_project_ids)::UUID);
    END IF;

    RETURN QUERY
    SELECT
        ac.id as chunk_id,
        ac.attachment_id,
        ac.project_id,
        ac.chunk_text,
        ac.chunk_type,
        ac.page_number,
        a.file_name,
        a.file_category,
        a.mime_type,
        a.storage_path,
        a.note_id as parent_capture_id,
        a.action_id as parent_action_id,
        1 - (ac.embedding <=> v_embedding) as similarity
    FROM attachment_chunks ac
    JOIN attachments a ON a.id = ac.attachment_id
    WHERE ac.user_id = v_user_id
      AND ac.embedding IS NOT NULL
      AND 1 - (ac.embedding <=> v_embedding) >= p_threshold
      AND (v_workspace_id IS NULL OR ac.workspace_id = v_workspace_id)
      AND (
          NOT v_has_project_filter
          OR ac.project_id = ANY(v_project_ids)
      )
    ORDER BY ac.embedding <=> v_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION attachment_rag_search(TEXT, TEXT, TEXT, TEXT[], INTEGER, FLOAT) TO authenticated;
GRANT EXECUTE ON FUNCTION attachment_rag_search(TEXT, TEXT, TEXT, TEXT[], INTEGER, FLOAT) TO anon;

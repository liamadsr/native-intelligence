-- ============================================================
-- Migration 112: Move claim text embeddings from Gemini → OpenAI
--
-- Claims are plain TEXT, so they belong on the same embedding stack as
-- captures (OpenAI text-embedding-3-small, 1536-d) — not Gemini's
-- multimodal model (3072-d), which is reserved for attachments
-- (images/PDFs) where multimodal actually matters.
--
-- This aligns claim_chunks with capture_chunks (vector(1536)) and the
-- rag_search pattern. attachment_chunks stays halfvec(3072) / Gemini.
--
-- Changes:
--   1. claim_chunks.embedding: halfvec(3072) → vector(1536)
--   2. Swap the HNSW index to vector_cosine_ops
--   3. match_claims RPC: cast to vector(1536)
--
-- NOTE: existing claim_chunks rows hold Gemini 3072-d vectors that are
-- incompatible with the new column type. They are truncated here and
-- re-embedded by the backfill step (run separately via the OpenAI path).
-- ============================================================

-- 1. Drop the old HNSW index (bound to halfvec_cosine_ops) before altering the column.
DROP INDEX IF EXISTS public.idx_claim_chunks_embedding;

-- 2. Clear incompatible vectors. ALTER TYPE can't coerce 3072-d → 1536-d,
--    and the dimensions are meaningless across models anyway.
TRUNCATE TABLE public.claim_chunks;

-- 3. Convert the column. After TRUNCATE the table is empty, so the type
--    change is a metadata-only operation.
ALTER TABLE public.claim_chunks
  ALTER COLUMN embedding TYPE vector(1536);

-- 4. Recreate the index for the new type.
CREATE INDEX IF NOT EXISTS idx_claim_chunks_embedding ON public.claim_chunks
  USING hnsw (embedding vector_cosine_ops);

-- ============================================================
-- 5. match_claims RPC — recreate casting to vector(1536).
-- Signature unchanged; only the embedding type cast differs.
-- ============================================================

CREATE OR REPLACE FUNCTION public.match_claims(
    p_workspace_id TEXT,
    p_embedding TEXT,
    p_limit INTEGER DEFAULT 10,
    p_threshold FLOAT DEFAULT 0.3,
    p_type TEXT DEFAULT NULL,
    p_confirmation TEXT DEFAULT NULL,
    p_status TEXT DEFAULT 'active'
)
RETURNS TABLE (
    claim_id UUID,
    chunk_id UUID,
    chunk_text TEXT,
    claim_text TEXT,
    claim_type TEXT,
    confirmation TEXT,
    status TEXT,
    confidence REAL,
    similarity FLOAT
) AS $$
DECLARE
    v_workspace_id UUID := p_workspace_id::UUID;
    v_embedding vector(1536) := p_embedding::vector(1536);
BEGIN
    RETURN QUERY
    SELECT
        c.id AS claim_id,
        cc.id AS chunk_id,
        cc.chunk_text,
        c.text AS claim_text,
        c.type AS claim_type,
        c.confirmation,
        c.status,
        c.confidence,
        1 - (cc.embedding <=> v_embedding) AS similarity
    FROM public.claim_chunks cc
    JOIN public.claim c ON c.id = cc.claim_id
    WHERE cc.workspace_id = v_workspace_id
      AND 1 - (cc.embedding <=> v_embedding) >= p_threshold
      AND (p_type IS NULL OR c.type = p_type)
      AND (p_confirmation IS NULL OR c.confirmation = p_confirmation)
      AND (p_status IS NULL OR c.status = p_status)
    ORDER BY cc.embedding <=> v_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Re-grant (CREATE OR REPLACE preserves grants, but be explicit). Note:
-- migration 111 removed the anon grant; keep it authenticated-only.
GRANT EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, FLOAT, TEXT, TEXT, TEXT) TO authenticated;

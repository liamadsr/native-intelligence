-- Migration 185: document_chunks — OpenAI 1536-d embeddings for documents, the
-- vector half of hybrid_search's document branch (knowledge-recall plan item 19).
--
-- WHY: migration 182 shipped hybrid_search with the document branch FTS+recency
-- only — documents had no embeddings, so semantic recall over wiki pages / PRDs /
-- specs degraded to keyword match. This table is that missing vector index. It
-- mirrors capture_chunks exactly in shape and embedding space:
--   - vector(1536), OpenAI text-embedding-3-small — the SAME shared space as
--     capture_chunks (migration 113) and hybrid_search's p_embedding, so migration
--     186 can add a document_vec CTE identical to capture_vec with no second model.
--   - HNSW vector_cosine_ops index (capture_chunks' pattern), not the halfvec/
--     Gemini pattern claim_chunks uses.
-- Rows are written app-side by indexDocument() (src/lib/ai/embeddings.ts) via a
-- delete-then-reinsert on every content-changing document write.
--
-- SECURITY: RLS mirrors claim_chunks (migration 109) — workspace-scoped directly
-- (workspace_id is on the row), members read + write.

CREATE TABLE IF NOT EXISTS public.document_chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES public.document(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  chunk_text TEXT NOT NULL,
  -- OpenAI text-embedding-3-small, 1536-d — same space as capture_chunks so
  -- hybrid_search's document_vec CTE mirrors capture_vec with no second model.
  embedding vector(1536) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_document ON public.document_chunks (document_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_workspace ON public.document_chunks (workspace_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding ON public.document_chunks
  USING hnsw (embedding vector_cosine_ops);

-- ============================================================
-- RLS — workspace-scoped directly (workspace_id on the row), same posture as
-- claim_chunks (migration 109). The helper public.is_workspace_member() already
-- exists (migration 020).
-- ============================================================

ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view document chunks"
  ON public.document_chunks FOR SELECT
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "Workspace members can write document chunks"
  ON public.document_chunks FOR ALL
  USING (public.is_workspace_member(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id));

-- ============================================================
-- Migration 109: Claims-based knowledge graph
-- 1. claim                 — atomic knowledge units (text, type, lifecycle)
-- 2. claim_source          — evidence linking claims to captures/attachments/etc.
-- 3. claim_chunks          — Gemini halfvec(3072) embeddings for semantic search
-- 4. entity_link           — heterogeneous graph edges across all entity types
-- 5. match_claims RPC      — semantic search over claims
-- ============================================================

-- ============================================================
-- 1. claim
-- ============================================================

CREATE TABLE IF NOT EXISTS public.claim (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('fact', 'open_question', 'inference', 'decision_summary')),
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  confirmation TEXT NOT NULL DEFAULT 'suggested'
    CHECK (confirmation IN ('suggested', 'confirmed', 'dismissed')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'disputed', 'archived')),
  superseded_by UUID REFERENCES public.claim(id) ON DELETE SET NULL,
  created_by UUID REFERENCES public.member(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ,
  fts TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);

CREATE INDEX IF NOT EXISTS idx_claim_workspace ON public.claim (workspace_id);
CREATE INDEX IF NOT EXISTS idx_claim_workspace_type ON public.claim (workspace_id, type);
CREATE INDEX IF NOT EXISTS idx_claim_workspace_confirmation ON public.claim (workspace_id, confirmation);
CREATE INDEX IF NOT EXISTS idx_claim_workspace_status ON public.claim (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_claim_fts ON public.claim USING gin (fts);

-- Trigger to keep updated_at fresh
CREATE OR REPLACE FUNCTION public._claim_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_set_updated_at
  BEFORE UPDATE ON public.claim
  FOR EACH ROW
  EXECUTE FUNCTION public._claim_set_updated_at();

-- ============================================================
-- 2. claim_source
-- Evidence: one claim can be supported by N sources.
-- Uses a generated column for the dedupe key so primary key includes
-- either source_id or source_uri (one of them is always non-null).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.claim_source (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  claim_id UUID NOT NULL REFERENCES public.claim(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('capture', 'attachment', 'document', 'email', 'external_url', 'manual')),
  source_id UUID,
  source_uri TEXT,
  excerpt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source_id IS NOT NULL OR source_uri IS NOT NULL),
  -- NULLS NOT DISTINCT so internal sources (source_uri NULL) and manual
  -- sources (source_id NULL) still dedupe. See migration 111.
  UNIQUE NULLS NOT DISTINCT (claim_id, source_type, source_id, source_uri)
);

CREATE INDEX IF NOT EXISTS idx_claim_source_claim ON public.claim_source (claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_source_lookup
  ON public.claim_source (source_type, source_id) WHERE source_id IS NOT NULL;

-- ============================================================
-- 3. claim_chunks
-- Same shape as attachment_chunks (migration 087): halfvec(3072), HNSW.
-- Most claims are short and fit in one chunk; chunk_index allows for long claims later.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.claim_chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  claim_id UUID NOT NULL REFERENCES public.claim(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  chunk_text TEXT NOT NULL,
  embedding halfvec(3072) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (claim_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_claim_chunks_claim ON public.claim_chunks (claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_chunks_workspace ON public.claim_chunks (workspace_id);
CREATE INDEX IF NOT EXISTS idx_claim_chunks_embedding ON public.claim_chunks
  USING hnsw (embedding halfvec_cosine_ops);

-- ============================================================
-- 4. entity_link
-- Heterogeneous edges. Polymorphic by (entity_type, entity_id) — same
-- pattern as claim_source, scaled up to a full graph table.
-- Any entity (document, claim, capture, contact, project, action) can
-- point at any other.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.entity_link (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  relation TEXT NOT NULL DEFAULT 'mentions'
    CHECK (relation IN (
      'mentions', 'depends_on', 'supersedes', 'authored_by',
      'cites', 'about', 'related_to', 'contradicts'
    )),
  weight REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES public.member(id) ON DELETE SET NULL,
  UNIQUE (workspace_id, source_type, source_id, target_type, target_id, relation),
  CHECK (NOT (source_type = target_type AND source_id = target_id))
);

CREATE INDEX IF NOT EXISTS idx_entity_link_source
  ON public.entity_link (workspace_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_entity_link_target
  ON public.entity_link (workspace_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_entity_link_relation
  ON public.entity_link (workspace_id, relation);

-- ============================================================
-- 5. RLS — workspace members can read; members can write; the helpers
-- public.is_workspace_member() / public.get_member_role() already exist
-- (see migration 020_workflow_states_labels.sql).
-- ============================================================

ALTER TABLE public.claim ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view claims"
  ON public.claim FOR SELECT
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "Workspace members can insert claims"
  ON public.claim FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY "Workspace members can update claims"
  ON public.claim FOR UPDATE
  USING (public.is_workspace_member(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id));

CREATE POLICY "Workspace members can delete claims"
  ON public.claim FOR DELETE
  USING (public.is_workspace_member(workspace_id));

-- claim_source: access follows the parent claim
ALTER TABLE public.claim_source ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Claim source access follows claim"
  ON public.claim_source FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.claim c
    WHERE c.id = claim_source.claim_id
      AND public.is_workspace_member(c.workspace_id)
  ));

CREATE POLICY "Claim source write follows claim"
  ON public.claim_source FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.claim c
    WHERE c.id = claim_source.claim_id
      AND public.is_workspace_member(c.workspace_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.claim c
    WHERE c.id = claim_source.claim_id
      AND public.is_workspace_member(c.workspace_id)
  ));

-- claim_chunks: workspace-scoped directly (workspace_id is on the row)
ALTER TABLE public.claim_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view claim chunks"
  ON public.claim_chunks FOR SELECT
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "Workspace members can write claim chunks"
  ON public.claim_chunks FOR ALL
  USING (public.is_workspace_member(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id));

-- entity_link: workspace-scoped
ALTER TABLE public.entity_link ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view entity links"
  ON public.entity_link FOR SELECT
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "Workspace members can write entity links"
  ON public.entity_link FOR ALL
  USING (public.is_workspace_member(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id));

-- ============================================================
-- 6. match_claims RPC — semantic search over claim_chunks.
-- Mirrors attachment_rag_search (migration 087) but scoped to claims.
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
    v_embedding halfvec(3072) := p_embedding::halfvec(3072);
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

GRANT EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, FLOAT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, FLOAT, TEXT, TEXT, TEXT) TO anon;

-- ============================================================
-- 7. Realtime publication — keep claims and links live in the UI,
-- matching the pattern in 105_realtime_list_entities.sql.
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE public.claim;
ALTER PUBLICATION supabase_realtime ADD TABLE public.entity_link;

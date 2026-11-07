-- Migration 186: hybrid_search — fold document embeddings into the ranking
-- (knowledge-recall plan item 19).
--
-- WHY: migration 182 shipped hybrid_search with the document branch as FTS +
-- recency only, because documents had no vector index. Migration 185 adds
-- document_chunks (OpenAI 1536-d, the SAME shared space as capture_chunks and
-- hybrid_search's p_embedding). This migration teaches the document branch to
-- consume those vectors, so documents earn a vec_rank in the RRF fusion exactly
-- like captures do.
--
-- WHAT CHANGED vs 182 (document branch ONLY — claims + captures are byte-for-byte
-- identical):
--   - New document_vec CTE, structurally identical to capture_vec: DISTINCT-ON /
--     MIN(rnk) collapse of the nearest document_chunks per document, honoring the
--     same p_since/p_until hard filter on document.created_at and the same
--     v_embedding IS NOT NULL guard.
--   - document_union widened from `SELECT id FROM document_fts` to the FTS∪vec
--     union (mirrors capture_union), so a document that only matches semantically
--     still enters the candidate set.
--   - document_recency now ranges over document_union (not document_fts).
--   - document_final gains the p_w_vec term and a real vec_rank (was NULL::int),
--     and LEFT JOINs document_vec.
--
-- GRACEFUL DEGRADATION: when document_chunks is EMPTY (no doc embedded yet),
-- document_vec returns zero rows, document_union collapses to document_fts∪∅ =
-- document_fts, every vec_rank is NULL, the p_w_vec term contributes 0 (its
-- COALESCE default), and the branch produces the exact same rows/scores as 182.
-- Likewise p_embedding = NULL → v_embedding NULL → document_vec empty. So this is
-- behavior-preserving until embeddings actually exist.
--
-- SECURITY: CREATE OR REPLACE re-grants EXECUTE to PUBLIC — re-assert the REVOKE +
-- explicit GRANT + pinned search_path at the end (this repo has been burned by the
-- silent re-grant repeatedly). Signature is IDENTICAL to 182 (same 12-arg
-- overload) so REVOKE/GRANT target the same function.

CREATE OR REPLACE FUNCTION public.hybrid_search(
    p_workspace_id   UUID,
    p_query          TEXT,
    p_embedding      TEXT DEFAULT NULL,               -- OpenAI 1536-d as '[..]' text; NULL → FTS-only
    p_types          TEXT[] DEFAULT ARRAY['claim','capture','document'],
    p_since          TIMESTAMPTZ DEFAULT NULL,
    p_until          TIMESTAMPTZ DEFAULT NULL,
    p_limit          INTEGER DEFAULT 20,
    p_candidate_k    INTEGER DEFAULT 40,              -- depth of each method's own list before fusion
    p_w_fts          DOUBLE PRECISION DEFAULT 1.0,
    p_w_vec          DOUBLE PRECISION DEFAULT 1.0,
    p_w_recent       DOUBLE PRECISION DEFAULT 0.5,
    p_claim_status   TEXT DEFAULT 'active'            -- claims-only filter; ignored for other types
)
RETURNS TABLE(
    result_type   TEXT,
    result_id     UUID,
    title         TEXT,
    score         DOUBLE PRECISION,
    event_at      TIMESTAMPTZ,
    fts_rank      INTEGER,
    vec_rank      INTEGER,
    recency_rank  INTEGER,
    excerpt       TEXT,
    source_label  TEXT,
    source_type   TEXT,
    metadata      JSONB
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
    v_tsquery   tsquery;
    v_embedding vector(1536) := CASE WHEN p_embedding IS NULL THEN NULL ELSE p_embedding::vector(1536) END;
BEGIN
    IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(p_workspace_id) THEN
        RETURN;
    END IF;

    -- websearch_to_tsquery is forgiving of user phrasing but can still raise on
    -- pathological input — fall back to NULL (no FTS candidates) rather than error.
    BEGIN
        v_tsquery := websearch_to_tsquery('english', p_query);
    EXCEPTION WHEN OTHERS THEN
        v_tsquery := NULL;
    END;

    RETURN QUERY
    WITH
    -- ============ CLAIMS ============
    claim_fts AS (
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank(c.fts, v_tsquery) DESC)::int AS rnk
        FROM public.claim c
        WHERE c.workspace_id = p_workspace_id AND 'claim' = ANY(p_types)
          AND c.status = p_claim_status AND c.confirmation <> 'dismissed'
          AND v_tsquery IS NOT NULL AND c.fts @@ v_tsquery
          AND (p_since IS NULL OR (c.event_at IS NOT NULL AND c.event_at >= p_since))
          AND (p_until IS NULL OR (c.event_at IS NOT NULL AND c.event_at <= p_until))
        LIMIT p_candidate_k
    ),
    claim_vec AS (
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY cc.embedding <=> v_embedding)::int AS rnk
        FROM public.claim_chunks cc
        JOIN public.claim c ON c.id = cc.claim_id
        WHERE cc.workspace_id = p_workspace_id AND 'claim' = ANY(p_types) AND v_embedding IS NOT NULL
          AND c.status = p_claim_status AND c.confirmation <> 'dismissed'
          AND (p_since IS NULL OR (c.event_at IS NOT NULL AND c.event_at >= p_since))
          AND (p_until IS NULL OR (c.event_at IS NOT NULL AND c.event_at <= p_until))
        ORDER BY cc.embedding <=> v_embedding
        LIMIT p_candidate_k
    ),
    claim_union AS (
        SELECT id FROM claim_fts UNION SELECT id FROM claim_vec
    ),
    claim_recency AS (
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY c.event_at DESC NULLS LAST)::int AS rnk
        FROM public.claim c JOIN claim_union u ON u.id = c.id
    ),
    claim_scored AS (
        SELECT
            c.id AS result_id,
            LEFT(c.text, 140) AS title,
            p_w_fts    * COALESCE(1.0/(60+cf.rnk), 0) +
            p_w_vec    * COALESCE(1.0/(60+cv.rnk), 0) +
            p_w_recent * COALESCE(1.0/(60+cr.rnk), 0) AS score,
            c.event_at,
            cf.rnk AS fts_rank, cv.rnk AS vec_rank, cr.rnk AS recency_rank,
            jsonb_build_object(
                'type', c.type, 'confirmation', c.confirmation,
                'status', c.status, 'confidence', c.confidence
            ) AS metadata
        FROM public.claim c
        JOIN claim_union u ON u.id = c.id
        LEFT JOIN claim_fts cf ON cf.id = c.id
        LEFT JOIN claim_vec cv ON cv.id = c.id
        LEFT JOIN claim_recency cr ON cr.id = c.id
    ),
    -- top ONE claim_source per claim for inline provenance (avoids N+1 get_claim).
    -- Prefer a source that carries an excerpt; break ties by most recent.
    claim_top_source AS (
        SELECT DISTINCT ON (cs.claim_id)
            cs.claim_id, cs.source_type, cs.source_id, cs.excerpt
        FROM public.claim_source cs
        WHERE cs.claim_id IN (SELECT result_id FROM claim_scored)
        ORDER BY cs.claim_id, (cs.excerpt IS NOT NULL) DESC, cs.created_at DESC
    ),
    claim_final AS (
        SELECT
            'claim'::text AS result_type,
            cs.result_id,
            cs.title,
            cs.score,
            cs.event_at,
            cs.fts_rank, cs.vec_rank, cs.recency_rank,
            ts.excerpt,
            COALESCE(
                CASE ts.source_type
                    WHEN 'capture'  THEN cap.title
                    WHEN 'document' THEN doc.title
                    WHEN 'email'    THEN em.subject
                    ELSE ts.source_type
                END, 'Claim'
            ) AS source_label,
            ts.source_type,
            cs.metadata
        FROM claim_scored cs
        LEFT JOIN claim_top_source ts ON ts.claim_id = cs.result_id
        LEFT JOIN public.captures      cap ON ts.source_type = 'capture'  AND cap.id = ts.source_id
        LEFT JOIN public.document      doc ON ts.source_type = 'document' AND doc.id = ts.source_id
        LEFT JOIN public.email_message em  ON ts.source_type = 'email'    AND em.id  = ts.source_id
    ),

    -- ============ CAPTURES ============
    capture_fts AS (
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank(c.fts, v_tsquery) DESC)::int AS rnk
        FROM public.captures c
        WHERE c.workspace_id = p_workspace_id AND 'capture' = ANY(p_types)
          AND v_tsquery IS NOT NULL AND c.fts @@ v_tsquery
          AND (p_since IS NULL OR (c.started_at IS NOT NULL AND c.started_at >= p_since))
          AND (p_until IS NULL OR (c.started_at IS NOT NULL AND c.started_at <= p_until))
        LIMIT p_candidate_k
    ),
    capture_vec AS (
        SELECT id, MIN(rnk)::int AS rnk FROM (
            SELECT cc.capture_id AS id,
                   ROW_NUMBER() OVER (ORDER BY cc.embedding <=> v_embedding) AS rnk
            FROM public.capture_chunks cc
            JOIN public.captures cap ON cap.id = cc.capture_id
            WHERE cc.workspace_id = p_workspace_id AND 'capture' = ANY(p_types) AND v_embedding IS NOT NULL
              AND (p_since IS NULL OR (cap.started_at IS NOT NULL AND cap.started_at >= p_since))
              AND (p_until IS NULL OR (cap.started_at IS NOT NULL AND cap.started_at <= p_until))
            ORDER BY cc.embedding <=> v_embedding
            LIMIT p_candidate_k
        ) ranked
        GROUP BY id
    ),
    capture_union AS (SELECT id FROM capture_fts UNION SELECT id FROM capture_vec),
    capture_recency AS (
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY c.started_at DESC NULLS LAST)::int AS rnk
        FROM public.captures c JOIN capture_union u ON u.id = c.id
    ),
    capture_final AS (
        SELECT
            'capture'::text AS result_type,
            c.id AS result_id,
            c.title,
            p_w_fts    * COALESCE(1.0/(60+cf.rnk), 0) +
            p_w_vec    * COALESCE(1.0/(60+cv.rnk), 0) +
            p_w_recent * COALESCE(1.0/(60+cr.rnk), 0) AS score,
            c.started_at AS event_at,
            cf.rnk AS fts_rank, cv.rnk AS vec_rank, cr.rnk AS recency_rank,
            (SELECT chunk_text FROM public.capture_chunks
             WHERE capture_id = c.id ORDER BY (source = 'summary') DESC, chunk_index ASC LIMIT 1) AS excerpt,
            'Capture'::text AS source_label,
            'capture'::text AS source_type,
            jsonb_build_object('duration_seconds', c.duration_seconds, 'project_id', c.project_id) AS metadata
        FROM public.captures c
        JOIN capture_union u ON u.id = c.id
        LEFT JOIN capture_fts cf ON cf.id = c.id
        LEFT JOIN capture_vec cv ON cv.id = c.id
        LEFT JOIN capture_recency cr ON cr.id = c.id
    ),

    -- ============ DOCUMENTS (FTS + vector + recency) ============
    document_fts AS (
        SELECT d.id, ROW_NUMBER() OVER (ORDER BY ts_rank(d.fts, v_tsquery) DESC)::int AS rnk
        FROM public.document d
        WHERE d.workspace_id = p_workspace_id AND 'document' = ANY(p_types)
          AND v_tsquery IS NOT NULL AND d.fts @@ v_tsquery
          AND (p_since IS NULL OR d.created_at >= p_since)
          AND (p_until IS NULL OR d.created_at <= p_until)
        LIMIT p_candidate_k
    ),
    document_vec AS (
        SELECT id, MIN(rnk)::int AS rnk FROM (
            SELECT dc.document_id AS id,
                   ROW_NUMBER() OVER (ORDER BY dc.embedding <=> v_embedding) AS rnk
            FROM public.document_chunks dc
            JOIN public.document d ON d.id = dc.document_id
            WHERE dc.workspace_id = p_workspace_id AND 'document' = ANY(p_types) AND v_embedding IS NOT NULL
              AND (p_since IS NULL OR d.created_at >= p_since)
              AND (p_until IS NULL OR d.created_at <= p_until)
            ORDER BY dc.embedding <=> v_embedding
            LIMIT p_candidate_k
        ) ranked
        GROUP BY id
    ),
    document_union AS (SELECT id FROM document_fts UNION SELECT id FROM document_vec),
    document_recency AS (
        SELECT d.id, ROW_NUMBER() OVER (ORDER BY d.created_at DESC)::int AS rnk
        FROM public.document d JOIN document_union u ON u.id = d.id
    ),
    document_final AS (
        SELECT
            'document'::text AS result_type,
            d.id AS result_id,
            d.title,
            p_w_fts    * COALESCE(1.0/(60+df.rnk), 0) +
            p_w_vec    * COALESCE(1.0/(60+dv.rnk), 0) +
            p_w_recent * COALESCE(1.0/(60+dr.rnk), 0) AS score,
            d.created_at AS event_at,
            df.rnk AS fts_rank,
            dv.rnk AS vec_rank,
            dr.rnk AS recency_rank,
            LEFT(d.content, 300) AS excerpt,
            'Document'::text AS source_label,
            'document'::text AS source_type,
            jsonb_build_object('status', d.status, 'project_id', d.project_id) AS metadata
        FROM public.document d
        JOIN document_union u ON u.id = d.id
        LEFT JOIN document_fts df ON df.id = d.id
        LEFT JOIN document_vec dv ON dv.id = d.id
        LEFT JOIN document_recency dr ON dr.id = d.id
    )

    SELECT * FROM claim_final
    UNION ALL SELECT * FROM capture_final
    UNION ALL SELECT * FROM document_final
    ORDER BY score DESC
    LIMIT p_limit;
END;
$$;

-- CREATE OR REPLACE re-granted EXECUTE to PUBLIC — re-assert the lockdown.
REVOKE EXECUTE ON FUNCTION public.hybrid_search(UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hybrid_search(UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT) TO authenticated, service_role;

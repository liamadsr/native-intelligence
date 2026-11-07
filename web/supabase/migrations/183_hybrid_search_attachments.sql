-- Migration 183: hybrid_search_attachments — sibling of hybrid_search for the
-- attachment corpus, which lives in Gemini halfvec(3072) space (migration 087).
--
-- WHY (knowledge-recall plan, item 10): attachments can't share hybrid_search's
-- p_embedding — their vectors are a different model AND dimensionality (Gemini
-- 3072-d vs OpenAI 1536-d), and there is no valid cross-space comparison. Rather
-- than smuggle two embedding params into one RPC (forcing every caller to embed
-- twice up front), attachments get their own narrow RPC. The `find` tool calls
-- it only when attachments are requested, and fuses its results with
-- hybrid_search's at the APPLICATION layer using RRF by RANK (not score — scores
-- from different embedding spaces are not comparable; ranks are).
--
-- Attachments have no full-text index of their own (only the chunk vectors), so
-- this RPC ranks on vector similarity + recency only. fts_rank is always NULL —
-- the row shape stays compatible with hybrid_search so the app can fuse the two
-- streams uniformly. p_since / p_until are HARD filters on attachments.created_at
-- (attachments have no "event time" — created_at is the correct proxy).
--
-- Returns the hybrid_search columns PLUS attachment-specific fields the tool
-- needs to mint signed URLs and surface parentage: storage_path, mime_type,
-- parent_capture_id, parent_action_id, project_id (folded into metadata JSONB so
-- the base row shape matches hybrid_search exactly).
--
-- SECURITY: SECURITY DEFINER + the 125/126 member gate (service-role passes
-- through) + REVOKE FROM PUBLIC, anon + explicit GRANT + pinned search_path.

CREATE OR REPLACE FUNCTION public.hybrid_search_attachments(
    p_workspace_id   UUID,
    p_embedding      TEXT DEFAULT NULL,           -- Gemini 3072-d as '[..]' text; NULL → no results
    p_since          TIMESTAMPTZ DEFAULT NULL,
    p_until          TIMESTAMPTZ DEFAULT NULL,
    p_limit          INTEGER DEFAULT 20,
    p_candidate_k    INTEGER DEFAULT 40,
    p_w_vec          DOUBLE PRECISION DEFAULT 1.0,
    p_w_recent       DOUBLE PRECISION DEFAULT 0.5
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
    v_embedding halfvec(3072) := CASE WHEN p_embedding IS NULL THEN NULL ELSE p_embedding::halfvec(3072) END;
BEGIN
    IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(p_workspace_id) THEN
        RETURN;
    END IF;

    IF v_embedding IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH
    -- Best-ranking chunk per attachment (an attachment has many chunks; we fuse
    -- at the attachment level, not the chunk level).
    attachment_vec AS (
        SELECT id, MIN(rnk)::int AS rnk, (ARRAY_AGG(chunk_text ORDER BY rnk))[1] AS excerpt
        FROM (
            SELECT ac.attachment_id AS id, ac.chunk_text,
                   ROW_NUMBER() OVER (ORDER BY ac.embedding <=> v_embedding) AS rnk
            FROM public.attachment_chunks ac
            JOIN public.attachments a ON a.id = ac.attachment_id
            WHERE ac.workspace_id = p_workspace_id AND ac.embedding IS NOT NULL
              AND (p_since IS NULL OR a.created_at >= p_since)
              AND (p_until IS NULL OR a.created_at <= p_until)
            ORDER BY ac.embedding <=> v_embedding
            LIMIT p_candidate_k
        ) ranked
        GROUP BY id
    ),
    attachment_recency AS (
        SELECT a.id, ROW_NUMBER() OVER (ORDER BY a.created_at DESC NULLS LAST)::int AS rnk
        FROM public.attachments a JOIN attachment_vec u ON u.id = a.id
    )
    SELECT
        'attachment'::text AS result_type,
        a.id AS result_id,
        a.file_name AS title,
        p_w_vec    * COALESCE(1.0/(60+av.rnk), 0) +
        p_w_recent * COALESCE(1.0/(60+ar.rnk), 0) AS score,
        a.created_at AS event_at,
        NULL::int AS fts_rank,
        av.rnk AS vec_rank,
        ar.rnk AS recency_rank,
        av.excerpt,
        'Attachment'::text AS source_label,
        'attachment'::text AS source_type,
        jsonb_build_object(
            'storage_path', a.storage_path,
            'mime_type', a.mime_type,
            'file_category', a.file_category,
            'parent_capture_id', a.note_id,
            'parent_action_id', a.action_id,
            'project_id', a.project_id
        ) AS metadata
    FROM public.attachments a
    JOIN attachment_vec av ON av.id = a.id
    LEFT JOIN attachment_recency ar ON ar.id = a.id
    ORDER BY score DESC
    LIMIT p_limit;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.hybrid_search_attachments(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hybrid_search_attachments(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated, service_role;

-- ============================================================
-- 365: search finds documents wherever they match (documents phase 1,
-- item 5; docs/plans/documents-as-ground-truth.md).
-- ============================================================
-- Until now a document was found only if:
--   * the main chat's default 4-week window (by created_at) reached it: a
--     product doc written in July did not exist for a chat search;
--   * and its excerpt was its first 300 characters, not what matched;
--   * and archived documents came back like any other.
-- On PROD (2026-10-19) 121 of 191 documents have no vectors at all, and every
-- chunk is a sentence split with no idea which section it came from.
--
-- This changes three things:
--   1. hybrid_search, the document branch only (341/353's body otherwise,
--      byte for byte; claims and captures are untouched):
--        - archived documents are left out;
--        - p_since / p_until filter documents by updated_at (the last time the
--          text changed). The app no longer passes the chat's default window
--          for documents at all (src/lib/ai/tools/search.ts): only an explicit
--          since / until reaches them;
--        - recency ranks and event_at use updated_at;
--        - the excerpt is the passage that matched: the nearest chunk when
--          the vectors found it, else the chunk the query's words rank best
--          in, else (no vectors) a headline around the words, else the first
--          300 characters; metadata.section is that chunk's heading path.
--          Computed for the documents that can make the list only (at most
--          p_limit), so a search costs a few chunk reads more, not one per
--          candidate.
--   2. document_chunks.heading: the heading path a chunk sits under
--      ("Positioning > Real alternative"), written by the chunker
--      (src/lib/ai/embeddings.ts) and embedded with the chunk's text.
--   3. replace_document_chunks(document, workspace, project, rows): swaps a
--      document's chunks in one transaction, after the embeddings exist, so
--      a failed embed never leaves a document with no vectors. A row with no
--      embedding reuses the one an old chunk with the same text and heading
--      already has (only what changed is re-embedded); if there is none the
--      call fails (not-null) and nothing changes. SECURITY INVOKER: RLS on
--      document_chunks applies as it did to the old delete-then-insert.
--      Serialized per document (advisory lock). It refuses a document that
--      is not in the workspace it names (42501), and reads, deletes and
--      renumbers only that workspace's chunks.
--   4. document_chunks RLS: a chunk is readable and writable only when its
--      document is in the chunk's own workspace (185 checked the chunk's
--      workspace alone, so a member of one workspace could file chunks under
--      another workspace's document). hybrid_search reads only chunks of the
--      searched workspace whose document is there too.
--
-- Rollout: DEV, then PROD BEFORE the app PR merges (the app calls
-- replace_document_chunks; without it, it falls back to the old
-- delete-then-insert after embedding). Then run the vector backfill
-- (scripts/backfill-document-vectors.ts) when the founder says.
--
-- Idempotent: add column if not exists, create or replace, drop policy if
-- exists; the cleanup delete finds nothing the second time. No backslash
-- anywhere in this file (the MCP apply tool decodes them).

-- ------------------------------------------------------------
-- 1. Chunks know their section
-- ------------------------------------------------------------

ALTER TABLE public.document_chunks
  ADD COLUMN IF NOT EXISTS heading TEXT;

-- ------------------------------------------------------------
-- 2. replace_document_chunks
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.replace_document_chunks(
    p_document_id  UUID,
    p_workspace_id UUID,
    p_project_id   UUID,
    p_rows         JSONB
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count INTEGER := 0;
BEGIN
    -- The document must be in the workspace the chunks are filed under (read
    -- as the caller: RLS applies). Chunks never cross workspaces.
    IF NOT EXISTS (
        SELECT 1 FROM public.document d
         WHERE d.id = p_document_id AND d.workspace_id = p_workspace_id
    ) THEN
        RAISE EXCEPTION 'document % is not in workspace %', p_document_id, p_workspace_id
          USING ERRCODE = '42501';
    END IF;

    -- One re-index of a document at a time.
    PERFORM pg_advisory_xact_lock(hashtextextended('replace_document_chunks:' || p_document_id::text, 0));

    -- The new chunks go in first, under negative indexes (the old ones hold
    -- 0..n), each with its embedding or the one an old chunk with the same
    -- text and heading has. A missing embedding fails the not-null and the
    -- whole call: the old chunks stay.
    INSERT INTO public.document_chunks (document_id, workspace_id, project_id, chunk_index, chunk_text, heading, embedding)
    SELECT
        p_document_id,
        p_workspace_id,
        p_project_id,
        -1 - (r ->> 'chunk_index')::int,
        r ->> 'chunk_text',
        NULLIF(r ->> 'heading', ''),
        COALESCE(
            (r ->> 'embedding')::vector(1536),
            (SELECT old.embedding
               FROM public.document_chunks old
              WHERE old.document_id = p_document_id
                AND old.workspace_id = p_workspace_id
                AND old.chunk_index >= 0
                AND old.chunk_text = r ->> 'chunk_text'
                AND old.heading IS NOT DISTINCT FROM NULLIF(r ->> 'heading', '')
              LIMIT 1)
        )
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) r;
    GET DIAGNOSTICS v_count = ROW_COUNT;

    DELETE FROM public.document_chunks
     WHERE document_id = p_document_id
       AND workspace_id = p_workspace_id
       AND chunk_index >= 0;

    UPDATE public.document_chunks
       SET chunk_index = -1 - chunk_index
     WHERE document_id = p_document_id
       AND workspace_id = p_workspace_id
       AND chunk_index < 0;

    RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.replace_document_chunks(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_document_chunks(UUID, UUID, UUID, JSONB) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2b. document_chunks RLS: the chunk's document is in the chunk's workspace
-- ------------------------------------------------------------

-- A chunk filed under another workspace's document can only have been
-- planted (a workspace move rewrites its documents' chunks, 221): drop any.
DELETE FROM public.document_chunks dc
 USING public.document d
 WHERE d.id = dc.document_id
   AND d.workspace_id <> dc.workspace_id;

DROP POLICY IF EXISTS "Workspace members can view document chunks" ON public.document_chunks;
DROP POLICY IF EXISTS "Workspace members can write document chunks" ON public.document_chunks;
DROP POLICY IF EXISTS document_chunks_select ON public.document_chunks;
DROP POLICY IF EXISTS document_chunks_write ON public.document_chunks;
CREATE POLICY document_chunks_select
  ON public.document_chunks FOR SELECT
  USING (
    public.is_workspace_member(workspace_id)
    AND EXISTS (
      SELECT 1 FROM public.document d
      WHERE d.id = document_chunks.document_id
        AND d.workspace_id = document_chunks.workspace_id
    )
  );
CREATE POLICY document_chunks_write
  ON public.document_chunks FOR ALL
  USING (
    public.is_workspace_member(workspace_id)
    AND EXISTS (
      SELECT 1 FROM public.document d
      WHERE d.id = document_chunks.document_id
        AND d.workspace_id = document_chunks.workspace_id
    )
  )
  WITH CHECK (
    public.is_workspace_member(workspace_id)
    AND EXISTS (
      SELECT 1 FROM public.document d
      WHERE d.id = document_chunks.document_id
        AND d.workspace_id = document_chunks.workspace_id
    )
  );

-- ------------------------------------------------------------
-- 3. hybrid_search (353's body; the document branch changed)
-- ------------------------------------------------------------
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
    p_claim_status   TEXT DEFAULT 'active',           -- claims-only filter; ignored for other types
    p_requesting_user_id UUID DEFAULT NULL            -- NULL → auth.uid(); still NULL → private captures excluded
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
    v_requester uuid := public._resolve_visibility_requester(p_requesting_user_id);
BEGIN
    -- Membership gate (275): enforced whenever the requester is KNOWN — whether
    -- it came from the JWT or from an explicit p_requesting_user_id — not only
    -- when a JWT happens to be present. A sessionless caller that asserts no
    -- requester at all sees workspace-visible rows only, and is trusted to
    -- scope itself (service-role already has the whole database).
    IF v_requester IS NOT NULL AND NOT public._is_member_of(v_requester, p_workspace_id) THEN
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
          AND public.claim_visible_to(c.id, v_requester)
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
          AND public.claim_visible_to(c.id, v_requester)
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
    -- A claim can be visible through a non-capture source while ALSO citing a
    -- private capture — skip those sources so the excerpt/label never leaks.
    claim_top_source AS (
        SELECT DISTINCT ON (cs.claim_id)
            cs.claim_id, cs.source_type, cs.source_id, cs.excerpt
        FROM public.claim_source cs
        WHERE cs.claim_id IN (SELECT result_id FROM claim_scored)
          AND CASE cs.source_type
              WHEN 'capture' THEN EXISTS (
                  SELECT 1 FROM public.captures cap2
                  WHERE cap2.id = cs.source_id
                    AND NOT cap2.is_eval
                    AND (cap2.visibility = 'workspace'
                         OR (v_requester IS NOT NULL AND cap2.user_id = v_requester))
              )
              -- attachments inherit their capture parent, same as claim_visible_to
              WHEN 'attachment' THEN EXISTS (
                  SELECT 1 FROM public.attachments att2
                  WHERE att2.id = cs.source_id
                    AND (
                        att2.note_id IS NULL
                        OR EXISTS (
                            SELECT 1 FROM public.captures cap3
                            WHERE cap3.id = att2.note_id
                              AND NOT cap3.is_eval
                              AND (cap3.visibility = 'workspace'
                                   OR (v_requester IS NOT NULL AND cap3.user_id = v_requester))
                        )
                    )
              )
              -- 341: mail is never a source anyone sees.
              WHEN 'email' THEN FALSE
              -- 353: a chat is only its owner's.
              WHEN 'conversation' THEN EXISTS (
                  SELECT 1 FROM public.chat_conversations cc2
                  WHERE cc2.id = cs.source_id
                    AND v_requester IS NOT NULL
                    AND cc2.user_id = v_requester
              )
              ELSE TRUE
          END
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
                    ELSE ts.source_type
                END, 'Claim'
            ) AS source_label,
            ts.source_type,
            cs.metadata
        FROM claim_scored cs
        LEFT JOIN claim_top_source ts ON ts.claim_id = cs.result_id
        LEFT JOIN public.captures      cap ON ts.source_type = 'capture'  AND cap.id = ts.source_id
        LEFT JOIN public.document      doc ON ts.source_type = 'document' AND doc.id = ts.source_id
    ),

    -- ============ CAPTURES ============
    capture_fts AS (
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank(c.fts, v_tsquery) DESC)::int AS rnk
        FROM public.captures c
        WHERE c.workspace_id = p_workspace_id AND 'capture' = ANY(p_types)
          AND NOT c.is_eval
          AND v_tsquery IS NOT NULL AND c.fts @@ v_tsquery
          AND (p_since IS NULL OR (c.started_at IS NOT NULL AND c.started_at >= p_since))
          AND (p_until IS NULL OR (c.started_at IS NOT NULL AND c.started_at <= p_until))
          AND (c.visibility = 'workspace' OR (v_requester IS NOT NULL AND c.user_id = v_requester))
        LIMIT p_candidate_k
    ),
    capture_vec AS (
        SELECT id, MIN(rnk)::int AS rnk FROM (
            SELECT cc.capture_id AS id,
                   ROW_NUMBER() OVER (ORDER BY cc.embedding <=> v_embedding) AS rnk
            FROM public.capture_chunks cc
            JOIN public.captures cap ON cap.id = cc.capture_id
            WHERE cc.workspace_id = p_workspace_id AND 'capture' = ANY(p_types) AND v_embedding IS NOT NULL
              AND NOT cap.is_eval
              AND (p_since IS NULL OR (cap.started_at IS NOT NULL AND cap.started_at >= p_since))
              AND (p_until IS NULL OR (cap.started_at IS NOT NULL AND cap.started_at <= p_until))
              AND (cap.visibility = 'workspace' OR (v_requester IS NOT NULL AND cap.user_id = v_requester))
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
            jsonb_build_object(
                'duration_seconds', c.duration_seconds, 'project_id', c.project_id,
                'series_key', c.series_key, 'occurrence_start', c.occurrence_start,
                'calendar_event_id', c.calendar_event_id
            ) AS metadata
        FROM public.captures c
        JOIN capture_union u ON u.id = c.id
        LEFT JOIN capture_fts cf ON cf.id = c.id
        LEFT JOIN capture_vec cv ON cv.id = c.id
        LEFT JOIN capture_recency cr ON cr.id = c.id
        WHERE NOT c.is_eval
          AND (c.visibility = 'workspace' OR (v_requester IS NOT NULL AND c.user_id = v_requester))
    ),

    -- ============ DOCUMENTS (FTS + vector + recency) ============
    -- 365: documents are found wherever they match. No default window reaches
    -- them (the app passes none for documents); an explicit p_since/p_until
    -- filters by updated_at, the last time the text changed, not by when the
    -- document was created. Archived documents are left out. The excerpt is
    -- the passage that matched (the nearest chunk, else the chunk the query's
    -- words rank best in, else a headline around them), with its section.
    document_fts AS (
        SELECT d.id, ROW_NUMBER() OVER (ORDER BY ts_rank(d.fts, v_tsquery) DESC)::int AS rnk
        FROM public.document d
        WHERE d.workspace_id = p_workspace_id AND 'document' = ANY(p_types)
          AND d.status <> 'archived'
          AND v_tsquery IS NOT NULL AND d.fts @@ v_tsquery
          AND (p_since IS NULL OR d.updated_at >= p_since)
          AND (p_until IS NULL OR d.updated_at <= p_until)
        LIMIT p_candidate_k
    ),
    document_vec_chunks AS (
        SELECT dc.document_id AS id, dc.id AS chunk_id,
               ROW_NUMBER() OVER (ORDER BY dc.embedding <=> v_embedding) AS rnk
        FROM public.document_chunks dc
        JOIN public.document d ON d.id = dc.document_id
        WHERE dc.workspace_id = p_workspace_id AND d.workspace_id = p_workspace_id
          AND 'document' = ANY(p_types) AND v_embedding IS NOT NULL
          AND d.status <> 'archived'
          AND (p_since IS NULL OR d.updated_at >= p_since)
          AND (p_until IS NULL OR d.updated_at <= p_until)
        ORDER BY dc.embedding <=> v_embedding
        LIMIT p_candidate_k
    ),
    document_vec AS (
        SELECT DISTINCT ON (id) id, rnk::int AS rnk, chunk_id
        FROM document_vec_chunks
        ORDER BY id, rnk
    ),
    document_union AS (SELECT id FROM document_fts UNION SELECT id FROM document_vec),
    document_recency AS (
        SELECT d.id, ROW_NUMBER() OVER (ORDER BY d.updated_at DESC)::int AS rnk
        FROM public.document d JOIN document_union u ON u.id = d.id
    ),
    document_scored AS (
        SELECT
            d.id AS result_id,
            d.title,
            p_w_fts    * COALESCE(1.0/(60+df.rnk), 0) +
            p_w_vec    * COALESCE(1.0/(60+dv.rnk), 0) +
            p_w_recent * COALESCE(1.0/(60+dr.rnk), 0) AS score,
            d.updated_at AS event_at,
            df.rnk AS fts_rank,
            dv.rnk AS vec_rank,
            dr.rnk AS recency_rank,
            dv.chunk_id,
            d.status,
            d.project_id
        FROM public.document d
        JOIN document_union u ON u.id = d.id
        LEFT JOIN document_fts df ON df.id = d.id
        LEFT JOIN document_vec dv ON dv.id = d.id
        LEFT JOIN document_recency dr ON dr.id = d.id
        ORDER BY score DESC
        LIMIT p_limit
    ),
    -- The passage for each document that can still make the list (at most
    -- p_limit of them, so this costs a few chunk reads, not one per candidate).
    document_final AS (
        SELECT
            'document'::text AS result_type,
            ds.result_id,
            ds.title,
            ds.score,
            ds.event_at,
            ds.fts_rank,
            ds.vec_rank,
            ds.recency_rank,
            COALESCE(passage.chunk_text, LEFT(doc.content, 300)) AS excerpt,
            'Document'::text AS source_label,
            'document'::text AS source_type,
            jsonb_build_object('status', ds.status, 'project_id', ds.project_id)
              || CASE WHEN passage.heading IS NOT NULL THEN jsonb_build_object('section', passage.heading) ELSE '{}'::jsonb END
              AS metadata
        FROM document_scored ds
        JOIN public.document doc ON doc.id = ds.result_id
        LEFT JOIN LATERAL (
            SELECT p.chunk_text, p.heading FROM (
                -- The nearest chunk, when the vectors found the document.
                SELECT dc.chunk_text, dc.heading, 0 AS pick
                FROM public.document_chunks dc
                WHERE dc.id = ds.chunk_id AND dc.workspace_id = p_workspace_id
                UNION ALL
                -- Else the chunk the query's words rank best in.
                SELECT b.chunk_text, b.heading, 1 AS pick FROM (
                    SELECT dc.chunk_text, dc.heading
                    FROM public.document_chunks dc
                    WHERE ds.chunk_id IS NULL AND v_tsquery IS NOT NULL
                      AND dc.document_id = ds.result_id AND dc.workspace_id = p_workspace_id
                      AND to_tsvector('english', dc.chunk_text) @@ v_tsquery
                    ORDER BY ts_rank(to_tsvector('english', dc.chunk_text), v_tsquery) DESC, dc.chunk_index
                    LIMIT 1
                ) b
                UNION ALL
                -- Else (a document with no vectors) a headline around the words.
                SELECT ts_headline('english', doc.content, v_tsquery,
                         'StartSel="",StopSel="",MaxFragments=1,MaxWords=45,MinWords=20,FragmentDelimiter=" … "'),
                       NULL::text, 2 AS pick
                WHERE ds.chunk_id IS NULL AND v_tsquery IS NOT NULL AND doc.content IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM public.document_chunks dc2
                       WHERE dc2.document_id = ds.result_id AND dc2.workspace_id = p_workspace_id
                  )
            ) p
            ORDER BY p.pick
            LIMIT 1
        ) passage ON TRUE
    )

    SELECT * FROM claim_final
    UNION ALL SELECT * FROM capture_final
    UNION ALL SELECT * FROM document_final
    ORDER BY score DESC
    LIMIT p_limit;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.hybrid_search(UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hybrid_search(UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, UUID) TO authenticated, service_role;

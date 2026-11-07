-- 226_recurring_meeting_series.sql
--
-- Recurring-meeting history threads. Providers disagree about event-id
-- semantics (Google/Microsoft: per-occurrence ids; EventKit: one id shared by
-- the whole series), so captures gain their own series identity:
--
--   series_key       — groups all occurrences of one recurring meeting
--                      (Google recurringEventId / Microsoft iCalUId or
--                      seriesMasterId / EventKit's shared eventIdentifier)
--   ical_uid         — iCalendar UID: series-scoped AND identical across
--                      attendees' mailboxes; groups different users' captures
--                      of the same call
--   occurrence_start — pins a capture to one occurrence of the series
--
-- Plus the race guard from-event always lacked: at most ONE live (un-ended)
-- capture per user per event id. Ended captures sharing an event id are the
-- meeting's history, not duplicates — from-event now creates a NEW capture
-- instead of recording into a previous occurrence's locked row.

-- ============================================================
-- 1. Columns
-- ============================================================

ALTER TABLE public.captures ADD COLUMN IF NOT EXISTS series_key TEXT;
ALTER TABLE public.captures ADD COLUMN IF NOT EXISTS ical_uid TEXT;
ALTER TABLE public.captures ADD COLUMN IF NOT EXISTS occurrence_start TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_captures_series_key
    ON public.captures (workspace_id, series_key)
    WHERE series_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_captures_ical_uid
    ON public.captures (workspace_id, ical_uid)
    WHERE ical_uid IS NOT NULL;

-- ============================================================
-- 2. Backfill (best-effort; greenfield — no splitting of historical rows)
-- ============================================================

-- The scheduled start is the occurrence for every event-linked capture.
UPDATE public.captures
SET occurrence_start = scheduled_start
WHERE calendar_event_id IS NOT NULL
  AND occurrence_start IS NULL
  AND scheduled_start IS NOT NULL;

-- Google instance ids embed the series master as a prefix:
-- '<masterId>_20260811T170000Z' (timed) / '<masterId>_20260811' (all-day).
UPDATE public.captures
SET series_key = regexp_replace(calendar_event_id, '_\d{8}(T\d{6}Z)?$', '')
WHERE series_key IS NULL
  AND calendar_event_id ~ '_\d{8}(T\d{6}Z)?$';

-- EventKit: the shared eventIdentifier IS the series key. Recoverable for
-- events still in the desktop-pushed local cache.
UPDATE public.captures c
SET series_key = c.calendar_event_id
WHERE c.series_key IS NULL
  AND c.calendar_event_id IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM public.local_calendar_event l
      WHERE l.external_id = c.calendar_event_id
        AND l.has_recurrence
  );

-- ============================================================
-- 3. One live capture per user per event — dedupe, then enforce
-- ============================================================

-- Close out older duplicate live rows (keep the newest). Setting ended_at
-- fires lock_transcript_on_end, which is exactly what retiring a row means;
-- prevent_transcript_edit only raises when the transcript itself changes.
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY workspace_id, user_id, calendar_event_id
               ORDER BY created_at DESC
           ) AS rn
    FROM public.captures
    WHERE calendar_event_id IS NOT NULL
      AND ended_at IS NULL
      AND status <> 'archived'
)
UPDATE public.captures c
SET ended_at = COALESCE(c.started_at, c.created_at, now())
FROM ranked r
WHERE c.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_captures_live_event_per_user
    ON public.captures (workspace_id, user_id, calendar_event_id)
    WHERE ended_at IS NULL
      AND status <> 'archived'
      AND calendar_event_id IS NOT NULL;

-- ============================================================
-- 4. hybrid_search — body verbatim from 223 with ONE change: the capture
--    branch's metadata jsonb now carries series_key + occurrence_start +
--    calendar_event_id so series threads are visible to retrieval without
--    re-embedding. Signature unchanged (13 args) — grants survive REPLACE.
--    ⚠ Later migrations must copy THIS body, not 223's.
-- ============================================================

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
    v_requester uuid := COALESCE(p_requesting_user_id, auth.uid());
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
                              AND (cap3.visibility = 'workspace'
                                   OR (v_requester IS NOT NULL AND cap3.user_id = v_requester))
                        )
                    )
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
        WHERE c.visibility = 'workspace' OR (v_requester IS NOT NULL AND c.user_id = v_requester)
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

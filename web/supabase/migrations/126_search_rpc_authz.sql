-- Migration 126: Search RPC authorization hardening.
--
-- The Supabase security advisor flags four SECURITY DEFINER search functions
-- as executable by `anon` (Postgres grants EXECUTE to PUBLIC on new functions
-- by default, and these never revoked it):
--
--   match_claims (8-arg, from 117)   — 111 fixed the 7-arg overload, but the
--                                      new overload re-opened the hole
--   rag_search (086)
--   attachment_rag_search (087)
--   unified_search (030)
--
-- Worse than the anon grant: all of them trust their workspace/user id
-- PARAMETERS while bypassing RLS, so any authenticated user could read
-- another workspace's captures/claims/attachments (or another user's chunks)
-- by passing a foreign id. The 7-arg match_claims has correct grants but the
-- same missing in-function check.
--
-- Fix, same pattern as migration 125 (claim_neighborhood):
--   1. REVOKE EXECUTE from PUBLIC and anon on the four exposed functions
--      (re-asserted on the 7-arg match_claims too — idempotent).
--   2. Re-create each function with a gate at the top of the body:
--        - workspace-keyed functions (match_claims x2, unified_search):
--            caller with a JWT identity must be a member of the workspace
--        - user-keyed functions (rag_search, attachment_rag_search — both
--          filter rows by user_id):
--            caller with a JWT identity must BE that user
--      Service-role / background callers carry no auth.uid() and pass
--      through — they scope explicitly and are trusted server code.
--   3. Pin search_path (the 101 hardening; safe here — the pgvector types
--      these functions cast to live in `public`).
--
-- Bodies are otherwise verbatim from the live definitions (DEV, 2026-06-10).

-- ------------------------------------------------------------
-- 1. Grants
-- ------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT, DOUBLE PRECISION) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.rag_search(TEXT, TEXT[], TEXT[], TEXT, INTEGER, DOUBLE PRECISION, TEXT, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.attachment_rag_search(TEXT, TEXT, TEXT, TEXT[], INTEGER, DOUBLE PRECISION) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.unified_search(UUID, TEXT, TEXT[], INTEGER) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT, DOUBLE PRECISION) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rag_search(TEXT, TEXT[], TEXT[], TEXT, INTEGER, DOUBLE PRECISION, TEXT, TIMESTAMPTZ, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attachment_rag_search(TEXT, TEXT, TEXT, TEXT[], INTEGER, DOUBLE PRECISION) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unified_search(UUID, TEXT, TEXT[], INTEGER) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2. match_claims — 7-arg overload (workspace-keyed)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.match_claims(
    p_workspace_id TEXT,
    p_embedding TEXT,
    p_limit INTEGER DEFAULT 10,
    p_threshold DOUBLE PRECISION DEFAULT 0.3,
    p_type TEXT DEFAULT NULL,
    p_confirmation TEXT DEFAULT NULL,
    p_status TEXT DEFAULT 'active'
)
RETURNS TABLE(
    claim_id UUID,
    chunk_id UUID,
    chunk_text TEXT,
    claim_text TEXT,
    claim_type TEXT,
    confirmation TEXT,
    status TEXT,
    confidence REAL,
    similarity DOUBLE PRECISION
) AS $$
DECLARE
    v_workspace_id UUID := p_workspace_id::UUID;
    v_embedding vector(1536) := p_embedding::vector(1536);
BEGIN
    -- End-user calls must belong to the workspace; service-role callers
    -- (no JWT identity) pass through.
    IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(v_workspace_id) THEN
        RETURN;
    END IF;

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ------------------------------------------------------------
-- 3. match_claims — 8-arg overload (workspace-keyed)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.match_claims(
    p_workspace_id TEXT,
    p_embedding TEXT,
    p_limit INTEGER,
    p_threshold DOUBLE PRECISION,
    p_type TEXT,
    p_confirmation TEXT,
    p_status TEXT,
    p_min_confidence DOUBLE PRECISION
)
RETURNS TABLE(
    claim_id UUID,
    chunk_id UUID,
    chunk_text TEXT,
    claim_text TEXT,
    claim_type TEXT,
    confirmation TEXT,
    status TEXT,
    confidence REAL,
    similarity DOUBLE PRECISION
) AS $$
DECLARE
    v_workspace_id UUID := p_workspace_id::UUID;
    v_embedding vector(1536) := p_embedding::vector(1536);
BEGIN
    IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(v_workspace_id) THEN
        RETURN;
    END IF;

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
    JOIN public.claim c ON c.id = cc.claim_id AND c.workspace_id = v_workspace_id
    WHERE cc.workspace_id = v_workspace_id
      AND 1 - (cc.embedding <=> v_embedding) >= p_threshold
      AND (p_type IS NULL OR c.type = p_type)
      AND (p_confirmation IS NULL OR c.confirmation = p_confirmation)
      AND (p_status IS NULL OR c.status = p_status)
      AND (p_min_confidence IS NULL OR (c.confidence IS NOT NULL AND c.confidence >= p_min_confidence))
    ORDER BY cc.embedding <=> v_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ------------------------------------------------------------
-- 4. rag_search (user-keyed: rows are filtered by cc.user_id)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_search(
    p_user_id TEXT,
    p_project_ids TEXT[],
    p_note_ids TEXT[],
    p_embedding TEXT,
    p_limit INTEGER DEFAULT 10,
    p_threshold DOUBLE PRECISION DEFAULT 0.0,
    p_workspace_id TEXT DEFAULT NULL,
    p_created_after TIMESTAMPTZ DEFAULT NULL,
    p_include_transcripts BOOLEAN DEFAULT TRUE
)
RETURNS TABLE(
    chunk_id UUID,
    capture_id UUID,
    project_id UUID,
    chunk_text TEXT,
    chunk_index INTEGER,
    capture_title TEXT,
    similarity DOUBLE PRECISION
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
    -- This function is user-keyed: an end-user caller may only search as
    -- themselves. Service-role callers (no JWT identity) pass through.
    IF auth.uid() IS NOT NULL AND auth.uid() <> v_user_id THEN
        RETURN;
    END IF;

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
        1 - (cc.embedding <=> v_embedding) as similarity
    FROM capture_chunks cc
    JOIN captures c ON c.id = cc.capture_id
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ------------------------------------------------------------
-- 5. attachment_rag_search (user-keyed: rows are filtered by ac.user_id)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.attachment_rag_search(
    p_user_id TEXT,
    p_embedding TEXT,
    p_workspace_id TEXT DEFAULT NULL,
    p_project_ids TEXT[] DEFAULT '{}',
    p_limit INTEGER DEFAULT 10,
    p_threshold DOUBLE PRECISION DEFAULT 0.3
)
RETURNS TABLE(
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
    similarity DOUBLE PRECISION
) AS $$
DECLARE
    v_user_id UUID := p_user_id::UUID;
    v_embedding halfvec(3072) := p_embedding::halfvec(3072);
    v_workspace_id UUID := CASE WHEN p_workspace_id IS NOT NULL THEN p_workspace_id::UUID ELSE NULL END;
    v_has_project_filter BOOLEAN := COALESCE(array_length(p_project_ids, 1), 0) > 0;
    v_project_ids UUID[];
BEGIN
    IF auth.uid() IS NOT NULL AND auth.uid() <> v_user_id THEN
        RETURN;
    END IF;

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ------------------------------------------------------------
-- 6. unified_search (workspace-keyed)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.unified_search(
    p_workspace_id UUID,
    p_query TEXT,
    p_types TEXT[] DEFAULT ARRAY['action', 'capture', 'document', 'project', 'decision', 'claim'],
    p_limit INTEGER DEFAULT 20
)
RETURNS TABLE(
    result_type TEXT,
    result_id UUID,
    title TEXT,
    subtitle TEXT,
    icon TEXT,
    rank REAL,
    metadata JSONB
) AS $$
DECLARE
  v_tsquery tsquery;
  v_identifier_pattern text;
  v_is_identifier bool;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(p_workspace_id) THEN
    RETURN;
  END IF;

  v_is_identifier := p_query ~ '^[A-Za-z]+-[0-9]+$';
  v_identifier_pattern := upper(p_query) || '%';

  BEGIN
    v_tsquery := websearch_to_tsquery('english', p_query);
  EXCEPTION WHEN OTHERS THEN
    v_tsquery := NULL;
  END;

  IF v_tsquery IS NULL AND NOT v_is_identifier THEN
    RETURN;
  END IF;

  RETURN QUERY

  SELECT
    'action'::text AS result_type,
    a.id AS result_id,
    a.title,
    COALESCE(ws.name, '') AS subtitle,
    a.identifier AS icon,
    CASE
      WHEN v_is_identifier AND upper(a.identifier) LIKE v_identifier_pattern THEN 2.0
      WHEN v_tsquery IS NOT NULL THEN ts_rank(a.fts, v_tsquery)
      ELSE 0.0
    END AS rank,
    jsonb_build_object(
      'identifier', a.identifier,
      'status_id', a.status_id,
      'status_name', ws.name,
      'priority', a.priority,
      'assignee_id', a.assignee_id,
      'team_id', a.team_id
    ) AS metadata
  FROM public.actions a
  JOIN public.team t ON t.id = a.team_id
  LEFT JOIN public.workflow_state ws ON ws.id = a.status_id
  WHERE t.workspace_id = p_workspace_id
    AND 'action' = ANY(p_types)
    AND (
      (v_is_identifier AND upper(a.identifier) LIKE v_identifier_pattern)
      OR (v_tsquery IS NOT NULL AND a.fts @@ v_tsquery)
    )

  UNION ALL

  SELECT
    'capture'::text,
    c.id,
    c.title,
    'Capture'::text AS subtitle,
    ''::text AS icon,
    CASE WHEN v_tsquery IS NOT NULL THEN ts_rank(c.fts, v_tsquery) ELSE 0.0 END AS rank,
    jsonb_build_object(
      'started_at', c.started_at,
      'duration_seconds', c.duration_seconds
    ) AS metadata
  FROM public.captures c
  WHERE c.workspace_id = p_workspace_id
    AND 'capture' = ANY(p_types)
    AND v_tsquery IS NOT NULL
    AND c.fts @@ v_tsquery

  UNION ALL

  SELECT
    'document'::text,
    d.id,
    d.title,
    'Document' AS subtitle,
    '' AS icon,
    CASE WHEN v_tsquery IS NOT NULL THEN ts_rank(d.fts, v_tsquery) ELSE 0.0 END AS rank,
    jsonb_build_object(
      'status', d.status,
      'project_id', d.project_id,
      'is_pinned', d.is_pinned
    ) AS metadata
  FROM public.document d
  WHERE d.workspace_id = p_workspace_id
    AND 'document' = ANY(p_types)
    AND v_tsquery IS NOT NULL
    AND d.fts @@ v_tsquery

  UNION ALL

  SELECT
    'project'::text,
    p.id,
    p.name AS title,
    COALESCE(p.status::text, 'active') AS subtitle,
    '' AS icon,
    CASE WHEN v_tsquery IS NOT NULL THEN ts_rank(p.fts, v_tsquery) ELSE 0.0 END AS rank,
    jsonb_build_object(
      'status', p.status,
      'lead_id', p.lead_id
    ) AS metadata
  FROM public.projects p
  WHERE p.workspace_id = p_workspace_id
    AND 'project' = ANY(p_types)
    AND v_tsquery IS NOT NULL
    AND p.fts @@ v_tsquery

  UNION ALL

  SELECT
    'decision'::text,
    dec.id,
    LEFT(dec.content, 100) AS title,
    'Decision' AS subtitle,
    '' AS icon,
    CASE WHEN v_tsquery IS NOT NULL THEN ts_rank(dec.fts, v_tsquery) ELSE 0.0 END AS rank,
    jsonb_build_object(
      'capture_id', dec.capture_id,
      'confirmation', dec.confirmation,
      'project_id', dec.project_id
    ) AS metadata
  FROM public.decision dec
  JOIN public.captures c ON c.id = dec.capture_id
  WHERE c.workspace_id = p_workspace_id
    AND 'decision' = ANY(p_types)
    AND v_tsquery IS NOT NULL
    AND dec.fts @@ v_tsquery

  UNION ALL

  SELECT
    'claim'::text,
    cl.id,
    LEFT(cl.text, 100) AS title,
    'Claim' AS subtitle,
    cl.type AS icon,
    CASE WHEN v_tsquery IS NOT NULL THEN ts_rank(cl.fts, v_tsquery) ELSE 0.0 END AS rank,
    jsonb_build_object(
      'type', cl.type,
      'confirmation', cl.confirmation,
      'status', cl.status,
      'confidence', cl.confidence
    ) AS metadata
  FROM public.claim cl
  WHERE cl.workspace_id = p_workspace_id
    AND 'claim' = ANY(p_types)
    AND cl.status = 'active'
    AND cl.confirmation <> 'dismissed'
    AND v_tsquery IS NOT NULL
    AND cl.fts @@ v_tsquery

  ORDER BY rank DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

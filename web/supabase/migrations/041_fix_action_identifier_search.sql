-- Migration 041: Fix action identifier search
-- Problem: the actions fts column only indexes title + description, so searching
-- "GEN-802" never matches because identifiers are not in the tsvector and
-- websearch_to_tsquery('english', 'GEN-802') does not tokenize hyphenated IDs well.
--
-- Fix:
--   1. Rebuild the actions fts column to include identifier (weight A, same as title)
--   2. Update unified_search to also do an exact/prefix ilike match on identifier
--      so "GEN-802" always returns the right action regardless of FTS tokenization.

-- ============================================================
-- 1. Rebuild actions fts column to include identifier
-- ============================================================

ALTER TABLE public.actions DROP COLUMN IF EXISTS fts;

ALTER TABLE public.actions ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(identifier, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS actions_fts_idx ON public.actions USING gin (fts);

-- Also add a plain btree index on identifier for fast ilike prefix scans
CREATE INDEX IF NOT EXISTS actions_identifier_idx ON public.actions (identifier);

-- ============================================================
-- 2. Update unified_search to match identifiers directly
-- ============================================================

CREATE OR REPLACE FUNCTION public.unified_search(
  p_workspace_id uuid,
  p_query text,
  p_types text[] DEFAULT ARRAY['action', 'capture', 'document', 'project', 'decision'],
  p_limit int DEFAULT 20
)
RETURNS TABLE (
  result_type text,
  result_id uuid,
  title text,
  subtitle text,
  icon text,
  rank real,
  metadata jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tsquery tsquery;
  v_identifier_pattern text;
  v_is_identifier bool;
BEGIN
  -- Detect identifier pattern like "GEN-802" or "ENG-42" (letters-digits)
  v_is_identifier := p_query ~ '^[A-Za-z]+-[0-9]+$';
  v_identifier_pattern := upper(p_query) || '%';

  -- Build tsquery; may be NULL for pure identifier queries
  BEGIN
    v_tsquery := websearch_to_tsquery('english', p_query);
  EXCEPTION WHEN OTHERS THEN
    v_tsquery := NULL;
  END;

  -- Need at least one matching strategy
  IF v_tsquery IS NULL AND NOT v_is_identifier THEN
    RETURN;
  END IF;

  RETURN QUERY

  -- Actions: match by identifier (exact/prefix) OR by FTS
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

  -- Captures
  SELECT
    'capture'::text,
    c.id,
    c.title,
    COALESCE(r.name, 'Capture') AS subtitle,
    COALESCE(r.icon, '') AS icon,
    CASE WHEN v_tsquery IS NOT NULL THEN ts_rank(c.fts, v_tsquery) ELSE 0.0 END AS rank,
    jsonb_build_object(
      'recipe_name', r.name,
      'recipe_icon', r.icon,
      'started_at', c.started_at,
      'duration_seconds', c.duration_seconds
    ) AS metadata
  FROM public.captures c
  LEFT JOIN public.recipe r ON r.id = c.recipe_id
  WHERE c.workspace_id = p_workspace_id
    AND 'capture' = ANY(p_types)
    AND v_tsquery IS NOT NULL
    AND c.fts @@ v_tsquery

  UNION ALL

  -- Documents
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

  -- Projects
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

  -- Decisions
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

  ORDER BY rank DESC
  LIMIT p_limit;
END;
$$;

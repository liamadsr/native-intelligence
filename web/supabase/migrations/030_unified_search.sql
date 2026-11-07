-- Migration 030: Unified Search
-- Adds FTS (full-text search) tsvector columns to captures, projects, and decision tables.
-- Creates a unified_search RPC function for cross-object-type search.
-- Idempotent: safe to re-run.

-- ============================================================
-- 1. Add FTS columns to captures, projects, decision
-- ============================================================

-- Captures: title (A), content/user_notes (B), transcript + ai_summary (C)
ALTER TABLE public.captures ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(user_notes, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(transcript, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(ai_summary, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS captures_fts_idx ON public.captures USING gin (fts);

-- Projects: name (A), description (B)
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS projects_fts_idx ON public.projects USING gin (fts);

-- Decision: content only
ALTER TABLE public.decision ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(content, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS decision_fts_idx ON public.decision USING gin (fts);

-- ============================================================
-- 2. Unified search RPC function
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
BEGIN
  -- Build tsquery from search string (handles natural language, quoted phrases, negation)
  v_tsquery := websearch_to_tsquery('english', p_query);

  IF v_tsquery IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY

  -- Actions
  SELECT
    'action'::text AS result_type,
    a.id AS result_id,
    a.title,
    COALESCE(ws.name, '') AS subtitle,
    a.identifier AS icon,
    ts_rank(a.fts, v_tsquery) AS rank,
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
    AND a.fts @@ v_tsquery

  UNION ALL

  -- Captures
  SELECT
    'capture'::text,
    c.id,
    c.title,
    COALESCE(r.name, 'Capture') AS subtitle,
    COALESCE(r.icon, '') AS icon,
    ts_rank(c.fts, v_tsquery) AS rank,
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
    AND c.fts @@ v_tsquery

  UNION ALL

  -- Documents
  SELECT
    'document'::text,
    d.id,
    d.title,
    'Document' AS subtitle,
    '' AS icon,
    ts_rank(d.fts, v_tsquery) AS rank,
    jsonb_build_object(
      'status', d.status,
      'project_id', d.project_id,
      'is_pinned', d.is_pinned
    ) AS metadata
  FROM public.document d
  WHERE d.workspace_id = p_workspace_id
    AND 'document' = ANY(p_types)
    AND d.fts @@ v_tsquery

  UNION ALL

  -- Projects
  SELECT
    'project'::text,
    p.id,
    p.name AS title,
    COALESCE(p.status::text, 'active') AS subtitle,
    '' AS icon,
    ts_rank(p.fts, v_tsquery) AS rank,
    jsonb_build_object(
      'status', p.status,
      'lead_id', p.lead_id
    ) AS metadata
  FROM public.projects p
  WHERE p.workspace_id = p_workspace_id
    AND 'project' = ANY(p_types)
    AND p.fts @@ v_tsquery

  UNION ALL

  -- Decisions
  SELECT
    'decision'::text,
    dec.id,
    LEFT(dec.content, 100) AS title,
    'Decision' AS subtitle,
    '' AS icon,
    ts_rank(dec.fts, v_tsquery) AS rank,
    jsonb_build_object(
      'capture_id', dec.capture_id,
      'confirmation', dec.confirmation,
      'project_id', dec.project_id
    ) AS metadata
  FROM public.decision dec
  JOIN public.captures c ON c.id = dec.capture_id
  WHERE c.workspace_id = p_workspace_id
    AND 'decision' = ANY(p_types)
    AND dec.fts @@ v_tsquery

  ORDER BY rank DESC
  LIMIT p_limit;
END;
$$;

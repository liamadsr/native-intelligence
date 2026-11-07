-- ============================================================================
-- Migration 119: Remove the "meeting type" concept end to end
--
-- The capture-agent model is being unified to a single concept: an `agent`
-- (category='agent'), with the built-in "Assistant" as the default. Meeting
-- types (category='meeting_type') are removed entirely — they were a near-dead,
-- prompt-bearing template that only leaked into capture processing via Reprocess
-- and duplicated the agent surface.
--
-- This migration is destructive by design (the app has ~0 users and no
-- backwards-compatibility constraint):
--   1. Redefine rag_search + unified_search to drop the captures.recipe_id join.
--   2. Drop captures.recipe_id (column, index, FK).
--   3. Convert any remaining meeting_type recipe rows to agent, then remove the
--      'meeting_type' value from the recipe_category enum and set the column
--      default to 'agent'.
--   4. Demote the seeded "Project Manager" agent's is_default flag (the built-in
--      Assistant is the default; no recipe row should imply otherwise).
--   5. Drop the dead migration-053 meeting_agent tables (zero code references).
--
-- DEV ONLY for now (project edrjddsxjoigpbecqgfb). Apply to PRD before the
-- branch merges, like the other pending migrations.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1a. rag_search — drop the recipe join + the recipe_name output column.
--     Faithful copy of migration 086's definition with the recipe pieces removed.
-- ────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.rag_search(TEXT, TEXT[], TEXT[], TEXT, INTEGER, FLOAT, TEXT, TIMESTAMPTZ, BOOLEAN);

CREATE OR REPLACE FUNCTION rag_search(
    p_user_id TEXT,
    p_project_ids TEXT[],
    p_note_ids TEXT[],
    p_embedding TEXT,
    p_limit INTEGER DEFAULT 10,
    p_threshold FLOAT DEFAULT 0.0,
    p_workspace_id TEXT DEFAULT NULL,
    p_created_after TIMESTAMPTZ DEFAULT NULL,
    p_include_transcripts BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
    chunk_id UUID,
    capture_id UUID,
    project_id UUID,
    chunk_text TEXT,
    chunk_index INTEGER,
    capture_title TEXT,
    similarity FLOAT
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION rag_search(TEXT, TEXT[], TEXT[], TEXT, INTEGER, FLOAT, TEXT, TIMESTAMPTZ, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION rag_search(TEXT, TEXT[], TEXT[], TEXT, INTEGER, FLOAT, TEXT, TIMESTAMPTZ, BOOLEAN) TO anon;

-- ────────────────────────────────────────────────────────────────────────────
-- 1b. unified_search — drop the recipe join in the Captures branch only.
--     Faithful copy of migration 116; the Captures UNION branch now uses a
--     static 'Capture' subtitle / no icon and drops recipe_* from metadata.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.unified_search(
  p_workspace_id uuid,
  p_query text,
  p_types text[] DEFAULT ARRAY['action'::text, 'capture'::text, 'document'::text, 'project'::text, 'decision'::text, 'claim'::text],
  p_limit integer DEFAULT 20
)
RETURNS TABLE(result_type text, result_id uuid, title text, subtitle text, icon text, rank real, metadata jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_tsquery tsquery;
  v_identifier_pattern text;
  v_is_identifier bool;
BEGIN
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

  -- Captures (meeting_type removed — no recipe join)
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

  UNION ALL

  -- Claims: active, non-dismissed claims via FTS.
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
$function$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Drop captures.recipe_id (index + FK go with it).
-- ────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS public.captures_recipe_idx;
ALTER TABLE public.captures DROP COLUMN IF EXISTS recipe_id;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Collapse the recipe_category enum: convert meeting_type rows to agent,
--    then remove the 'meeting_type' value. Postgres can't DROP an enum value, so
--    recreate the type. First neutralize the column default + any dependents.
-- ────────────────────────────────────────────────────────────────────────────

-- Convert remaining meeting_type recipes to agent (system templates included —
-- they become plain agents; the built-in Assistant remains the default persona).
UPDATE public.recipe SET category = 'agent' WHERE category = 'meeting_type';

-- Drop the default so we can swap the enum type without a cast conflict.
ALTER TABLE public.recipe ALTER COLUMN category DROP DEFAULT;

-- Recreate the enum without 'meeting_type'.
ALTER TYPE public.recipe_category RENAME TO recipe_category_old;
CREATE TYPE public.recipe_category AS ENUM ('skill', 'agent');
ALTER TABLE public.recipe
  ALTER COLUMN category TYPE public.recipe_category
  USING category::text::public.recipe_category;
DROP TYPE public.recipe_category_old;

-- New default: agent.
ALTER TABLE public.recipe ALTER COLUMN category SET DEFAULT 'agent';

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Demote the seeded "Project Manager" agent — the built-in Assistant is the
--    default; no recipe row should be is_default (nothing reads it now, but keep
--    the data honest).
-- ────────────────────────────────────────────────────────────────────────────
UPDATE public.recipe SET is_default = false WHERE is_default = true;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Drop the dead migration-053 "meeting agent" tables (zero code references;
--    superseded by the stateless live-agent + proposed_change design).
-- ────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS public.meeting_agent_event CASCADE;
DROP TABLE IF EXISTS public.meeting_proposed_action CASCADE;
DROP TABLE IF EXISTS public.meeting_session CASCADE;

-- ============================================================
-- Migration 117: Smart Capture — auto-accept by confidence,
-- user-scoped action capture, and a more connected knowledge graph.
--
-- This migration is deliberately IDEMPOTENT and DEFENSIVE:
--   * every ADD COLUMN uses IF NOT EXISTS
--   * CHECK/relation widenings are guarded by DO blocks
--   * it backfills only where the new column was just added
-- Several `actions` columns already exist in the live DB but in NO tracked
-- migration (ai_confidence, context_data, source_type, source_capture_id,
-- sort_order, dismiss_reason). We add them IF NOT EXISTS so a rebuild from
-- migrations matches production without clobbering existing data.
--
-- NOT applied automatically — run manually after review (per repo convention:
-- migrations are manual + the migration history table is untracked).
-- ============================================================

-- ------------------------------------------------------------
-- 0. Capture drifted `actions` columns so a from-migrations rebuild has them.
--    All match the live defaults observed via DB introspection.
-- ------------------------------------------------------------
ALTER TABLE public.actions
  ADD COLUMN IF NOT EXISTS ai_confidence REAL DEFAULT 1.0;
ALTER TABLE public.actions
  ADD COLUMN IF NOT EXISTS context_data JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.actions
  ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'user';
ALTER TABLE public.actions
  ADD COLUMN IF NOT EXISTS source_capture_id UUID;
ALTER TABLE public.actions
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.actions
  ADD COLUMN IF NOT EXISTS dismiss_reason TEXT;

-- ------------------------------------------------------------
-- 1. claim: who the claim is ABOUT (subject) + scope.
--    `created_by` is the AUTHOR (the member/agent that recorded the claim).
--    `subject_member_id` is the person the claim concerns — e.g. the owner of
--    a commitment ("Sarah committed to X"). This is what makes user-scoped
--    capture possible: "claims about me" vs "my action items".
-- ------------------------------------------------------------
ALTER TABLE public.claim
  ADD COLUMN IF NOT EXISTS subject_member_id UUID REFERENCES public.member(id) ON DELETE SET NULL;

-- scope: 'workspace' = general workspace knowledge (default, unchanged behavior)
--        'personal'  = a claim specifically about / owned by subject_member_id
ALTER TABLE public.claim
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'workspace';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'claim_scope_check'
  ) THEN
    ALTER TABLE public.claim
      ADD CONSTRAINT claim_scope_check CHECK (scope IN ('workspace', 'personal'));
  END IF;
END $$;

-- auto_accepted: marks a claim that was confirmed automatically by the
-- confidence policy (vs. a human confirm). Lets the UI show "auto-accepted ·
-- undo" and lets us audit / tune thresholds later.
ALTER TABLE public.claim
  ADD COLUMN IF NOT EXISTS auto_accepted BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_claim_workspace_subject
  ON public.claim (workspace_id, subject_member_id)
  WHERE subject_member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claim_workspace_scope
  ON public.claim (workspace_id, scope);

-- ------------------------------------------------------------
-- 2. claim_source.workspace_id — kills the id-chunked reads in the knowledge
--    route. Backfill from the parent claim, then index. (Kept NULLABLE so the
--    add never fails on existing rows; the app always writes it going forward.)
-- ------------------------------------------------------------
ALTER TABLE public.claim_source
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspace(id) ON DELETE CASCADE;

UPDATE public.claim_source cs
  SET workspace_id = c.workspace_id
  FROM public.claim c
  WHERE cs.claim_id = c.id
    AND cs.workspace_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_claim_source_workspace
  ON public.claim_source (workspace_id);

-- claim_source.source_type CHECK was ('capture','attachment','document','email',
-- 'external_url','manual') in migration 109, but attachClaimProvenance has long
-- written 'project','contact','action' source rows (the cross-populated evidence
-- for cites/about edges to those entities — and the fold step now writes 'action'
-- explicitly). Those upserts were silently failing the CHECK (the helper swallows
-- the error), so that evidence never materialized. Widen the constraint to match
-- the writers (CITABLE_SOURCE_TYPES in claim-provenance.ts).
DO $$
DECLARE
  conname_var TEXT;
BEGIN
  SELECT con.conname INTO conname_var
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'claim_source'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%source_type %IN%'
  ORDER BY con.conname
  LIMIT 1;

  IF conname_var IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.claim_source DROP CONSTRAINT %I', conname_var);
  END IF;

  ALTER TABLE public.claim_source DROP CONSTRAINT IF EXISTS claim_source_source_type_check;

  ALTER TABLE public.claim_source
    ADD CONSTRAINT claim_source_source_type_check CHECK (source_type IN (
      'capture', 'attachment', 'document', 'email', 'external_url', 'manual',
      'project', 'contact', 'action'
    ));
END $$;

-- ------------------------------------------------------------
-- 3. auto_accepted audit flags — set when the live agent's confidence policy
--    applied an item without a human click.
--    * actions.auto_accepted   — the created action
--    * decision.auto_accepted  — the created decision (no other "auto" signal
--      exists on decisions; confirmation alone can't distinguish auto vs manual)
--    * proposed_change.auto_accepted — the staging row, so the capture UI can
--      badge applied proposals as auto-accepted without joining to the entity
-- ------------------------------------------------------------
ALTER TABLE public.actions
  ADD COLUMN IF NOT EXISTS auto_accepted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.decision
  ADD COLUMN IF NOT EXISTS auto_accepted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.proposed_change
  ADD COLUMN IF NOT EXISTS auto_accepted BOOLEAN NOT NULL DEFAULT false;

-- ------------------------------------------------------------
-- 4. entity_link.relation — add ownership relations so member↔action and
--    member↔claim ownership are first-class edges (powers "what is X working
--    on" / "what did X commit to" graph queries). Rebuild the CHECK to include
--    the new relations without dropping the old ones.
-- ------------------------------------------------------------
DO $$
DECLARE
  conname_var TEXT;
BEGIN
  -- Find the CHECK constraint that gates `relation`. Match by the constraint
  -- DEFINITION referencing the relation column, but bound with LIMIT 1 so a
  -- future second matching constraint can't raise TOO_MANY_ROWS and abort the
  -- migration. We drop whatever we find (its name varies: the original was the
  -- auto-generated entity_link_relation_check) and re-add a known-named one.
  SELECT con.conname INTO conname_var
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'entity_link'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%relation %IN%'
  ORDER BY con.conname
  LIMIT 1;

  IF conname_var IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.entity_link DROP CONSTRAINT %I', conname_var);
  END IF;

  -- Idempotent: drop our target name too in case a prior run of THIS migration
  -- already created it (so re-running doesn't fail on a duplicate constraint).
  ALTER TABLE public.entity_link DROP CONSTRAINT IF EXISTS entity_link_relation_check;

  ALTER TABLE public.entity_link
    ADD CONSTRAINT entity_link_relation_check CHECK (relation IN (
      'mentions', 'depends_on', 'supersedes', 'authored_by',
      'cites', 'about', 'related_to', 'contradicts',
      'owns', 'committed_to'
    ));
END $$;

-- ------------------------------------------------------------
-- 5. match_claims — add an optional p_min_confidence filter so agent semantic
--    search can prefer high-confidence claims and keep context lean. Backward
--    compatible: a NEW overload (extra trailing arg). The original 7-arg
--    function stays so existing callers (claim-extraction dedupe) are untouched.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_claims(
    p_workspace_id TEXT,
    p_embedding TEXT,
    p_limit INTEGER,
    p_threshold FLOAT,
    p_type TEXT,
    p_confirmation TEXT,
    p_status TEXT,
    p_min_confidence FLOAT
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
    -- claim_chunks holds OpenAI vector(1536) after migration 113. Cast once and
    -- reuse, matching the 7-arg function in 113. (Keep in sync with 113 if the
    -- embedding type ever changes again.)
    v_embedding vector(1536) := p_embedding::vector(1536);
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, FLOAT, TEXT, TEXT, TEXT, FLOAT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, FLOAT, TEXT, TEXT, TEXT, FLOAT) TO service_role;

-- Complete the grants on the original 7-arg overload too: migration 113 only
-- re-granted `authenticated`, so on a from-migrations rebuild the service-role
-- client couldn't call it. All current callers use the 8-arg overload above, but
-- keep the 7-arg one fully granted for any legacy/direct caller. (Guarded: the
-- function exists from 109/113.)
DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, FLOAT, TEXT, TEXT, TEXT) TO service_role;
EXCEPTION WHEN undefined_function THEN
  -- 7-arg overload not present on this DB — nothing to grant.
  NULL;
END $$;

-- ------------------------------------------------------------
-- 6. claim_neighborhood — a 2-hop connected subgraph in ONE round-trip, so an
--    agent can assemble context for an entity without a get_claim → traverse →
--    get_* loop. Returns nodes (claims + linked entities) and edges, with
--    resolved labels for citable entity types. SECURITY DEFINER + explicit
--    workspace scoping (the function only ever reads rows in p_workspace_id).
--
--    Returns a single JSONB document:
--      { center: {type,id}, depth, nodes: [...], edges: [...] }
--    nodes: { node_type, node_id, label, claim_text?, confidence?, confirmation? }
--    edges: { source_type, source_id, target_type, target_id, relation }
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_neighborhood(
    p_workspace_id TEXT,
    p_entity_type TEXT,
    p_entity_id TEXT,
    p_depth INTEGER DEFAULT 2,
    p_limit INTEGER DEFAULT 60
)
RETURNS JSONB AS $$
DECLARE
    v_workspace_id UUID;
    v_center_id UUID;
    v_depth INTEGER := LEAST(GREATEST(COALESCE(p_depth, 2), 1), 3);
    v_edges JSONB;
    v_nodes JSONB;
BEGIN
    -- Defensive: malformed ids return an empty bundle rather than erroring out
    -- the caller's tool turn.
    BEGIN
        v_workspace_id := p_workspace_id::UUID;
        v_center_id := p_entity_id::UUID;
    EXCEPTION WHEN others THEN
        RETURN jsonb_build_object(
            'center', jsonb_build_object('type', p_entity_type, 'id', p_entity_id),
            'depth', v_depth,
            'nodes', '[]'::jsonb,
            'edges', '[]'::jsonb
        );
    END;
    -- Collect edges within v_depth hops of the center using a recursive walk
    -- over entity_link (both directions). A `visited` path-array stops a node
    -- from being expanded more than once: without it, UNION dedups on
    -- (type,id,hop) so the same node re-enters at each hop and re-fans-out,
    -- making the walk O(degree^depth). The anti-membership check (NOT
    -- node_key = ANY(visited)) keeps each node's expansion to a single round.
    WITH RECURSIVE frontier AS (
        -- depth 0: the center node, as both possible endpoints
        SELECT
            p_entity_type AS node_type,
            v_center_id AS node_id,
            0 AS hop,
            ARRAY[p_entity_type || ':' || v_center_id::text] AS visited
        UNION ALL
        SELECT
            nxt.node_type,
            nxt.node_id,
            f.hop + 1,
            f.visited || (nxt.node_type || ':' || nxt.node_id::text)
        FROM frontier f
        JOIN LATERAL (
            SELECT
                CASE WHEN el.source_type = f.node_type AND el.source_id = f.node_id
                     THEN el.target_type ELSE el.source_type END AS node_type,
                CASE WHEN el.source_type = f.node_type AND el.source_id = f.node_id
                     THEN el.target_id ELSE el.source_id END AS node_id
            FROM public.entity_link el
            WHERE el.workspace_id = v_workspace_id
              AND (
                   (el.source_type = f.node_type AND el.source_id = f.node_id)
                OR (el.target_type = f.node_type AND el.target_id = f.node_id)
              )
        ) nxt ON true
        WHERE f.hop < v_depth
          AND NOT ((nxt.node_type || ':' || nxt.node_id::text) = ANY(f.visited))
    ),
    reached AS (
        SELECT DISTINCT node_type, node_id FROM frontier
    ),
    edges AS (
        SELECT
            el.source_type, el.source_id, el.target_type, el.target_id, el.relation
        FROM public.entity_link el
        JOIN reached rs ON rs.node_type = el.source_type AND rs.node_id = el.source_id
        JOIN reached rt ON rt.node_type = el.target_type AND rt.node_id = el.target_id
        WHERE el.workspace_id = v_workspace_id
        GROUP BY el.source_type, el.source_id, el.target_type, el.target_id, el.relation
        -- Deterministic ordering so the p_limit truncation is stable across calls.
        ORDER BY el.source_type, el.source_id, el.target_type, el.target_id, el.relation
        LIMIT p_limit
    )
    SELECT jsonb_agg(jsonb_build_object(
        'source_type', e.source_type,
        'source_id', e.source_id,
        'target_type', e.target_type,
        'target_id', e.target_id,
        'relation', e.relation
    )) INTO v_edges FROM edges e;

    -- Build node list from every endpoint that appears in the kept edges,
    -- plus the center. Resolve claim text/confidence for claim nodes and
    -- labels for citable entities.
    WITH endpoints AS (
        SELECT DISTINCT node_type, node_id FROM (
            SELECT (e->>'source_type') AS node_type, (e->>'source_id')::uuid AS node_id
            FROM jsonb_array_elements(COALESCE(v_edges, '[]'::jsonb)) e
            UNION
            SELECT (e->>'target_type'), (e->>'target_id')::uuid
            FROM jsonb_array_elements(COALESCE(v_edges, '[]'::jsonb)) e
            UNION
            SELECT p_entity_type, v_center_id
        ) u
    )
    SELECT jsonb_agg(jsonb_build_object(
        'node_type', ep.node_type,
        'node_id', ep.node_id,
        'label', CASE ep.node_type
            WHEN 'claim'   THEN LEFT(cl.text, 140)
            WHEN 'capture' THEN cap.title
            WHEN 'document'THEN doc.title
            WHEN 'project' THEN prj.name
            WHEN 'action'  THEN act.title
            WHEN 'contact' THEN con.full_name
            WHEN 'member'  THEN mem.display_name
            ELSE NULL END,
        'claim_text',   CASE WHEN ep.node_type = 'claim' THEN cl.text ELSE NULL END,
        'claim_type',   CASE WHEN ep.node_type = 'claim' THEN cl.type ELSE NULL END,
        'confidence',   CASE WHEN ep.node_type = 'claim' THEN cl.confidence ELSE NULL END,
        'confirmation', CASE WHEN ep.node_type = 'claim' THEN cl.confirmation ELSE NULL END
    )) INTO v_nodes
    FROM endpoints ep
    LEFT JOIN public.claim    cl  ON ep.node_type = 'claim'    AND cl.id  = ep.node_id AND cl.workspace_id = v_workspace_id
    LEFT JOIN public.captures cap ON ep.node_type = 'capture'  AND cap.id = ep.node_id AND cap.workspace_id = v_workspace_id
    LEFT JOIN public.document doc ON ep.node_type = 'document' AND doc.id = ep.node_id AND doc.workspace_id = v_workspace_id
    LEFT JOIN public.projects prj ON ep.node_type = 'project'  AND prj.id = ep.node_id AND prj.workspace_id = v_workspace_id
    LEFT JOIN public.actions  act ON ep.node_type = 'action'   AND act.id = ep.node_id AND act.workspace_id = v_workspace_id
    LEFT JOIN public.contact  con ON ep.node_type = 'contact'  AND con.id = ep.node_id AND con.workspace_id = v_workspace_id
    LEFT JOIN public.member   mem ON ep.node_type = 'member'   AND mem.id = ep.node_id AND mem.workspace_id = v_workspace_id;

    RETURN jsonb_build_object(
        'center', jsonb_build_object('type', p_entity_type, 'id', v_center_id),
        'depth', v_depth,
        'nodes', COALESCE(v_nodes, '[]'::jsonb),
        'edges', COALESCE(v_edges, '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.claim_neighborhood(TEXT, TEXT, TEXT, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_neighborhood(TEXT, TEXT, TEXT, INTEGER, INTEGER) TO service_role;

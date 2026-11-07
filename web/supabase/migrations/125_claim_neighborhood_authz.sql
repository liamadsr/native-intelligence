-- Migration 125: claim_neighborhood authorization hardening.
--
-- The Supabase security advisor flagged claim_neighborhood as executable by
-- `anon` (Postgres grants EXECUTE to PUBLIC on new functions by default —
-- the same hole migration 111 closed for the 7-arg match_claims). Worse, the
-- function is SECURITY DEFINER and trusts its p_workspace_id argument: any
-- authenticated user could read another workspace's graph by passing its id.
--
-- Fix, mirroring 111's posture plus an in-function membership gate:
--   1. REVOKE from PUBLIC and anon; keep authenticated + service_role.
--   2. Inside the function: when a JWT identity exists (auth.uid() IS NOT
--      NULL — i.e. an end-user call through PostgREST), require workspace
--      membership. Service-role calls (the MCP server, background jobs) have
--      no JWT identity and pass through — they scope explicitly by
--      workspace_id and are trusted server code.
--
-- NOTE: the advisor shows the same anon-executable warning on match_claims
-- (8-arg overload from 117), rag_search, attachment_rag_search, and
-- unified_search — those predate this work and deserve the same treatment in
-- a dedicated migration.

REVOKE EXECUTE ON FUNCTION public.claim_neighborhood(TEXT, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_neighborhood(TEXT, TEXT, TEXT, INTEGER, INTEGER) FROM anon;

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

    -- Membership gate: end-user calls (JWT identity present) must belong to
    -- the workspace they're asking about. Service-role/background callers
    -- carry no auth.uid() and are trusted to scope themselves.
    IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(v_workspace_id) THEN
        RETURN jsonb_build_object(
            'center', jsonb_build_object('type', p_entity_type, 'id', v_center_id),
            'depth', v_depth,
            'nodes', '[]'::jsonb,
            'edges', '[]'::jsonb
        );
    END IF;

    WITH RECURSIVE frontier AS (
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
        SELECT node_type, node_id, MIN(hop) AS hop
        FROM frontier
        GROUP BY node_type, node_id
    ),
    candidate AS (
        SELECT
            el.source_type, el.source_id, el.target_type, el.target_id,
            el.relation, el.created_at,
            LEAST(rs.hop, rt.hop) AS edge_hop
        FROM public.entity_link el
        JOIN reached rs ON rs.node_type = el.source_type AND rs.node_id = el.source_id
        JOIN reached rt ON rt.node_type = el.target_type AND rt.node_id = el.target_id
        WHERE el.workspace_id = v_workspace_id
    ),
    deg AS (
        SELECT node_type, node_id, COUNT(*)::float AS d
        FROM (
            SELECT source_type AS node_type, source_id AS node_id FROM candidate
            UNION ALL
            SELECT target_type, target_id FROM candidate
        ) u
        GROUP BY node_type, node_id
    ),
    claim_score AS (
        SELECT
            c.id,
            (CASE c.confirmation
                 WHEN 'confirmed' THEN 2.0
                 WHEN 'dismissed' THEN -2.0
                 ELSE 0.0 END)
          + (CASE WHEN c.status = 'active' THEN 1.0 ELSE -1.0 END)
          + COALESCE(c.confidence, 0.5)
          + 1.0 / (1.0 + GREATEST(EXTRACT(EPOCH FROM (now() - c.updated_at)), 0) / (86400.0 * 30.0))
            AS score
        FROM public.claim c
        WHERE c.workspace_id = v_workspace_id
          AND c.id IN (
              SELECT n.node_id FROM (
                  SELECT source_type AS node_type, source_id AS node_id FROM candidate
                  UNION
                  SELECT target_type, target_id FROM candidate
              ) n
              WHERE n.node_type = 'claim'
          )
    ),
    edges AS (
        SELECT cd.source_type, cd.source_id, cd.target_type, cd.target_id, cd.relation
        FROM candidate cd
        LEFT JOIN claim_score ss ON cd.source_type = 'claim' AND ss.id = cd.source_id
        LEFT JOIN claim_score ts ON cd.target_type = 'claim' AND ts.id = cd.target_id
        LEFT JOIN deg ds ON ds.node_type = cd.source_type AND ds.node_id = cd.source_id
        LEFT JOIN deg dt ON dt.node_type = cd.target_type AND dt.node_id = cd.target_id
        ORDER BY
            cd.edge_hop ASC,
            COALESCE(ss.score, 0.5) + COALESCE(ts.score, 0.5)
              + 0.05 * LEAST(COALESCE(ds.d, 0) + COALESCE(dt.d, 0), 20.0) DESC,
            cd.created_at DESC,
            cd.source_id, cd.target_id, cd.relation
        LIMIT p_limit
    )
    SELECT jsonb_agg(jsonb_build_object(
        'source_type', e.source_type,
        'source_id', e.source_id,
        'target_type', e.target_type,
        'target_id', e.target_id,
        'relation', e.relation
    )) INTO v_edges FROM edges e;

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
            WHEN 'claim'        THEN LEFT(cl.text, 140)
            WHEN 'capture'      THEN cap.title
            WHEN 'document'     THEN doc.title
            WHEN 'project'      THEN prj.name
            WHEN 'action'       THEN act.title
            WHEN 'contact'      THEN con.full_name
            WHEN 'member'       THEN mem.display_name
            WHEN 'initiative'   THEN ini.name
            WHEN 'email'        THEN em.subject
            WHEN 'attachment'   THEN att.file_name
            WHEN 'conversation' THEN conv.title
            ELSE NULL END,
        'claim_text',   CASE WHEN ep.node_type = 'claim' THEN cl.text ELSE NULL END,
        'claim_type',   CASE WHEN ep.node_type = 'claim' THEN cl.type ELSE NULL END,
        'confidence',   CASE WHEN ep.node_type = 'claim' THEN cl.confidence ELSE NULL END,
        'confirmation', CASE WHEN ep.node_type = 'claim' THEN cl.confirmation ELSE NULL END,
        'status',       CASE WHEN ep.node_type = 'claim' THEN cl.status ELSE NULL END
    )) INTO v_nodes
    FROM endpoints ep
    LEFT JOIN public.claim    cl  ON ep.node_type = 'claim'        AND cl.id  = ep.node_id AND cl.workspace_id = v_workspace_id
    LEFT JOIN public.captures cap ON ep.node_type = 'capture'      AND cap.id = ep.node_id AND cap.workspace_id = v_workspace_id
    LEFT JOIN public.document doc ON ep.node_type = 'document'     AND doc.id = ep.node_id AND doc.workspace_id = v_workspace_id
    LEFT JOIN public.projects prj ON ep.node_type = 'project'      AND prj.id = ep.node_id AND prj.workspace_id = v_workspace_id
    LEFT JOIN public.actions  act ON ep.node_type = 'action'       AND act.id = ep.node_id AND act.workspace_id = v_workspace_id
    LEFT JOIN public.contact  con ON ep.node_type = 'contact'      AND con.id = ep.node_id AND con.workspace_id = v_workspace_id
    LEFT JOIN public.member   mem ON ep.node_type = 'member'       AND mem.id = ep.node_id AND mem.workspace_id = v_workspace_id
    LEFT JOIN public.initiative ini ON ep.node_type = 'initiative' AND ini.id = ep.node_id AND ini.workspace_id = v_workspace_id
    LEFT JOIN public.email_message em ON ep.node_type = 'email'    AND em.id  = ep.node_id AND em.workspace_id = v_workspace_id
    LEFT JOIN public.attachments att ON ep.node_type = 'attachment' AND att.id = ep.node_id AND att.workspace_id = v_workspace_id
    LEFT JOIN public.chat_conversations conv ON ep.node_type = 'conversation' AND conv.id = ep.node_id AND conv.workspace_id = v_workspace_id;

    RETURN jsonb_build_object(
        'center', jsonb_build_object('type', p_entity_type, 'id', v_center_id),
        'depth', v_depth,
        'nodes', COALESCE(v_nodes, '[]'::jsonb),
        'edges', COALESCE(v_edges, '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

GRANT EXECUTE ON FUNCTION public.claim_neighborhood(TEXT, TEXT, TEXT, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_neighborhood(TEXT, TEXT, TEXT, INTEGER, INTEGER) TO service_role;

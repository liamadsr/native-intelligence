-- Migration 267: the `campaign` entity — Marketing's anchor.
--
-- "Anchors are configuration" gives each workspace an anchor SET its knowledge
-- attaches to: engineering claims hang off PROJECTS, sales claims off
-- COMPANIES, and marketing claims off CAMPAIGNS. The first two had tables
-- already; this is the third.
--
-- Deliberately LEAN. A campaign here is a named piece of marketing work with an
-- objective, a status, the channels it runs on and a date window — enough to be
-- a knowledge anchor and a list the user can keep, and nothing more. No spend,
-- no per-channel metrics, no calendar: those are a marketing-analytics product,
-- not an anchor.
--
-- The two things the entity registry (src/lib/knowledge/entity-registry.ts)
-- cannot generate live at the bottom of this file:
--   1. `claim_source.source_type` already lists 'campaign' — migration 264
--      pre-widened the CHECK precisely so this migration would not have to
--      re-run that DROP/re-ADD dance. Nothing to do here.
--   2. `claim_neighborhood`'s label CASE + LEFT JOIN. 264 deliberately left
--      campaign out because the table did not exist and a LEFT JOIN to a
--      missing relation fails at CREATE time. It exists now, so the function is
--      redefined wholesale (the repo idiom — the body always travels with the
--      change) with the one added label branch and the one added join.

-- ============================================================
-- 1. The campaign table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.campaign (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  -- What the campaign is FOR, in the user's words. This is the field that
  -- carries the most anchoring signal, which is why it outranks `description`
  -- in the fts weighting below.
  objective       text,
  status          text NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('planned', 'active', 'paused', 'completed', 'archived')),
  -- Free-form channel names ('email', 'linkedin', 'events', ...). Not a CHECK:
  -- the channel vocabulary is the user's, and a closed list would need a
  -- migration every time marketing discovers a new surface.
  channels        text[] NOT NULL DEFAULT '{}',
  starts_on       date,
  ends_on         date,
  -- The member who runs it. SET NULL, not CASCADE: removing someone from the
  -- workspace must not delete the campaigns they ran.
  owner_member_id uuid REFERENCES public.member (id) ON DELETE SET NULL,
  tags            text[] NOT NULL DEFAULT '{}',
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaign_workspace_idx ON public.campaign (workspace_id, status);
CREATE INDEX IF NOT EXISTS campaign_owner_idx ON public.campaign (owner_member_id)
  WHERE owner_member_id IS NOT NULL;

-- Full text over name (A) and objective/description (B) — the same shape
-- `contact.fts` uses (033), stored as a generated column so no trigger has to
-- keep it current.
ALTER TABLE public.campaign ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(objective, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS campaign_fts_idx ON public.campaign USING gin (fts);

-- ============================================================
-- 2. RLS — plain workspace membership
-- ============================================================
-- Copied from `sequence_member_all` (227), NOT from company's policies:
-- company's SELECT rides contact visibility because a company is only visible
-- through the contacts at it. A campaign has no private/shared split at all, so
-- workspace membership is the whole fence.

ALTER TABLE public.campaign ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS campaign_member_all ON public.campaign;
CREATE POLICY campaign_member_all ON public.campaign
  FOR ALL
  USING (public.is_workspace_member(workspace_id))
  WITH CHECK (public.is_workspace_member(workspace_id));

REVOKE ALL ON public.campaign FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaign TO authenticated;

-- ============================================================
-- 3. updated_at + realtime
-- ============================================================

DROP TRIGGER IF EXISTS campaign_updated_at ON public.campaign;
CREATE TRIGGER campaign_updated_at
  BEFORE UPDATE ON public.campaign
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Campaign is a UI-rendered, list-and-detail entity like company and projects
-- (187), so it gets the same realtime treatment: FULL replica identity so
-- updates carry the old row, published to the realtime publication.
ALTER TABLE public.campaign REPLICA IDENTITY FULL;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.campaign;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ============================================================
-- 4. claim_neighborhood — body verbatim from 264, + the 'campaign' label
--    branch and its LEFT JOIN.
-- ============================================================

CREATE OR REPLACE FUNCTION public.claim_neighborhood(
    p_workspace_id TEXT,
    p_entity_type TEXT,
    p_entity_id TEXT,
    p_depth INTEGER DEFAULT 2,
    p_limit INTEGER DEFAULT 60,
    p_requesting_user_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_workspace_id UUID;
    v_center_id UUID;
    v_depth INTEGER := LEAST(GREATEST(COALESCE(p_depth, 2), 1), 3);
    v_edges JSONB;
    v_nodes JSONB;
    v_requester UUID := COALESCE(p_requesting_user_id, auth.uid());
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

    -- Asking about a hidden centre returns an empty graph, same shape as the
    -- membership refusal above.
    IF (p_entity_type = 'capture' AND NOT public.capture_visible_to(v_center_id, v_requester))
       OR (p_entity_type = 'claim' AND NOT public.claim_visible_to(v_center_id, v_requester)) THEN
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
          AND (nxt.node_type <> 'capture' OR public.capture_visible_to(nxt.node_id, v_requester))
          AND (nxt.node_type <> 'claim'   OR public.claim_visible_to(nxt.node_id, v_requester))
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
            WHEN 'company'      THEN comp.name
            WHEN 'campaign'     THEN camp.name
            ELSE NULL END,
        'claim_text',   CASE WHEN ep.node_type = 'claim' THEN cl.text ELSE NULL END,
        'claim_type',   CASE WHEN ep.node_type = 'claim' THEN cl.type ELSE NULL END,
        'confidence',   CASE WHEN ep.node_type = 'claim' THEN cl.confidence ELSE NULL END,
        'confirmation', CASE WHEN ep.node_type = 'claim' THEN cl.confirmation ELSE NULL END,
        'status',       CASE WHEN ep.node_type = 'claim' THEN cl.status ELSE NULL END
    )) INTO v_nodes
    FROM endpoints ep
    LEFT JOIN public.claim    cl  ON ep.node_type = 'claim'        AND cl.id  = ep.node_id AND cl.workspace_id = v_workspace_id AND public.claim_visible_to(cl.id, v_requester)
    LEFT JOIN public.captures cap ON ep.node_type = 'capture'      AND cap.id = ep.node_id AND cap.workspace_id = v_workspace_id AND (cap.visibility = 'workspace' OR (v_requester IS NOT NULL AND cap.user_id = v_requester))
    LEFT JOIN public.document doc ON ep.node_type = 'document'     AND doc.id = ep.node_id AND doc.workspace_id = v_workspace_id
    LEFT JOIN public.projects prj ON ep.node_type = 'project'      AND prj.id = ep.node_id AND prj.workspace_id = v_workspace_id
    LEFT JOIN public.actions  act ON ep.node_type = 'action'       AND act.id = ep.node_id AND act.workspace_id = v_workspace_id
    LEFT JOIN public.contact  con ON ep.node_type = 'contact'      AND con.id = ep.node_id AND con.workspace_id = v_workspace_id
    LEFT JOIN public.member   mem ON ep.node_type = 'member'       AND mem.id = ep.node_id AND mem.workspace_id = v_workspace_id
    LEFT JOIN public.initiative ini ON ep.node_type = 'initiative' AND ini.id = ep.node_id AND ini.workspace_id = v_workspace_id
    LEFT JOIN public.email_message em ON ep.node_type = 'email'    AND em.id  = ep.node_id AND em.workspace_id = v_workspace_id
    LEFT JOIN public.attachments att ON ep.node_type = 'attachment' AND att.id = ep.node_id AND att.workspace_id = v_workspace_id
    LEFT JOIN public.chat_conversations conv ON ep.node_type = 'conversation' AND conv.id = ep.node_id AND conv.workspace_id = v_workspace_id
    LEFT JOIN public.company  comp ON ep.node_type = 'company'      AND comp.id = ep.node_id AND comp.workspace_id = v_workspace_id
    LEFT JOIN public.campaign camp ON ep.node_type = 'campaign'     AND camp.id = ep.node_id AND camp.workspace_id = v_workspace_id;

    RETURN jsonb_build_object(
        'center', jsonb_build_object('type', p_entity_type, 'id', v_center_id),
        'depth', v_depth,
        'nodes', COALESCE(v_nodes, '[]'::jsonb),
        'edges', COALESCE(v_edges, '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.claim_neighborhood(TEXT, TEXT, TEXT, INTEGER, INTEGER, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_neighborhood(TEXT, TEXT, TEXT, INTEGER, INTEGER, UUID) TO authenticated, service_role;

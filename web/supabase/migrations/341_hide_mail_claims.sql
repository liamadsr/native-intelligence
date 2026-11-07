-- ============================================================
-- 341: a claim is readable only when one of its sources is (privacy fix)
-- ============================================================
-- Two leaks, one rule.
--
-- 1. Mail. Decision, 2026-10-15: Dial8 stops learning from mail. No claim or
--    fact is extracted from email any more (the app stops in the same PR:
--    claim extraction refuses an email source, `ingest_source` and
--    `create_claim` no longer take one). The agent still reads mail live when
--    asked, through the mail tools, which read only the person's own mailbox.
--    Live since 223: claim_visible_to treated every non-capture source as
--    visible ("ELSE TRUE"), so a claim extracted from ONE person's mail, with
--    its verbatim excerpt, was visible to the whole workspace, and
--    hybrid_search and claim_neighborhood joined email_message by workspace
--    only, handing that person's subject lines to every member.
--
-- 2. Private captures. claim_visible_to has hidden a claim taken only from
--    other people's private captures since 223, but only inside the search
--    RPCs. The claim, claim_source and claim_chunks tables stayed readable by
--    every member (109's policies), so the knowledge graph, list_claims and a
--    direct client read showed those claims and their excerpts.
--
-- The rule, everywhere (claim_visible_to, RLS, and the app's service-role
-- reads in src/lib/knowledge/claim-visibility.ts): a claim with ANY email
-- source is visible to no one; otherwise it is visible when it has no sources
-- or at least one source the reader can see. A capture source is visible when
-- the capture is not an eval and is workspace-visible or the reader's own; an
-- attachment source follows its parent capture (none: visible); anything else
-- is visible.
--
-- What changes (signatures, grants, SECURITY DEFINER and the pinned
-- search_path of the redefined functions are the earlier migrations'):
--
--   claim_visible_to        body from 252, plus the mail rule.
--   hybrid_search           body from 275. Its claims already pass
--                           claim_visible_to; on top, the inline provenance
--                           never picks an email source, and the
--                           email_message join and subject label are gone.
--   claim_neighborhood      body from 275. An email centre is an empty graph,
--                           the walk never steps onto an email node, and the
--                           email_message join and subject label are gone.
--   schema private          NEW (IF NOT EXISTS). Not in PostgREST's exposed
--                           schemas (Supabase exposes public and
--                           graphql_public unless the API settings add more;
--                           check Settings > API > Exposed schemas holds no
--                           "private"), so no member can call the two
--                           functions below over RPC and list hidden ids.
--                           USAGE for authenticated and service_role only,
--                           which the policies need.
--   private.claim_sources_hidden_from_me()   NEW. The claim_source ids the
--                           caller (auth.uid()) may not see, in the caller's
--                           workspaces only: every mail source, and every
--                           capture or attachment source whose capture is
--                           hidden from them.
--   private.claims_hidden_from_me()          NEW. The claim ids hidden from
--                           the caller: every claim with a mail source, plus
--                           each claim citing a hidden capture that
--                           claim_visible_to rejects (no other readable
--                           source).
--   RLS, one RESTRICTIVE SELECT policy per table, TO authenticated (ANDed
--   with 109's permissive member policies; anon matches no permissive policy
--   and gets nothing, never an error; service_role bypasses RLS):
--     claim          id NOT IN (SELECT private.claims_hidden_from_me())
--     claim_source   id NOT IN (SELECT private.claim_sources_hidden_from_me());
--                    a hidden claim's other sources go too, because 109's
--                    policy reads the parent claim under its RLS
--     claim_chunks   claim_id NOT IN (SELECT private.claims_hidden_from_me())
--   Three partial indexes feed the hidden sets: each workspace's mail
--   sources, each workspace's private captures, and attachments by parent
--   capture.
--   knowledge-playbook (system skill): "email," dropped from the two lines
--   that say a claim can come from an email. Loud when it can't apply.
--
-- Cost. The obvious policy, claim_visible_to(id, auth.uid()) per row, is
-- three or four index probes plus a non-inlined function call for every row
-- read: the knowledge map reads about 10k claims (and the knowledge route 20k
-- claim_source rows through their parent claim), so tens of thousands of
-- calls per load. Instead each policy is an uncorrelated `NOT IN (SELECT
-- f())`: Postgres runs f() ONCE per statement and builds a hashed subplan, so
-- a row costs one hash probe. f() starts from the hidden things in the
-- caller's workspaces, never from the claims: the memberships
-- (member_user_idx); per workspace, the eval captures (idx_captures_is_eval),
-- other people's private captures (idx_captures_private_workspace) and the
-- mail sources (idx_claim_source_mail); the sources citing those captures
-- (idx_claim_source_lookup) and their attachments (idx_attachments_note_id,
-- then idx_claim_source_lookup); claim_visible_to on the candidate claims
-- only. Its cost follows the number of hidden things in the caller's
-- workspaces, not the number of claims; the mail set stopped growing with
-- this PR and 342 deletes it. ROWS 50 keeps the planner's estimate in hash
-- territory. A one-row read pays the same small fixed cost.
--
-- One known gap, on purpose: a source pointing at a capture or attachment
-- that no longer exists. claim_visible_to (the RPCs) and the app's filters
-- count it as hidden; finding those rows in RLS would mean scanning every
-- source of every claim, so RLS counts it as visible. Capture deletion
-- removes its provenance (delete_capture_with_knowledge), so such rows are
-- rare. Other deviation: none.
--
-- SECURITY DEFINER functions and the service role bypass RLS, which is why
-- the functions carry the rule themselves and the app filters its
-- service-role reads. Every other function that reads claims goes through
-- claim_visible_to (match_claims x3, unified_search), and every other function
-- that reads email_message or email_thread_index is fenced by user_id
-- (search_email_messages, get_email_folder_counts) or is service-role sync
-- plumbing. No view exposes either.
--
-- No data is deleted here. 342_purge_mail_knowledge.sql, applied right after
-- this file, deletes the mail-derived knowledge (the owner's go-ahead,
-- 2026-10-15).
--
-- Applied by hand, from this file: DEV, then PROD on the owner's word. The app
-- change does not depend on it (it filters on its own), and this file does not
-- depend on the app. The three CREATE INDEX statements take a short write
-- lock on claim_source, captures and attachments while they build (partial,
-- small).
--
-- Idempotent: CREATE SCHEMA / INDEX IF NOT EXISTS; CREATE OR REPLACE with
-- unchanged signatures; DROP POLICY IF EXISTS + CREATE POLICY; REVOKE/GRANT
-- restated; the skill update runs only while the row still holds 338's exact
-- text (md5 guard), and warns when the row holds neither that nor the new
-- wording. This file holds no backslash anywhere: one MCP transport decodes
-- escapes, so the applied SQL would differ from the file.
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- Indexes for the hidden sets
-- ------------------------------------------------------------
-- A workspace's mail sources: frozen with this PR, emptied by 342.
CREATE INDEX IF NOT EXISTS idx_claim_source_mail
  ON public.claim_source (workspace_id, claim_id)
  WHERE source_type = 'email';

-- A workspace's private captures (idx_captures_visibility_private is keyed by
-- owner, which answers "mine", not "this workspace's").
CREATE INDEX IF NOT EXISTS idx_captures_private_workspace
  ON public.captures (workspace_id)
  WHERE visibility = 'private';

-- A capture's attachments (attachments.note_id had no index).
CREATE INDEX IF NOT EXISTS idx_attachments_note_id
  ON public.attachments (note_id)
  WHERE note_id IS NOT NULL;

-- ------------------------------------------------------------
-- claim_visible_to (from 252)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_visible_to(
  p_claim_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN AS $$
  SELECT
    -- 341: a claim learned from mail is visible to no one.
    NOT EXISTS (
      SELECT 1 FROM public.claim_source cs
      WHERE cs.claim_id = p_claim_id
        AND cs.source_type = 'email'
    )
    AND (
      NOT EXISTS (SELECT 1 FROM public.claim_source cs WHERE cs.claim_id = p_claim_id)
      OR EXISTS (
        SELECT 1 FROM public.claim_source cs
        WHERE cs.claim_id = p_claim_id
          AND CASE cs.source_type
            WHEN 'capture' THEN EXISTS (
              SELECT 1 FROM public.captures c
              WHERE c.id = cs.source_id
                AND NOT c.is_eval
                AND (c.visibility = 'workspace'
                     OR (p_user_id IS NOT NULL AND c.user_id = p_user_id))
            )
            WHEN 'attachment' THEN EXISTS (
              SELECT 1 FROM public.attachments a
              WHERE a.id = cs.source_id
                AND (
                  a.note_id IS NULL
                  OR EXISTS (
                    SELECT 1 FROM public.captures c
                    WHERE c.id = a.note_id
                      AND NOT c.is_eval
                      AND (c.visibility = 'workspace'
                           OR (p_user_id IS NOT NULL AND c.user_id = p_user_id))
                  )
                )
            )
            WHEN 'email' THEN FALSE
            ELSE TRUE
          END
      )
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.claim_visible_to(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_visible_to(UUID, UUID) TO authenticated, service_role;

-- ------------------------------------------------------------
-- hybrid_search (from 275)
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

REVOKE EXECUTE ON FUNCTION public.hybrid_search(UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hybrid_search(UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, UUID) TO authenticated, service_role;

-- ------------------------------------------------------------
-- claim_neighborhood (from 275)
-- ------------------------------------------------------------
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
    v_requester UUID := public._resolve_visibility_requester(p_requesting_user_id);
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

    -- Membership gate (275): enforced whenever the requester is KNOWN — whether
    -- it came from the JWT or from an explicit p_requesting_user_id — not only
    -- when a JWT happens to be present. A sessionless caller that asserts no
    -- requester at all sees workspace-visible rows only, and is trusted to
    -- scope itself (service-role already has the whole database).
    IF v_requester IS NOT NULL AND NOT public._is_member_of(v_requester, v_workspace_id) THEN
        RETURN jsonb_build_object(
            'center', jsonb_build_object('type', p_entity_type, 'id', v_center_id),
            'depth', v_depth,
            'nodes', '[]'::jsonb,
            'edges', '[]'::jsonb
        );
    END IF;

    -- Asking about a hidden centre returns an empty graph, same shape as the
    -- membership refusal above.
    -- 341: an email centre is hidden from everyone.
    IF p_entity_type = 'email'
       OR (p_entity_type = 'capture' AND NOT public.capture_visible_to(v_center_id, v_requester))
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
          -- 341: the walk never reaches an email.
          AND nxt.node_type <> 'email'
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


-- ------------------------------------------------------------
-- The hidden sets (new), in a schema PostgREST doesn't expose
-- ------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

-- Caller-scoped: both read auth.uid() themselves and take no argument, so no
-- one can ask what is hidden from somebody else, and both stay inside the
-- caller's workspaces. NULL caller: no memberships, so both are empty.
CREATE OR REPLACE FUNCTION private.claim_sources_hidden_from_me()
RETURNS SETOF UUID AS $$
  WITH ws AS (
    SELECT m.workspace_id FROM public.member m WHERE m.user_id = auth.uid()
  ),
  hidden_capture AS (
    SELECT c.id
    FROM ws JOIN public.captures c ON c.workspace_id = ws.workspace_id
    WHERE c.is_eval
    UNION
    SELECT c.id
    FROM ws JOIN public.captures c ON c.workspace_id = ws.workspace_id
    WHERE c.visibility = 'private'
      AND c.user_id IS DISTINCT FROM auth.uid()
  )
  -- Mail sources in the caller's workspaces.
  SELECT cs.id
  FROM ws JOIN public.claim_source cs ON cs.workspace_id = ws.workspace_id
  WHERE cs.source_type = 'email'
  UNION
  -- Mail sources written before claim_source carried workspace_id (117 left
  -- it nullable): placed through their claim.
  SELECT cs.id
  FROM public.claim_source cs
  JOIN public.claim cl ON cl.id = cs.claim_id
  WHERE cs.source_type = 'email'
    AND cs.workspace_id IS NULL
    AND cl.workspace_id IN (SELECT workspace_id FROM ws)
  UNION
  -- Sources citing a hidden capture.
  SELECT cs.id
  FROM hidden_capture hc
  JOIN public.claim_source cs
    ON cs.source_type = 'capture' AND cs.source_id = hc.id
  UNION
  -- Sources citing an attachment of a hidden capture.
  SELECT cs.id
  FROM hidden_capture hc
  JOIN public.attachments a ON a.note_id = hc.id
  JOIN public.claim_source cs
    ON cs.source_type = 'attachment' AND cs.source_id = a.id;
$$ LANGUAGE sql SECURITY DEFINER STABLE ROWS 50 SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION private.claim_sources_hidden_from_me() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.claim_sources_hidden_from_me() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.claims_hidden_from_me()
RETURNS SETOF UUID AS $$
  SELECT DISTINCT cs.claim_id
  FROM public.claim_source cs
  WHERE cs.id IN (SELECT private.claim_sources_hidden_from_me())
    AND (cs.source_type = 'email'
         OR NOT public.claim_visible_to(cs.claim_id, auth.uid()));
$$ LANGUAGE sql SECURITY DEFINER STABLE ROWS 50 SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION private.claims_hidden_from_me() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.claims_hidden_from_me() TO authenticated, service_role;

-- ------------------------------------------------------------
-- RLS: one restrictive SELECT policy per table, for authenticated
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Claims follow their sources' visibility" ON public.claim;
CREATE POLICY "Claims follow their sources' visibility"
  ON public.claim AS RESTRICTIVE FOR SELECT TO authenticated
  USING (id NOT IN (SELECT private.claims_hidden_from_me()));

DROP POLICY IF EXISTS "Hidden sources stay hidden" ON public.claim_source;
CREATE POLICY "Hidden sources stay hidden"
  ON public.claim_source AS RESTRICTIVE FOR SELECT TO authenticated
  USING (id NOT IN (SELECT private.claim_sources_hidden_from_me()));

DROP POLICY IF EXISTS "Chunks follow their claim's visibility" ON public.claim_chunks;
CREATE POLICY "Chunks follow their claim's visibility"
  ON public.claim_chunks AS RESTRICTIVE FOR SELECT TO authenticated
  USING (claim_id NOT IN (SELECT private.claims_hidden_from_me()));

-- ------------------------------------------------------------
-- knowledge-playbook: a claim no longer comes from an email
-- ------------------------------------------------------------
-- The two lines as 338_skill_helper_lines.sql wrote them, each with "email,"
-- dropped, nothing else touched. Guarded by id, slug, is_system and the md5
-- of 338's exact text: a row someone else changed since is left alone, and a
-- second run finds the new text and does nothing. When nothing changed and
-- the row doesn't already hold the new wording, it says so with a WARNING.
DO $guard$
DECLARE
  v_changed integer;
BEGIN
  UPDATE public.recipe AS r
  SET system_prompt = replace(
        replace(
          r.system_prompt,
          $old$(the capture, document, email, attachment or page it came from, with an excerpt)$old$,
          $new$(the capture, document, attachment or page it came from, with an excerpt)$new$
        ),
        $old$`ingest_source` reads a capture, document, email, attachment or conversation$old$,
        $new$`ingest_source` reads a capture, document, attachment or conversation$new$
      ),
      updated_at = now()
  WHERE r.id = 'e6ea5b11-b98c-4d56-a5e5-40b5e661d1dc'::uuid
    AND r.slug = $slug$knowledge-playbook$slug$
    AND r.is_system
    AND md5(r.system_prompt) = 'd37072a1aa155815475b4d0e6637d81e';
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  IF v_changed = 0 AND NOT EXISTS (
    SELECT 1 FROM public.recipe AS r
    WHERE r.id = 'e6ea5b11-b98c-4d56-a5e5-40b5e661d1dc'::uuid
      AND r.is_system
      AND strpos(r.system_prompt, $want$(the capture, document, attachment or page it came from, with an excerpt)$want$) > 0
      AND strpos(r.system_prompt, $want$`ingest_source` reads a capture, document, attachment or conversation$want$) > 0
      AND strpos(r.system_prompt, $gone$document, email, attachment$gone$) = 0
  ) THEN
    RAISE WARNING '341: knowledge-playbook (e6ea5b11-b98c-4d56-a5e5-40b5e661d1dc) was not updated: its text is neither what 338 wrote nor the new wording. Drop "email," from its two source lines by hand.';
  END IF;
END
$guard$;

-- ============================================================
-- 369: private documents ("Only me"), the way captures are private
-- (Liam, 2026-10-19; documents phase 1 item 8's finding).
-- ============================================================
-- Every member could read every document (RLS is_workspace_member), so a
-- meeting prep written from a person's own mail and calendar was readable by
-- the whole workspace. Liam: "We already have this concept for captures ...
-- make sure the UI and the UX matches that as well, so it doesn't introduce a
-- new type of UX."
--
-- The model is captures' (migration 223, docs/design-capture-visibility.md),
-- value for value:
--   document.visibility  'workspace' (default) or 'private'.
--   private              only its creator (document.created_by, a member)
--                        sees it. No admin or owner override: only me means
--                        only me. A private document with no creator is
--                        visible to no one (a creator who left).
--   derived content      inherits it: chunks, revisions, comments, and claims
--                        whose only sources are private documents. Flips apply
--                        at once in both directions (live joins, no re-index).
--   unattended runs      see no private document at all (the app passes no
--                        requester, as for private captures).
--   system documents     (a canon_key, or the product-doc pointer) are never
--                        private.
-- The rule everywhere:
--   visible(doc, requester) := doc.visibility = 'workspace'
--                              OR doc.created_by is the requester's member row
--
-- This migration:
--   1. the column (CHECK, as 223), and document_visible_to(document, user);
--   2. a guard: a private document needs a creator and is never a system
--      document (private.is_system_document, 366); from a client only its
--      creator changes its visibility;
--   3. RLS: document SELECT and UPDATE; document_chunks; document_revision;
--      the document arm of the comment SELECT policy (capture and action arms
--      byte for byte as 223). document_draft is already the author's own.
--      DELETE keeps 359's rule (owner/admin or creator), as captures keep
--      admin delete;
--   4. claims: claim_visible_to and private.claim_sources_hidden_from_me gain
--      a document arm (353's bodies otherwise);
--   5. search: hybrid_search (365's body), unified_search (275's body) and
--      claim_neighborhood (353's body) gain the document rule;
--   6. moves: move_document refuses a private document unless the caller is
--      its creator (move_capture's rule), move_project refuses to carry
--      someone else's private document (360's bodies otherwise);
--   7. backfill: every meeting prep becomes private, owned by the person it
--      was prepared for (frontmatter.meeting_prep.userId's member row in the
--      document's workspace). DEV on 2026-10-19: 0 rows (no preps); PROD on
--      2026-10-19 had 6 preps.
--
-- Rollout: DEV, then PROD BEFORE the app PR merges (the app reads and writes
-- visibility). After 364-368. Idempotent: add column if not exists, create or
-- replace, drop policy/trigger if exists. No backslash anywhere in this file
-- (the MCP apply tool decodes them).

-- ------------------------------------------------------------
-- 1. The column and the rule
-- ------------------------------------------------------------

ALTER TABLE public.document
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'workspace';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_visibility_check') THEN
    ALTER TABLE public.document
      ADD CONSTRAINT document_visibility_check
      CHECK (visibility IN ('workspace', 'private'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_document_private_creator
  ON public.document (workspace_id, created_by)
  WHERE visibility = 'private';

-- capture_visible_to's twin (223). A document's creator is a member row, so
-- the requester (an auth user id) is matched through it.
CREATE OR REPLACE FUNCTION public.document_visible_to(
  p_document_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.document d
    WHERE d.id = p_document_id
      AND (
        d.visibility = 'workspace'
        OR (
          p_user_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.member m
            WHERE m.id = d.created_by
              AND m.user_id = p_user_id
          )
        )
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.document_visible_to(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.document_visible_to(UUID, UUID) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2. The guard
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.document_visibility_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF new.visibility = 'private' THEN
    IF new.created_by IS NULL THEN
      RAISE EXCEPTION 'a private document needs its creator' USING ERRCODE = 'P0015';
    END IF;
    IF private.is_system_document(new.workspace_id, new.id, new.canon_key) THEN
      RAISE EXCEPTION 'this is a system document: it can''t be private' USING ERRCODE = 'P0014';
    END IF;
  END IF;

  -- From a client, only its creator says who can see a document.
  IF tg_op = 'UPDATE'
     AND new.visibility IS DISTINCT FROM old.visibility
     AND current_user IN ('authenticated', 'anon')
     AND (old.created_by IS NULL OR old.created_by IS DISTINCT FROM public.current_member_id(old.workspace_id)) THEN
    RAISE EXCEPTION 'only its creator can change who can see a document' USING ERRCODE = '42501';
  END IF;

  RETURN new;
END
$$;
REVOKE EXECUTE ON FUNCTION public.document_visibility_guard() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS document_visibility_guard ON public.document;
CREATE TRIGGER document_visibility_guard
  BEFORE INSERT OR UPDATE ON public.document
  FOR EACH ROW
  EXECUTE FUNCTION public.document_visibility_guard();

-- ------------------------------------------------------------
-- 3. RLS
-- ------------------------------------------------------------

-- document SELECT (025's, plus the rule).
DROP POLICY IF EXISTS "Workspace members can view documents" ON public.document;
DROP POLICY IF EXISTS document_select ON public.document;
CREATE POLICY document_select
  ON public.document FOR SELECT
  USING (
    public.is_workspace_member(workspace_id)
    AND (visibility = 'workspace' OR created_by = public.current_member_id(workspace_id))
  );

-- document UPDATE (359's, plus the rule): nobody edits what they can't see.
DROP POLICY IF EXISTS document_update ON public.document;
CREATE POLICY document_update
  ON public.document FOR UPDATE
  TO authenticated
  USING (
    public.can_edit_document(id, workspace_id, created_by, type, slug, published_status, frontmatter, project_id)
    AND (visibility = 'workspace' OR created_by = public.current_member_id(workspace_id))
  )
  WITH CHECK (
    public.can_edit_document(id, workspace_id, created_by, type, slug, published_status, frontmatter, project_id)
    AND (visibility = 'workspace' OR created_by = public.current_member_id(workspace_id))
  );

-- document_chunks (365's: the parent document is in the chunk's workspace;
-- plus its rule).
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
        AND (d.visibility = 'workspace' OR d.created_by = public.current_member_id(d.workspace_id))
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
        AND (d.visibility = 'workspace' OR d.created_by = public.current_member_id(d.workspace_id))
    )
  )
  WITH CHECK (
    public.is_workspace_member(workspace_id)
    AND EXISTS (
      SELECT 1 FROM public.document d
      WHERE d.id = document_chunks.document_id
        AND d.workspace_id = document_chunks.workspace_id
        AND (d.visibility = 'workspace' OR d.created_by = public.current_member_id(d.workspace_id))
    )
  );

-- document_revision (110's, plus the parent document's rule). History holds
-- the full text, so it follows the document.
DROP POLICY IF EXISTS "Workspace members can read document revisions" ON public.document_revision;
DROP POLICY IF EXISTS document_revision_select ON public.document_revision;
CREATE POLICY document_revision_select
  ON public.document_revision FOR SELECT
  USING (
    public.is_workspace_member(workspace_id)
    AND EXISTS (
      SELECT 1 FROM public.document d
      WHERE d.id = document_revision.document_id
        AND (d.visibility = 'workspace' OR d.created_by = public.current_member_id(d.workspace_id))
    )
  );

-- comment (223's policy; only the document arm gains the rule).
DROP POLICY IF EXISTS "View comments: members + own external" ON public.comment;
CREATE POLICY "View comments: members + own external"
  ON public.comment FOR SELECT
  USING (
    -- External commenter viewing their own comment
    (author_user_id IS NOT NULL AND author_user_id = auth.uid())
    OR
    -- Workspace member viewing any comment on an entity they can access
    CASE commentable_type
      WHEN 'action' THEN EXISTS (
        SELECT 1 FROM public.actions a
        JOIN public.team t ON t.id = a.team_id
        WHERE a.id = commentable_id
          AND public.is_workspace_member(t.workspace_id)
      )
      WHEN 'capture' THEN EXISTS (
        SELECT 1 FROM public.captures c
        WHERE c.id = commentable_id
          AND public.is_workspace_member(c.workspace_id)
          AND (c.visibility = 'workspace' OR c.user_id = auth.uid())
      )
      WHEN 'document' THEN EXISTS (
        SELECT 1 FROM public.document d
        WHERE d.id = commentable_id
          AND public.is_workspace_member(d.workspace_id)
          -- 369: a private document is its creator's alone.
          AND (d.visibility = 'workspace' OR d.created_by = public.current_member_id(d.workspace_id))
      )
    END
  );

-- ------------------------------------------------------------
-- 4. Claims: a claim known only from someone's private document is theirs
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
            -- 353: a chat is only its owner's.
            WHEN 'conversation' THEN EXISTS (
              SELECT 1 FROM public.chat_conversations cc
              WHERE cc.id = cs.source_id
                AND p_user_id IS NOT NULL
                AND cc.user_id = p_user_id
            )
            WHEN 'email' THEN FALSE
            -- 369: a private document is its creator's alone.
            WHEN 'document' THEN public.document_visible_to(cs.source_id, p_user_id)
            ELSE TRUE
          END
      )
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.claim_visible_to(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_visible_to(UUID, UUID) TO authenticated, service_role;

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
    ON cs.source_type = 'attachment' AND cs.source_id = a.id
  UNION
  -- 353: sources citing a chat that is not the caller's (or no longer exists).
  SELECT cs.id
  FROM ws JOIN public.claim_source cs ON cs.workspace_id = ws.workspace_id
  WHERE cs.source_type = 'conversation'
    AND NOT EXISTS (
      SELECT 1 FROM public.chat_conversations cc
      WHERE cc.id = cs.source_id
        AND cc.user_id = auth.uid()
    )
  UNION
  -- The same, for rows without workspace_id: placed through their claim.
  SELECT cs.id
  FROM public.claim_source cs
  JOIN public.claim cl ON cl.id = cs.claim_id
  WHERE cs.source_type = 'conversation'
    AND cs.workspace_id IS NULL
    AND cl.workspace_id IN (SELECT workspace_id FROM ws)
    AND NOT EXISTS (
      SELECT 1 FROM public.chat_conversations cc
      WHERE cc.id = cs.source_id
        AND cc.user_id = auth.uid()
    )
  UNION
  -- 369: sources citing someone else's private document.
  SELECT cs.id
  FROM ws
  JOIN public.document d ON d.workspace_id = ws.workspace_id
  JOIN public.claim_source cs ON cs.source_type = 'document' AND cs.source_id = d.id
  WHERE d.visibility = 'private'
    AND NOT EXISTS (
      SELECT 1 FROM public.member m
      WHERE m.id = d.created_by
        AND m.user_id = auth.uid()
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE ROWS 50 SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION private.claim_sources_hidden_from_me() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.claim_sources_hidden_from_me() TO authenticated, service_role;

-- ------------------------------------------------------------
-- 5. Search
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
    v_requester_member uuid;
BEGIN
    -- Membership gate (275): enforced whenever the requester is KNOWN — whether
    -- it came from the JWT or from an explicit p_requesting_user_id — not only
    -- when a JWT happens to be present. A sessionless caller that asserts no
    -- requester at all sees workspace-visible rows only, and is trusted to
    -- scope itself (service-role already has the whole database).
    IF v_requester IS NOT NULL AND NOT public._is_member_of(v_requester, p_workspace_id) THEN
        RETURN;
    END IF;

    -- 369: the requester's member row here, for the private-document rule
    -- (a private document is its creator's alone; no admin override).
    IF v_requester IS NOT NULL THEN
        SELECT m.id INTO v_requester_member
          FROM public.member m
         WHERE m.workspace_id = p_workspace_id AND m.user_id = v_requester
         LIMIT 1;
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
              -- 369: a private document is its creator's alone.
              WHEN 'document' THEN public.document_visible_to(cs.source_id, v_requester)
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
          AND (d.visibility = 'workspace' OR (v_requester_member IS NOT NULL AND d.created_by = v_requester_member))
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
          AND (d.visibility = 'workspace' OR (v_requester_member IS NOT NULL AND d.created_by = v_requester_member))
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

CREATE OR REPLACE FUNCTION public.unified_search(
    p_workspace_id UUID,
    p_query TEXT,
    p_types TEXT[] DEFAULT ARRAY['action', 'capture', 'document', 'project', 'decision', 'claim'],
    p_limit INTEGER DEFAULT 20,
    p_requesting_user_id UUID DEFAULT NULL
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
  v_requester uuid := public._resolve_visibility_requester(p_requesting_user_id);
  v_requester_member uuid;
BEGIN
  -- Membership gate (275): enforced whenever the requester is KNOWN — whether
  -- it came from the JWT or from an explicit p_requesting_user_id — not only
  -- when a JWT happens to be present. A sessionless caller that asserts no
  -- requester at all sees workspace-visible rows only, and is trusted to
  -- scope itself (service-role already has the whole database).
  IF v_requester IS NOT NULL AND NOT public._is_member_of(v_requester, p_workspace_id) THEN
    RETURN;
  END IF;

  -- 369: the requester's member row here, for the private-document rule
  -- (a private document is its creator's alone; no admin override).
  IF v_requester IS NOT NULL THEN
      SELECT m.id INTO v_requester_member
        FROM public.member m
       WHERE m.workspace_id = p_workspace_id AND m.user_id = v_requester
       LIMIT 1;
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
    AND NOT c.is_eval
    AND v_tsquery IS NOT NULL
    AND c.fts @@ v_tsquery
    AND (c.visibility = 'workspace' OR (v_requester IS NOT NULL AND c.user_id = v_requester))

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
    AND (d.visibility = 'workspace' OR (v_requester_member IS NOT NULL AND d.created_by = v_requester_member))

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
    AND NOT c.is_eval
    AND v_tsquery IS NOT NULL
    AND dec.fts @@ v_tsquery
    AND (c.visibility = 'workspace'
         OR (v_requester IS NOT NULL AND c.user_id = v_requester)
         OR dec.confirmation = 'confirmed')

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
    AND public.claim_visible_to(cl.id, v_requester)

  ORDER BY rank DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.unified_search(UUID, TEXT, TEXT[], INTEGER, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unified_search(UUID, TEXT, TEXT[], INTEGER, UUID) TO authenticated, service_role;

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
    -- 353: someone else's chat is hidden too.
    IF p_entity_type = 'email'
       OR (p_entity_type = 'conversation' AND NOT EXISTS (
             SELECT 1 FROM public.chat_conversations cc
             WHERE cc.id = v_center_id AND v_requester IS NOT NULL AND cc.user_id = v_requester))
       OR (p_entity_type = 'capture' AND NOT public.capture_visible_to(v_center_id, v_requester))
       OR (p_entity_type = 'claim' AND NOT public.claim_visible_to(v_center_id, v_requester))
       -- 369: a private document is its creator's alone.
       OR (p_entity_type = 'document' AND NOT public.document_visible_to(v_center_id, v_requester)) THEN
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
          AND (nxt.node_type <> 'document' OR public.document_visible_to(nxt.node_id, v_requester))
          -- 341: the walk never reaches an email.
          AND nxt.node_type <> 'email'
          -- 353: nor someone else's chat.
          AND (nxt.node_type <> 'conversation' OR EXISTS (
                SELECT 1 FROM public.chat_conversations cc
                WHERE cc.id = nxt.node_id AND v_requester IS NOT NULL AND cc.user_id = v_requester))
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
    LEFT JOIN public.document doc ON ep.node_type = 'document'     AND doc.id = ep.node_id AND doc.workspace_id = v_workspace_id AND public.document_visible_to(doc.id, v_requester)
    LEFT JOIN public.projects prj ON ep.node_type = 'project'      AND prj.id = ep.node_id AND prj.workspace_id = v_workspace_id
    LEFT JOIN public.actions  act ON ep.node_type = 'action'       AND act.id = ep.node_id AND act.workspace_id = v_workspace_id
    LEFT JOIN public.contact  con ON ep.node_type = 'contact'      AND con.id = ep.node_id AND con.workspace_id = v_workspace_id
    LEFT JOIN public.member   mem ON ep.node_type = 'member'       AND mem.id = ep.node_id AND mem.workspace_id = v_workspace_id
    LEFT JOIN public.initiative ini ON ep.node_type = 'initiative' AND ini.id = ep.node_id AND ini.workspace_id = v_workspace_id
    LEFT JOIN public.attachments att ON ep.node_type = 'attachment' AND att.id = ep.node_id AND att.workspace_id = v_workspace_id
    LEFT JOIN public.chat_conversations conv ON ep.node_type = 'conversation' AND conv.id = ep.node_id AND conv.workspace_id = v_workspace_id AND v_requester IS NOT NULL AND conv.user_id = v_requester
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
-- 6. Moves
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.move_document(
  p_document_id uuid,
  p_destination_workspace_id uuid,
  p_move_claims boolean DEFAULT TRUE
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_source uuid;
  v_owns boolean;
  v_core jsonb;
  v_claims jsonb := jsonb_build_object('moved', 0, 'left', 0, 'moved_ids', '[]'::jsonb);
  v_links jsonb;
  v_residue jsonb;
  v_moving jsonb;
  v_counts jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT d.workspace_id,
         EXISTS (
           SELECT 1 FROM public.member m
           WHERE m.id = d.created_by AND m.user_id = v_user_id
         )
  INTO v_source, v_owns
  FROM public.document d
  WHERE d.id = p_document_id
  FOR UPDATE OF d;

  IF v_source IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._wsmove_gate(
    v_user_id, v_source, p_destination_workspace_id, COALESCE(v_owns, false));

  -- 360: the workspace product doc moves only for an owner or admin of the
  -- source workspace (359's rule: the creator, except the product doc).
  IF COALESCE((SELECT m.role FROM public.member m
                WHERE m.workspace_id = v_source AND m.user_id = v_user_id), '')
       NOT IN ('owner', 'admin')
     AND public.is_product_doc(v_source, p_document_id) THEN
    RAISE EXCEPTION 'only an owner or admin can move the workspace product doc'
      USING ERRCODE = '42501';
  END IF;

  -- 369: a private document moves only with its creator (move_capture's
  -- rule): someone who can't read it can't carry it somewhere they can.
  IF EXISTS (
       SELECT 1 FROM public.document d
        WHERE d.id = p_document_id
          AND d.visibility = 'private'
          AND NOT COALESCE(v_owns, false)
     ) THEN
    RAISE EXCEPTION 'only its creator can move a private document'
      USING ERRCODE = '42501';
  END IF;

  v_core := public._wsmove_documents_core(
    ARRAY[p_document_id], v_source, p_destination_workspace_id,
    false  -- the project (if any) stays behind
  );

  IF p_move_claims THEN
    v_claims := public._wsmove_claims(
      v_source, p_destination_workspace_id,
      jsonb_build_array(jsonb_build_object('t', 'document', 'i', p_document_id))
    );
  END IF;

  v_moving := jsonb_build_array(jsonb_build_object('t', 'document', 'i', p_document_id))
    || COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('t', 'claim', 'i', c))
       FROM jsonb_array_elements_text(v_claims->'moved_ids') c),
      '[]'::jsonb);

  v_links := public._wsmove_entity_links(v_source, p_destination_workspace_id, v_moving);
  v_residue := public._wsmove_residue(v_source, p_destination_workspace_id, v_moving);

  v_counts := jsonb_build_object(
    'slugs_cleared', v_core->'slugs_cleared',
    'shares_deactivated', v_core->'shares_deactivated',
    'drafts_translated', v_core->'drafts_translated',
    'drafts_discarded', v_core->'drafts_discarded',
    'comments_translated', v_core->'comments_translated',
    'moved_claims', v_claims->'moved',
    'shared_claims_left', v_claims->'left',
    'links_moved', v_links->'moved',
    'links_severed', v_links->'severed'
  ) || v_residue;

  INSERT INTO public.workspace_move_log
    (entity_type, entity_id, source_workspace_id, destination_workspace_id, moved_by, counts)
  VALUES ('document', p_document_id, v_source, p_destination_workspace_id, v_user_id, v_counts);

  RETURN jsonb_build_object(
    'document_id', p_document_id,
    'source_workspace_id', v_source,
    'destination_workspace_id', p_destination_workspace_id,
    'counts', v_counts
  );
END;
$$;

REVOKE ALL ON FUNCTION public.move_document(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_document(uuid, uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.move_project(
  p_project_id uuid,
  p_destination_workspace_id uuid,
  p_destination_team_id uuid DEFAULT NULL,
  p_move_documents boolean DEFAULT TRUE
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_source uuid;
  v_name text;
  v_owns boolean;
  v_dest_team uuid;
  v_dest_default_status uuid;
  v_action_ids uuid[] := '{}';
  v_doc_ids uuid[] := '{}';
  v_milestone_ids uuid[] := '{}';
  v_attachment_ids uuid[] := '{}';
  v_captures_unlinked int := 0;
  v_docs_unlinked int := 0;
  v_views_deleted int := 0;
  v_core jsonb;
  v_doc_core jsonb := jsonb_build_object(
    'moved', 0, 'slugs_cleared', 0, 'shares_deactivated', 0,
    'drafts_translated', 0, 'drafts_discarded', 0, 'comments_translated', 0);
  v_claims jsonb := jsonb_build_object('moved', 0, 'left', 0, 'moved_ids', '[]'::jsonb);
  v_labels jsonb;
  v_comments_translated int := 0;
  v_links jsonb;
  v_residue jsonb;
  v_moving jsonb;
  v_counts jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT p.workspace_id, p.name,
         (p.user_id = v_user_id) OR EXISTS (
           SELECT 1 FROM public.member m
           WHERE m.id = p.lead_id AND m.user_id = v_user_id
         )
  INTO v_source, v_name, v_owns
  FROM public.projects p
  WHERE p.id = p_project_id
  FOR UPDATE OF p;

  IF v_source IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._wsmove_gate(
    v_user_id, v_source, p_destination_workspace_id, COALESCE(v_owns, false));

  -- 360: a project whose documents move along may not carry the workspace
  -- product doc away unless the caller is an owner or admin of the source
  -- workspace (359's rule: the creator, except the product doc).
  IF p_move_documents
     AND COALESCE((SELECT m.role FROM public.member m
                    WHERE m.workspace_id = v_source AND m.user_id = v_user_id), '')
           NOT IN ('owner', 'admin')
     AND EXISTS (
       SELECT 1 FROM public.document d
        WHERE d.project_id = p_project_id
          AND d.workspace_id = v_source
          AND public.is_product_doc(d.workspace_id, d.id)
     ) THEN
    RAISE EXCEPTION 'only an owner or admin can move a project holding the workspace product doc'
      USING ERRCODE = '42501';
  END IF;

  -- 369: documents moving along may not carry someone else's private
  -- document (the caller can't read it, so can't carry it somewhere they can).
  IF p_move_documents AND EXISTS (
       SELECT 1 FROM public.document d
        WHERE d.project_id = p_project_id
          AND d.workspace_id = v_source
          AND d.visibility = 'private'
          AND NOT EXISTS (
            SELECT 1 FROM public.member m
             WHERE m.id = d.created_by AND m.user_id = v_user_id
          )
     ) THEN
    RAISE EXCEPTION 'the project holds someone else''s private document'
      USING ERRCODE = '42501';
  END IF;

  -- After the gate: a P0005 before it would tell a non-member whether a
  -- guessed project id is a workspace's default bucket (existence oracle).
  IF v_name = '__default__' THEN
    RAISE EXCEPTION 'the default project cannot be moved' USING ERRCODE = 'P0005';
  END IF;

  SELECT team_id, default_status_id
  INTO v_dest_team, v_dest_default_status
  FROM public._wsmove_dest_team(p_destination_workspace_id, p_destination_team_id);

  -- ── the closure sets ──
  SELECT COALESCE(array_agg(id), '{}') INTO v_action_ids
  FROM public.actions
  WHERE project_id = p_project_id AND workspace_id = v_source;

  SELECT COALESCE(array_agg(id), '{}') INTO v_milestone_ids
  FROM public.milestone
  WHERE project_id = p_project_id;

  IF p_move_documents THEN
    SELECT COALESCE(array_agg(id), '{}') INTO v_doc_ids
    FROM public.document
    WHERE project_id = p_project_id AND workspace_id = v_source;
  END IF;

  -- ── captures stay; unlink them ──
  WITH unlinked AS (
    UPDATE public.captures
    SET project_id = NULL
    WHERE project_id = p_project_id AND workspace_id = v_source
    RETURNING id
  ),
  chunks AS (
    UPDATE public.capture_chunks cc
    SET project_id = NULL
    FROM unlinked u
    WHERE cc.capture_id = u.id
    RETURNING 1
  )
  SELECT count(*) INTO v_captures_unlinked FROM unlinked;

  -- ── documents: move or unlink ──
  IF p_move_documents THEN
    v_doc_core := public._wsmove_documents_core(
      v_doc_ids, v_source, p_destination_workspace_id,
      true,          -- the project moves with them
      v_action_ids   -- action_document rows to moved actions survive
    );
    IF cardinality(v_doc_ids) > 0 THEN
      v_claims := public._wsmove_claims(
        v_source, p_destination_workspace_id,
        (SELECT jsonb_agg(jsonb_build_object('t', 'document', 'i', d))
         FROM unnest(v_doc_ids) d)
      );
    END IF;
  ELSE
    WITH unlinked AS (
      UPDATE public.document
      SET project_id = NULL
      WHERE project_id = p_project_id AND workspace_id = v_source
      RETURNING id
    ),
    chunks AS (
      UPDATE public.document_chunks dc
      SET project_id = NULL
      FROM unlinked u
      WHERE dc.document_id = u.id
      RETURNING 1
    )
    SELECT count(*) INTO v_docs_unlinked FROM unlinked;
  END IF;

  -- ── all the project's actions move with it ──
  v_core := public._wsmove_actions_core(
    v_action_ids, v_source, p_destination_workspace_id,
    v_dest_team, v_dest_default_status,
    true,   -- keep project/milestone links: they move in this transaction
    true,   -- source captures stay behind
    v_doc_ids
  );

  -- ── the project row itself ──
  UPDATE public.projects p
  SET workspace_id = p_destination_workspace_id,
      initiative_id = NULL,
      lead_id = public._wsmove_member_in(p.lead_id, p_destination_workspace_id),
      cloud_env_id = NULL,
      parent_project_id = NULL
  WHERE p.id = p_project_id;

  -- sub-projects that stay lose their parent pointer
  UPDATE public.projects
  SET parent_project_id = NULL
  WHERE workspace_id = v_source AND parent_project_id = p_project_id;

  -- milestones travel by construction (project_id NOT NULL, no workspace
  -- column); actions in OTHER projects that pointed at them must let go
  UPDATE public.actions
  SET milestone_id = NULL
  WHERE workspace_id = v_source
    AND milestone_id = ANY(v_milestone_ids)
    AND NOT (id = ANY(v_action_ids));

  v_labels := public._wsmove_remap_labels(
    'project_label', 'project_id', ARRAY[p_project_id], v_source, p_destination_workspace_id);

  v_comments_translated := public._wsmove_comments(
    'project', ARRAY[p_project_id], v_source, p_destination_workspace_id);

  UPDATE public.project_embedding
  SET workspace_id = p_destination_workspace_id
  WHERE project_id = p_project_id;

  -- decisions never move (capture-owned): suggested ones let go of the
  -- project, confirmed ones keep the user-set attribution (v2 precedent)
  UPDATE public.decision
  SET project_id = NULL
  WHERE project_id = p_project_id
    AND confirmation = 'suggested';

  -- project-parented attachments follow
  SELECT COALESCE(array_agg(id), '{}') INTO v_attachment_ids
  FROM public.attachments
  WHERE project_id = p_project_id AND workspace_id = v_source;

  UPDATE public.attachments
  SET workspace_id = p_destination_workspace_id
  WHERE id = ANY(v_attachment_ids);

  UPDATE public.attachment_chunks
  SET workspace_id = p_destination_workspace_id
  WHERE attachment_id = ANY(v_attachment_ids);

  -- project-scoped saved views reference workspace-scoped filter ids that
  -- don't translate; deleted (counted, disclosed in preflight)
  WITH gone AS (
    DELETE FROM public.view
    WHERE workspace_id = v_source
      AND scope_type = 'project'
      AND scope_id = p_project_id
    RETURNING 1
  )
  SELECT count(*) INTO v_views_deleted FROM gone;

  -- packages that curated by this project stop doing so
  UPDATE public.knowledge_package kp
  SET rules = jsonb_set(
    kp.rules, '{projects}',
    COALESCE((
      SELECT jsonb_agg(x)
      FROM jsonb_array_elements(kp.rules->'projects') x
      WHERE x <> to_jsonb(p_project_id::text)
    ), '[]'::jsonb))
  WHERE kp.workspace_id = v_source
    AND jsonb_typeof(kp.rules->'projects') = 'array'
    AND kp.rules->'projects' @> to_jsonb(p_project_id::text);

  -- ── graph + residue ──
  v_moving := jsonb_build_array(jsonb_build_object('t', 'project', 'i', p_project_id))
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'action', 'i', x)) FROM unnest(v_action_ids) x), '[]'::jsonb)
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'document', 'i', x)) FROM unnest(v_doc_ids) x), '[]'::jsonb)
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'milestone', 'i', x)) FROM unnest(v_milestone_ids) x), '[]'::jsonb)
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'attachment', 'i', x)) FROM unnest(v_attachment_ids) x), '[]'::jsonb)
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'attachment', 'i', a)) FROM jsonb_array_elements_text(v_core->'attachment_ids') a), '[]'::jsonb)
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'claim', 'i', c)) FROM jsonb_array_elements_text(v_claims->'moved_ids') c), '[]'::jsonb);

  v_links := public._wsmove_entity_links(v_source, p_destination_workspace_id, v_moving);
  v_residue := public._wsmove_residue(v_source, p_destination_workspace_id, v_moving);

  v_counts := jsonb_build_object(
    'moved_actions', v_core->'moved',
    'identifier_map', v_core->'identifier_map',
    'renumbered', v_core->'renumbered',
    'moved_documents', v_doc_core->'moved',
    'documents_unlinked', v_docs_unlinked,
    'moved_milestones', cardinality(v_milestone_ids),
    'captures_unlinked', v_captures_unlinked,
    'moved_claims', v_claims->'moved',
    'shared_claims_left', v_claims->'left',
    'labels_remapped', v_labels->'remapped',
    'labels_removed', v_labels->'deleted',
    'action_labels_remapped', v_core->'labels'->'remapped',
    'action_labels_removed', v_core->'labels'->'deleted',
    'assignees_translated', v_core->'assignees_translated',
    'assignees_dropped', v_core->'assignees_dropped',
    'external_tasks_severed', v_core->'external_tasks_severed',
    'agent_runs_removed', v_core->'agent_runs_removed',
    'comments_translated',
      (v_core->>'comments_translated')::int
      + (v_doc_core->>'comments_translated')::int
      + v_comments_translated,
    'drafts_translated', v_doc_core->'drafts_translated',
    'drafts_discarded', v_doc_core->'drafts_discarded',
    'attachments_moved',
      cardinality(v_attachment_ids) + jsonb_array_length(v_core->'attachment_ids'),
    'slugs_cleared', v_doc_core->'slugs_cleared',
    'shares_deactivated', v_doc_core->'shares_deactivated',
    'views_deleted', v_views_deleted,
    'links_moved', v_links->'moved',
    'links_severed', v_links->'severed'
  ) || v_residue;

  INSERT INTO public.workspace_move_log
    (entity_type, entity_id, source_workspace_id, destination_workspace_id, moved_by, counts)
  VALUES ('project', p_project_id, v_source, p_destination_workspace_id, v_user_id, v_counts);

  RETURN jsonb_build_object(
    'project_id', p_project_id,
    'source_workspace_id', v_source,
    'destination_workspace_id', p_destination_workspace_id,
    'destination_team_id', v_dest_team,
    'counts', v_counts
  );
END;
$$;

REVOKE ALL ON FUNCTION public.move_project(uuid, uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_project(uuid, uuid, uuid, boolean) TO authenticated;

-- ------------------------------------------------------------
-- 7. Backfill: meeting preps are their person's
-- ------------------------------------------------------------

UPDATE public.document d
   SET visibility = 'private',
       created_by = COALESCE(
         (SELECT m.id FROM public.member m
           WHERE m.workspace_id = d.workspace_id
             AND m.user_id::text = d.frontmatter -> 'meeting_prep' ->> 'userId'
           LIMIT 1),
         d.created_by)
 WHERE d.frontmatter ? 'meeting_prep'
   AND d.visibility = 'workspace'
   AND COALESCE(
         (SELECT m.id FROM public.member m
           WHERE m.workspace_id = d.workspace_id
             AND m.user_id::text = d.frontmatter -> 'meeting_prep' ->> 'userId'
           LIMIT 1),
         d.created_by) IS NOT NULL
   AND NOT private.is_system_document(d.workspace_id, d.id, d.canon_key);

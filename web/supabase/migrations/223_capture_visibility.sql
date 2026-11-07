-- 223: Capture visibility scope — "Workspace" vs "Only me"
--
-- Every workspace member currently sees every capture: captures_select
-- (migration 028) is a bare is_workspace_member(workspace_id) with no per-row
-- restriction, and every derived table reaches the same conclusion through an
-- EXISTS join on captures. A user who records something unrelated to the team
-- (a personal call, an interview, a 1:1) has no way to keep it out of their
-- teammates' lists, search, dashboards, or AI answers. This is orthogonal to
-- the external `share` table, which governs access from OUTSIDE the workspace.
--
-- Design decisions:
--
--   * Two tiers only, keyed on captures.user_id — modelled on the lightweight
--     138_feedback_visibility pattern, NOT the 3-tier + share-grant machinery
--     of 058_contact_visibility. The CHECK constraint keeps adding a 'team'
--     tier later a one-line change.
--
--   * NO admin/owner read override. "Only me" means only me. Admins keep their
--     existing DELETE right (captures_delete is untouched) but cannot read the
--     content. captures_insert is likewise untouched — a new row is 'workspace'
--     by default and its creator is always the writer.
--
--   * Derived content inherits the capture's visibility until a human promotes
--     it: capture_participant, capture_chunks, capture_references, decision,
--     proposed_change, capture-parented attachments, and capture comments all
--     extend their existing EXISTS(... captures c ...) with the same predicate.
--     Confirming is an act of sharing, so confirmed items stay visible:
--     actions get that for free (public.actions is team-scoped and carries no
--     capture join), but decision has no policy of its own, so its two policies
--     carry an explicit `OR confirmation = 'confirmed'` — and so does the
--     unified_search decision branch, the only search surface that reaches a
--     decision without going through its capture first.
--
--   * The search RPCs are SECURITY DEFINER (RLS does not apply inside them) and
--     the service-role callers behind MCP / eve / device-token chat bypass RLS
--     entirely, so each search RPC gains a trailing p_requesting_user_id and
--     resolves v_requester := COALESCE(p_requesting_user_id, auth.uid()). A
--     caller that passes nothing and carries no JWT gets v_requester = NULL and
--     therefore sees NO private captures — fail closed, which is exactly what
--     unattended runs (loops, skills, weaver briefs) want, since their output
--     lands in workspace-readable tables. The param is LAST with a DEFAULT so
--     every existing named-argument call site keeps working untouched.
--
--   * Claims are gated by SOURCE visibility rather than a column of their own:
--     a claim is visible iff it has no sources at all, or at least one source
--     that is not hidden. 'capture' sources resolve directly and 'attachment'
--     sources resolve through attachments.note_id to their capture parent (the
--     `ingest_source` AI tool accepts source_type 'attachment', so this is a
--     live path, not a hypothetical); all other source types always count.
--     Nothing is re-indexed and no backfill is needed — a visibility flip takes
--     effect on the next read, in both directions.
--
--   * rag_search / attachment_rag_search keep their chunk-user_id keying but
--     gain a parent-capture EXISTS on top. Chunk user_id is NOT the capture
--     owner: the capture PATCH route re-indexes as the EDITING user, so a
--     teammate who fixed a title owns those chunks forever. Their signatures
--     are unchanged (they already search as a known user), so no call site and
--     no grant moves.
--
--   * The storage.objects read policy for the attachments bucket is re-created
--     with the same term. A policy's own USING clause is evaluated with row
--     security suppressed, so hardening public.attachments does not reach the
--     bytes — the raw object needs the predicate spelled out again.

-- ============================================================
-- 1. The column
-- ============================================================

ALTER TABLE public.captures
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'workspace';

ALTER TABLE public.captures DROP CONSTRAINT IF EXISTS captures_visibility_check;
ALTER TABLE public.captures ADD CONSTRAINT captures_visibility_check
  CHECK (visibility IN ('workspace', 'private'));

-- Partial index: the hot path is "hide the few private rows", so only those
-- are worth indexing.
CREATE INDEX IF NOT EXISTS idx_captures_visibility_private
  ON public.captures (user_id)
  WHERE visibility = 'private';

COMMENT ON COLUMN public.captures.visibility IS
  '''workspace'' (default: every workspace member) or ''private'' (only '
  'captures.user_id — no admin override). Derived content inherits this.';

-- ============================================================
-- 2. Helper functions
-- ============================================================
--
-- SECURITY DEFINER STABLE with a pinned search_path, same posture as
-- is_workspace_member / can_view_contact. Both fail CLOSED: a NULL p_user_id
-- (service-role caller that did not identify itself) can never see a private
-- capture, and a dangling id resolves to false.

CREATE OR REPLACE FUNCTION public.capture_visible_to(
  p_capture_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.captures c
    WHERE c.id = p_capture_id
      AND (c.visibility = 'workspace'
           OR (p_user_id IS NOT NULL AND c.user_id = p_user_id))
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

-- A claim is visible iff it has NO sources at all, or at least one source that
-- is not a hidden capture. Sources of type 'capture' resolve directly; sources
-- of type 'attachment' resolve through attachments.note_id (the capture parent)
-- because an attachment on a private capture is capture-derived content and is
-- hidden everywhere else in this migration — an attachment with a NULL note_id
-- or a non-capture parent has no capture to inherit from and stays visible.
-- Every other source type (document, email, external_url, manual) always counts
-- as visible. A capture source with a dangling source_id counts as HIDDEN — the
-- evidence cannot be shown to be shareable, so we do not assume it is; a
-- dangling ATTACHMENT source is likewise hidden, for the same reason.
CREATE OR REPLACE FUNCTION public.claim_visible_to(
  p_claim_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN AS $$
  SELECT
    NOT EXISTS (SELECT 1 FROM public.claim_source cs WHERE cs.claim_id = p_claim_id)
    OR EXISTS (
      SELECT 1 FROM public.claim_source cs
      WHERE cs.claim_id = p_claim_id
        AND CASE cs.source_type
          WHEN 'capture' THEN EXISTS (
            SELECT 1 FROM public.captures c
            WHERE c.id = cs.source_id
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
                    AND (c.visibility = 'workspace'
                         OR (p_user_id IS NOT NULL AND c.user_id = p_user_id))
                )
              )
          )
          ELSE TRUE
        END
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.capture_visible_to(UUID, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.claim_visible_to(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.capture_visible_to(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_visible_to(UUID, UUID) TO authenticated, service_role;

-- ============================================================
-- 3. RLS — captures itself (bodies from 028)
-- ============================================================
--
-- SELECT and UPDATE gain the predicate. INSERT and DELETE are deliberately
-- unchanged (see header).

DROP POLICY IF EXISTS "captures_select" ON public.captures;
CREATE POLICY "captures_select"
  ON public.captures FOR SELECT
  USING (
    public.is_workspace_member(workspace_id)
    AND (visibility = 'workspace' OR user_id = auth.uid())
  );

DROP POLICY IF EXISTS "captures_update" ON public.captures;
CREATE POLICY "captures_update"
  ON public.captures FOR UPDATE
  USING (
    public.is_workspace_member(workspace_id)
    AND (visibility = 'workspace' OR user_id = auth.uid())
  );

-- ============================================================
-- 4. RLS — derived tables (bodies from 025, 028, 071, 088, 128)
-- ============================================================

-- capture_participant (025). The RESTRICTIVE self-owner guards from 175 are
-- separate policies and are NOT touched here — they AND with these.
DROP POLICY IF EXISTS "Workspace members can view capture participants" ON public.capture_participant;
CREATE POLICY "Workspace members can view capture participants"
  ON public.capture_participant FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.captures c
    WHERE c.id = capture_id AND public.is_workspace_member(c.workspace_id)
      AND (c.visibility = 'workspace' OR c.user_id = auth.uid())
  ));

DROP POLICY IF EXISTS "Workspace members can manage capture participants" ON public.capture_participant;
CREATE POLICY "Workspace members can manage capture participants"
  ON public.capture_participant FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.captures c
    WHERE c.id = capture_id AND public.is_workspace_member(c.workspace_id)
      AND (c.visibility = 'workspace' OR c.user_id = auth.uid())
  ));

-- capture_chunks (028)
DROP POLICY IF EXISTS "capture_chunks_select" ON public.capture_chunks;
CREATE POLICY "capture_chunks_select"
  ON public.capture_chunks FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.captures c
    WHERE c.id = capture_id AND public.is_workspace_member(c.workspace_id)
      AND (c.visibility = 'workspace' OR c.user_id = auth.uid())
  ));

DROP POLICY IF EXISTS "capture_chunks_insert" ON public.capture_chunks;
CREATE POLICY "capture_chunks_insert"
  ON public.capture_chunks FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.captures c
    WHERE c.id = capture_id AND public.is_workspace_member(c.workspace_id)
      AND (c.visibility = 'workspace' OR c.user_id = auth.uid())
  ));

DROP POLICY IF EXISTS "capture_chunks_delete" ON public.capture_chunks;
CREATE POLICY "capture_chunks_delete"
  ON public.capture_chunks FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.captures c
    WHERE c.id = capture_id AND public.is_workspace_member(c.workspace_id)
      AND (c.visibility = 'workspace' OR c.user_id = auth.uid())
  ));

-- capture_references (028)
DROP POLICY IF EXISTS "capture_references_all" ON public.capture_references;
CREATE POLICY "capture_references_all"
  ON public.capture_references FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.captures c
    WHERE c.id = capture_id AND public.is_workspace_member(c.workspace_id)
      AND (c.visibility = 'workspace' OR c.user_id = auth.uid())
  ));

-- decision (025). Unlike actions, a decision has NO workspace-scoped policy of
-- its own — capture_id is NOT NULL and the capture join is its only visibility
-- path — so the "confirming is an act of sharing" carve-out has to live here or
-- flipping a capture private would silently retract decisions the team already
-- promoted into shared knowledge. confirmation is
-- 'suggested' | 'confirmed' | 'dismissed' (025); only 'confirmed' is the human
-- act of sharing, so suggested/dismissed rows stay gated with the capture.
-- The ALL policy carries the same carve-out: a confirmed decision is workspace
-- content, and editing what you can read is the pre-existing workspace rule.
DROP POLICY IF EXISTS "Workspace members can view decisions" ON public.decision;
CREATE POLICY "Workspace members can view decisions"
  ON public.decision FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.captures c
    WHERE c.id = capture_id AND public.is_workspace_member(c.workspace_id)
      AND (c.visibility = 'workspace'
           OR c.user_id = auth.uid()
           OR decision.confirmation = 'confirmed')
  ));

DROP POLICY IF EXISTS "Workspace members can manage decisions" ON public.decision;
CREATE POLICY "Workspace members can manage decisions"
  ON public.decision FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.captures c
    WHERE c.id = capture_id AND public.is_workspace_member(c.workspace_id)
      AND (c.visibility = 'workspace'
           OR c.user_id = auth.uid()
           OR decision.confirmation = 'confirmed')
  ));

-- proposed_change (071). These were workspace-keyed only (no captures join at
-- all); every row belongs to a capture (capture_id NOT NULL), so the join is
-- added here rather than merely extended.
DROP POLICY IF EXISTS "Members can view proposed changes" ON public.proposed_change;
CREATE POLICY "Members can view proposed changes"
  ON public.proposed_change FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.member WHERE user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM public.captures c
      WHERE c.id = capture_id
        AND (c.visibility = 'workspace' OR c.user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "Members can insert proposed changes" ON public.proposed_change;
CREATE POLICY "Members can insert proposed changes"
  ON public.proposed_change FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM public.member WHERE user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM public.captures c
      WHERE c.id = capture_id
        AND (c.visibility = 'workspace' OR c.user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "Members can update proposed changes" ON public.proposed_change;
CREATE POLICY "Members can update proposed changes"
  ON public.proposed_change FOR UPDATE
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.member WHERE user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM public.captures c
      WHERE c.id = capture_id
        AND (c.visibility = 'workspace' OR c.user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "Members can delete proposed changes" ON public.proposed_change;
CREATE POLICY "Members can delete proposed changes"
  ON public.proposed_change FOR DELETE
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.member WHERE user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM public.captures c
      WHERE c.id = capture_id
        AND (c.visibility = 'workspace' OR c.user_id = auth.uid())
    )
  );

-- attachments (128). Only the SELECT policy moves; attachments_workspace_delete
-- and the owner-scoped policies are untouched. note_id is the capture parent —
-- action- and project-parented attachments (note_id NULL) are unaffected.
DROP POLICY IF EXISTS attachments_workspace_select ON public.attachments;
CREATE POLICY attachments_workspace_select ON public.attachments
  FOR SELECT USING (
    public.is_workspace_member(workspace_id)
    AND (
      note_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.captures c
        WHERE c.id = attachments.note_id
          AND (c.visibility = 'workspace' OR c.user_id = auth.uid())
      )
    )
  );

-- comment (088). Only the 'capture' branch of the CASE is gated; 'action' and
-- 'document' comments and the external-commenter branch are byte-identical to
-- 088. INSERT/UPDATE/DELETE are left alone — a comment you cannot read is a
-- comment you cannot address, and the capture itself is already unreachable.
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
      )
    END
  );

-- ============================================================
-- 4b. Retire the old search-RPC signatures FIRST
-- ============================================================
--
-- Adding a trailing defaulted param means CREATE OR REPLACE cannot reuse the
-- existing function — Postgres treats the new arity as a separate overload and
-- would leave the old one installed alongside it. Every call site goes through
-- PostgREST rpc() with NAMED arguments, so resolution would still land on the
-- right overload, but leaving a second definition around is exactly how a
-- future edit silently patches only one of the two. Drop them up front so each
-- name ends this migration with a single definition.
--
-- CASCADE is deliberately NOT used: nothing depends on these (they are called,
-- not referenced), and a surprise dependency should fail loudly here.

DROP FUNCTION IF EXISTS public.hybrid_search(UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT);
DROP FUNCTION IF EXISTS public.hybrid_search_attachments(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION);
DROP FUNCTION IF EXISTS public.unified_search(UUID, TEXT, TEXT[], INTEGER);
DROP FUNCTION IF EXISTS public.match_claims(TEXT, TEXT, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.match_claims(TEXT, TEXT, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT, DOUBLE PRECISION);
DROP FUNCTION IF EXISTS public.match_claims(TEXT, TEXT, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT, DOUBLE PRECISION, TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.claim_neighborhood(TEXT, TEXT, TEXT, INTEGER, INTEGER);

-- ============================================================
-- 5. hybrid_search — body verbatim from 186 (the live definition; 182 shipped
--    it, 186 replaced the document branch). Adds p_requesting_user_id.
-- ============================================================
--
-- Three branches change:
--   * capture_fts / capture_vec / capture_final gain the capture predicate.
--     capture_recency and capture_union derive from those, so they follow.
--   * claim_fts / claim_vec gain the claim source-visibility predicate.
--   * claim_top_source / claim_final's capture LEFT JOIN for source_label
--     gains it too, so a claim visible through some OTHER source never leaks a
--     private capture's title as its provenance label.
-- The document branch is untouched.

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
            jsonb_build_object('duration_seconds', c.duration_seconds, 'project_id', c.project_id) AS metadata
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

-- New signature (13 args) — Postgres default-grants EXECUTE to PUBLIC on new
-- functions and this repo has re-opened that hole repeatedly (111→117→126).
REVOKE EXECUTE ON FUNCTION public.hybrid_search(UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hybrid_search(UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, UUID) TO authenticated, service_role;


-- ============================================================
-- 6. hybrid_search_attachments — body verbatim from 183.
-- ============================================================
--
-- Attachments link to a capture through attachments.note_id. A chunk whose
-- attachment hangs off a hidden capture is dropped; action-/project-parented
-- attachments (note_id NULL) are unaffected.

CREATE OR REPLACE FUNCTION public.hybrid_search_attachments(
    p_workspace_id   UUID,
    p_embedding      TEXT DEFAULT NULL,           -- Gemini 3072-d as '[..]' text; NULL → no results
    p_since          TIMESTAMPTZ DEFAULT NULL,
    p_until          TIMESTAMPTZ DEFAULT NULL,
    p_limit          INTEGER DEFAULT 20,
    p_candidate_k    INTEGER DEFAULT 40,
    p_w_vec          DOUBLE PRECISION DEFAULT 1.0,
    p_w_recent       DOUBLE PRECISION DEFAULT 0.5,
    p_requesting_user_id UUID DEFAULT NULL        -- NULL → auth.uid(); still NULL → private captures excluded
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
    v_embedding halfvec(3072) := CASE WHEN p_embedding IS NULL THEN NULL ELSE p_embedding::halfvec(3072) END;
    v_requester uuid := COALESCE(p_requesting_user_id, auth.uid());
BEGIN
    IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(p_workspace_id) THEN
        RETURN;
    END IF;

    IF v_embedding IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH
    -- Best-ranking chunk per attachment (an attachment has many chunks; we fuse
    -- at the attachment level, not the chunk level).
    attachment_vec AS (
        SELECT id, MIN(rnk)::int AS rnk, (ARRAY_AGG(chunk_text ORDER BY rnk))[1] AS excerpt
        FROM (
            SELECT ac.attachment_id AS id, ac.chunk_text,
                   ROW_NUMBER() OVER (ORDER BY ac.embedding <=> v_embedding) AS rnk
            FROM public.attachment_chunks ac
            JOIN public.attachments a ON a.id = ac.attachment_id
            WHERE ac.workspace_id = p_workspace_id AND ac.embedding IS NOT NULL
              AND (p_since IS NULL OR a.created_at >= p_since)
              AND (p_until IS NULL OR a.created_at <= p_until)
              AND (
                  a.note_id IS NULL
                  OR EXISTS (
                      SELECT 1 FROM public.captures c
                      WHERE c.id = a.note_id
                        AND (c.visibility = 'workspace'
                             OR (v_requester IS NOT NULL AND c.user_id = v_requester))
                  )
              )
            ORDER BY ac.embedding <=> v_embedding
            LIMIT p_candidate_k
        ) ranked
        GROUP BY id
    ),
    attachment_recency AS (
        SELECT a.id, ROW_NUMBER() OVER (ORDER BY a.created_at DESC NULLS LAST)::int AS rnk
        FROM public.attachments a JOIN attachment_vec u ON u.id = a.id
    )
    SELECT
        'attachment'::text AS result_type,
        a.id AS result_id,
        a.file_name AS title,
        p_w_vec    * COALESCE(1.0/(60+av.rnk), 0) +
        p_w_recent * COALESCE(1.0/(60+ar.rnk), 0) AS score,
        a.created_at AS event_at,
        NULL::int AS fts_rank,
        av.rnk AS vec_rank,
        ar.rnk AS recency_rank,
        av.excerpt,
        'Attachment'::text AS source_label,
        'attachment'::text AS source_type,
        jsonb_build_object(
            'storage_path', a.storage_path,
            'mime_type', a.mime_type,
            'file_category', a.file_category,
            'parent_capture_id', a.note_id,
            'parent_action_id', a.action_id,
            'project_id', a.project_id
        ) AS metadata
    FROM public.attachments a
    JOIN attachment_vec av ON av.id = a.id
    LEFT JOIN attachment_recency ar ON ar.id = a.id
    ORDER BY score DESC
    LIMIT p_limit;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.hybrid_search_attachments(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hybrid_search_attachments(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, DOUBLE PRECISION, DOUBLE PRECISION, UUID) TO authenticated, service_role;


-- ============================================================
-- 7. unified_search — body verbatim from 126.
-- ============================================================
--
-- Capture branch gains the predicate; the decision branch already joins
-- captures, so it gains it on the same join; the claim branch gains the
-- source-visibility rule. action / document / project branches unchanged.

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
  v_requester uuid := COALESCE(p_requesting_user_id, auth.uid());
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


-- ============================================================
-- 8. match_claims — all three live overloads (7-arg + 8-arg from 126,
--    10-arg from 181). Each gains the source-visibility rule.
-- ============================================================

CREATE OR REPLACE FUNCTION public.match_claims(
    p_workspace_id TEXT,
    p_embedding TEXT,
    p_limit INTEGER DEFAULT 10,
    p_threshold DOUBLE PRECISION DEFAULT 0.3,
    p_type TEXT DEFAULT NULL,
    p_confirmation TEXT DEFAULT NULL,
    p_status TEXT DEFAULT 'active',
    p_requesting_user_id UUID DEFAULT NULL
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
    v_requester UUID := COALESCE(p_requesting_user_id, auth.uid());
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
      AND public.claim_visible_to(c.id, v_requester)
    ORDER BY cc.embedding <=> v_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT, UUID) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.match_claims(
    p_workspace_id TEXT,
    p_embedding TEXT,
    p_limit INTEGER,
    p_threshold DOUBLE PRECISION,
    p_type TEXT,
    p_confirmation TEXT,
    p_status TEXT,
    p_min_confidence DOUBLE PRECISION,
    p_requesting_user_id UUID DEFAULT NULL
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
    v_requester UUID := COALESCE(p_requesting_user_id, auth.uid());
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
      AND public.claim_visible_to(c.id, v_requester)
    ORDER BY cc.embedding <=> v_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT, DOUBLE PRECISION, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT, DOUBLE PRECISION, UUID) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.match_claims(
    p_workspace_id   TEXT,
    p_embedding      TEXT,
    p_limit          INTEGER,
    p_threshold      DOUBLE PRECISION,
    p_type           TEXT,
    p_confirmation   TEXT,
    p_status         TEXT,
    p_min_confidence DOUBLE PRECISION,
    p_event_after    TIMESTAMPTZ,
    p_event_before   TIMESTAMPTZ,
    p_requesting_user_id UUID DEFAULT NULL
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
    v_requester UUID := COALESCE(p_requesting_user_id, auth.uid());
BEGIN
    -- End-user calls must belong to the workspace; service-role callers
    -- (no JWT identity) pass through. Same gate as 126.
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
      -- Event-time range: a claim with a NULL event_at is honestly unknown-time
      -- and is EXCLUDED whenever a bound is supplied (mirrors hybrid_search — a
      -- time-windowed query must not surface undated facts as if they qualified).
      AND (p_event_after IS NULL OR (c.event_at IS NOT NULL AND c.event_at >= p_event_after))
      AND (p_event_before IS NULL OR (c.event_at IS NOT NULL AND c.event_at <= p_event_before))
      AND public.claim_visible_to(c.id, v_requester)
    ORDER BY cc.embedding <=> v_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT, DOUBLE PRECISION, TIMESTAMPTZ, TIMESTAMPTZ, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT, DOUBLE PRECISION, TIMESTAMPTZ, TIMESTAMPTZ, UUID) TO authenticated, service_role;


-- ============================================================
-- 9. claim_neighborhood — body verbatim from 125.
-- ============================================================
--
-- Two gates, both on the graph traversal itself rather than only the labels:
-- an entity_link edge is dropped when either endpoint is a hidden capture or a
-- hidden claim, so a private capture cannot even be inferred from the shape of
-- the neighborhood. The label LEFT JOINs get the same predicate as a belt-and-
-- braces measure (an endpoint that slipped through renders as a NULL label).

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
    LEFT JOIN public.chat_conversations conv ON ep.node_type = 'conversation' AND conv.id = ep.node_id AND conv.workspace_id = v_workspace_id;

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


-- ============================================================
-- 9b. rag_search / attachment_rag_search — bodies verbatim from 126,
--     each with ONE added EXISTS.
-- ============================================================
--
-- These two are caller-keyed on chunk user_id, so they were originally left
-- alone. But the chunk's user_id is the user who last INDEXED the capture, not
-- its owner: reindexCaptureBestEffort (the capture PATCH route) passes the
-- EDITING user, and the PATCH route is deliberately workspace-scoped because
-- teammates may fix each other's capture titles. indexCapture deletes and
-- re-inserts every chunk with that user_id, so a teammate who edited the title
-- while the capture was still 'workspace' owns its chunks forever — and keeps
-- reading them through these SECURITY DEFINER functions after the owner flips
-- the capture to 'private'. (The cron path, index-capture-finished.ts, passes
-- the capture owner; the two writers disagree.)
--
-- The fix does NOT widen results: the cc.user_id / ac.user_id keying stays, and
-- an EXISTS on the parent capture is ANDed on top. No p_requesting_user_id is
-- added — these functions already know who they are searching as (v_user_id),
-- and an end-user caller cannot search as anyone else (the auth.uid() guard).
-- Signatures are unchanged, so grants from 126 carry over.

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
      -- 223: chunk ownership does not imply capture visibility (see above).
      AND (c.visibility = 'workspace' OR c.user_id = v_user_id)
      AND (
          (NOT v_has_project_filter AND NOT v_has_capture_filter)
          OR (v_has_project_filter AND cc.project_id = ANY(v_project_ids))
          OR (v_has_capture_filter AND cc.capture_id = ANY(v_capture_ids))
      )
    ORDER BY cc.embedding <=> v_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

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
      -- 223: same as rag_search — chunk ownership does not imply that the
      -- attachment's parent capture is still visible to this user.
      AND (
          a.note_id IS NULL
          OR EXISTS (
              SELECT 1 FROM public.captures c
              WHERE c.id = a.note_id
                AND (c.visibility = 'workspace' OR c.user_id = v_user_id)
          )
      )
      AND (
          NOT v_has_project_filter
          OR ac.project_id = ANY(v_project_ids)
      )
    ORDER BY ac.embedding <=> v_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;


-- ============================================================
-- 9c. storage.objects — bodies verbatim from 128, each with the same
--     capture-visibility term the attachments row now carries.
-- ============================================================
--
-- 128's comment says "authorization rides on the row", but Postgres suppresses
-- row security while evaluating a policy's own USING expression (to avoid
-- recursion), so the inner SELECT on public.attachments does NOT inherit the
-- hardened attachments_workspace_select above. Hiding the metadata row is
-- therefore not enough: without this, a teammate who saw the object name while
-- the capture was still 'workspace' (browser history, an already-minted signed
-- URL) keeps byte-level read after the flip. Both the storage_path and the
-- thumbnail_path arms are covered.
DROP POLICY IF EXISTS "attachments workspace read" ON storage.objects;
CREATE POLICY "attachments workspace read" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'attachments' AND EXISTS (
      SELECT 1 FROM public.attachments a
      WHERE (a.storage_path = storage.objects.name OR a.thumbnail_path = storage.objects.name)
        AND public.is_workspace_member(a.workspace_id)
        AND (
          a.note_id IS NULL
          OR EXISTS (
            SELECT 1 FROM public.captures c
            WHERE c.id = a.note_id
              AND (c.visibility = 'workspace' OR c.user_id = auth.uid())
          )
        )
    )
  );


-- ============================================================
-- 10. move_capture — body verbatim from 221 (v3) with ONE added guard.
-- ============================================================
--
-- A private capture may only be moved by its creator. The _wsmove_gate already
-- lets a workspace admin move any capture; that must not become a way to relay
-- someone else's private capture into a workspace where it is readable. Refused
-- as P0002 'capture not found' — the same existence-hiding refusal _wsmove_gate
-- gives non-members — raised right after the row is locked and before any write.

CREATE OR REPLACE FUNCTION public.move_capture(
  p_capture_id UUID,
  p_destination_workspace_id UUID,
  p_confirmed_action_ids UUID[] DEFAULT '{}',
  p_move_claims BOOLEAN DEFAULT TRUE,
  p_move_contacts BOOLEAN DEFAULT TRUE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source_workspace_id UUID;
  v_user_id UUID := auth.uid();
  v_owns boolean;
  v_visibility text;
  v_confirmed_ids UUID[] := COALESCE(p_confirmed_action_ids, '{}');
  v_suggested_action_ids UUID[] := '{}';
  v_moved_action_ids UUID[] := '{}';
  v_attachment_ids UUID[] := '{}';
  v_unlinked_actions INT := 0;
  v_moved_decisions INT := 0;
  v_moved_proposed_changes INT := 0;
  v_copied_contacts INT := 0;
  v_shares_deactivated INT := 0;
  v_threads_unlinked INT := 0;
  v_comments_translated INT := 0;
  v_dest_team_id UUID;
  v_dest_default_status_id UUID;
  v_core jsonb;
  v_claims jsonb := jsonb_build_object('moved', 0, 'left', 0, 'moved_ids', '[]'::jsonb);
  v_labels jsonb;
  v_links jsonb;
  v_residue jsonb;
  v_moving jsonb;
  v_counts jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  -- Lock the capture row and read its source workspace + ownership
  SELECT workspace_id, (user_id = v_user_id), visibility
  INTO v_source_workspace_id, v_owns, v_visibility
  FROM public.captures
  WHERE id = p_capture_id
  FOR UPDATE;

  IF v_source_workspace_id IS NULL THEN
    RAISE EXCEPTION 'capture not found' USING ERRCODE = 'P0002';
  END IF;

  -- 223: a private capture is only ever the creator's to relocate. The role
  -- gate below would let a workspace admin move it, which would republish it
  -- into a workspace where it reads as 'workspace'.
  IF v_visibility = 'private' AND NOT COALESCE(v_owns, false) THEN
    RAISE EXCEPTION 'capture not found' USING ERRCODE = 'P0002';
  END IF;

  -- v3 adds the role gate: plain members may move only their own captures;
  -- guests and non-members are refused (non-members as 'not found').
  PERFORM public._wsmove_gate(
    v_user_id, v_source_workspace_id, p_destination_workspace_id, COALESCE(v_owns, false));

  -- Every requested confirmed-action id must be a confirmed action extracted
  -- from THIS capture, still living in the source workspace (v2 contract).
  IF EXISTS (
    SELECT 1 FROM unnest(v_confirmed_ids) AS req(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.actions a
      WHERE a.id = req.id
        AND a.source_capture_id = p_capture_id
        AND a.confirmation = 'confirmed'
        AND a.workspace_id = v_source_workspace_id
    )
  ) THEN
    RAISE EXCEPTION 'confirmed_action_ids contains an id that is not a confirmed action of this capture'
      USING ERRCODE = 'P0004';
  END IF;

  SELECT team_id, default_status_id
  INTO v_dest_team_id, v_dest_default_status_id
  FROM public._wsmove_dest_team(p_destination_workspace_id, NULL);

  -- Collect the id sets everything below works from.
  SELECT COALESCE(array_agg(id), '{}') INTO v_suggested_action_ids
  FROM public.actions
  WHERE source_capture_id = p_capture_id
    AND confirmation = 'suggested'
    AND workspace_id = v_source_workspace_id;

  v_moved_action_ids := v_suggested_action_ids || v_confirmed_ids;

  SELECT COALESCE(array_agg(id), '{}') INTO v_attachment_ids
  FROM public.attachments
  WHERE note_id = p_capture_id;

  -- ── confirmed actions the caller chose to LEAVE BEHIND: unlink only ──
  UPDATE public.actions
  SET source_capture_id = NULL
  WHERE source_capture_id = p_capture_id
    AND confirmation = 'confirmed'
    AND NOT (id = ANY(v_confirmed_ids));

  GET DIAGNOSTICS v_unlinked_actions = ROW_COUNT;

  -- ── attention cards for this capture's proposals die with the source
  --    context (member-scoped rows can't follow) ──
  DELETE FROM public.attention_item ai
  USING public.proposed_change pc
  WHERE ai.proposal_id = pc.id
    AND pc.capture_id = p_capture_id
    AND ai.workspace_id = v_source_workspace_id;

  -- ── the capture subtree ──
  UPDATE public.captures
  SET workspace_id = p_destination_workspace_id,
      project_id = NULL,
      team_id = NULL
  WHERE id = p_capture_id;

  UPDATE public.capture_chunks
  SET workspace_id = p_destination_workspace_id,
      project_id = NULL
  WHERE capture_id = p_capture_id;

  -- v3: reference rows + the extraction ledger carry workspace ids too
  UPDATE public.capture_references
  SET workspace_id = p_destination_workspace_id,
      project_id = NULL
  WHERE capture_id = p_capture_id;

  UPDATE public.extraction_pass
  SET workspace_id = p_destination_workspace_id
  WHERE capture_id = p_capture_id;

  -- v3: the capture's AI thread is UNLINKED, not moved. Re-stamping would
  -- strand threads the mover doesn't own (personal RLS + foreign workspace
  -- filter) and let claim extraction replay pre-move source content into
  -- destination-visible claims. Severing frees the unique capture index so
  -- the destination can mint a fresh thread.
  WITH unlinked AS (
    UPDATE public.chat_conversations
    SET capture_id = NULL
    WHERE capture_id = p_capture_id
    RETURNING 1
  )
  SELECT count(*) INTO v_threads_unlinked FROM unlinked;

  -- v3: labels remap by name instead of vanishing
  v_labels := public._wsmove_remap_labels(
    'capture_label', 'capture_id', ARRAY[p_capture_id],
    v_source_workspace_id, p_destination_workspace_id);

  -- v3: comment authors translate (see _wsmove_comments)
  v_comments_translated := public._wsmove_comments(
    'capture', ARRAY[p_capture_id], v_source_workspace_id, p_destination_workspace_id);

  -- capture-parented attachments (storage authz follows the row); the
  -- capture's project stays behind, so the attachments' project link does too
  UPDATE public.attachments
  SET workspace_id = p_destination_workspace_id,
      project_id = NULL
  WHERE note_id = p_capture_id;

  UPDATE public.attachment_chunks
  SET workspace_id = p_destination_workspace_id,
      project_id = NULL
  WHERE attachment_id = ANY(v_attachment_ids);

  -- staged proposals follow; their workspace-scoped fields reset
  UPDATE public.proposed_change
  SET workspace_id = p_destination_workspace_id,
      assignee_member_id = NULL,
      assignee_contact_id = NULL,
      team_id = NULL,
      project_id = NULL,
      labels = ARRAY[]::text[]
  WHERE capture_id = p_capture_id;

  GET DIAGNOSTICS v_moved_proposed_changes = ROW_COUNT;

  -- ── extracted actions: all suggestions + the selected confirmed ids ──
  v_core := public._wsmove_actions_core(
    v_moved_action_ids, v_source_workspace_id, p_destination_workspace_id,
    v_dest_team_id, v_dest_default_status_id,
    false,  -- their project stays behind
    false   -- the capture moves WITH them: keep source_capture_id
  );

  -- ── decisions follow by construction; suggested ones let go of the
  --    project, and v3 translates the decider ──
  UPDATE public.decision
  SET project_id = NULL
  WHERE capture_id = p_capture_id
    AND confirmation = 'suggested';

  UPDATE public.decision d
  SET decided_by = public._wsmove_member_in(d.decided_by, p_destination_workspace_id)
  WHERE d.capture_id = p_capture_id
    AND d.decided_by IS NOT NULL;

  SELECT count(*) INTO v_moved_decisions
  FROM public.decision
  WHERE capture_id = p_capture_id;

  -- ── public links die in place (v3): share + share_comment stay in the
  --    SOURCE workspace, deactivated ──
  WITH deactivated AS (
    UPDATE public.share
    SET is_active = false
    WHERE shareable_type = 'capture'
      AND shareable_id = p_capture_id
      AND workspace_id = v_source_workspace_id
      AND is_active
    RETURNING 1
  )
  SELECT count(*) INTO v_shares_deactivated FROM deactivated;

  -- ── knowledge claims (sole-sourced by this capture/its attachments) ──
  IF p_move_claims THEN
    v_claims := public._wsmove_claims(
      v_source_workspace_id, p_destination_workspace_id,
      jsonb_build_array(jsonb_build_object('t', 'capture', 'i', p_capture_id))
        || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'attachment', 'i', a))
                     FROM unnest(v_attachment_ids) a), '[]'::jsonb)
    );
  END IF;

  -- ── graph edges ──
  v_moving := jsonb_build_array(jsonb_build_object('t', 'capture', 'i', p_capture_id))
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'attachment', 'i', a)) FROM unnest(v_attachment_ids) a), '[]'::jsonb)
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'attachment', 'i', a)) FROM jsonb_array_elements_text(v_core->'attachment_ids') a), '[]'::jsonb)
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'action', 'i', x)) FROM unnest(v_moved_action_ids) x), '[]'::jsonb)
    || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'claim', 'i', c)) FROM jsonb_array_elements_text(v_claims->'moved_ids') c), '[]'::jsonb);

  v_links := public._wsmove_entity_links(v_source_workspace_id, p_destination_workspace_id, v_moving);

  -- ── participant contacts: copy auto-created ones the mover CAN SEE
  --    (v3 adds the can_view_contact gate — v2 copied private contacts the
  --    mover had no right to read) ──
  IF p_move_contacts THEN
    WITH src_contacts AS (
      SELECT c.*
      FROM public.contact c
      WHERE c.workspace_id = v_source_workspace_id
        AND c.email IS NOT NULL
        AND c.source IN ('capture_participant', 'calendar_sync')
        AND public.can_view_contact(c.id, c.workspace_id, c.visibility, c.created_by_member_id)
        AND c.id IN (
          SELECT cp.contact_id
          FROM public.capture_participant cp
          WHERE cp.capture_id = p_capture_id
            AND cp.contact_id IS NOT NULL
        )
    ), inserted AS (
      INSERT INTO public.contact (
        workspace_id, member_id, company_id, created_by_member_id,
        first_name, last_name, full_name, email, secondary_emails, phone,
        avatar_url, job_title, department, linkedin_url,
        relationship_type, relationship_strength, visibility,
        source, source_provider, notes, tags, metadata
      )
      SELECT
        p_destination_workspace_id,
        public._wsmove_member_in(sc.member_id, p_destination_workspace_id),
        (SELECT dco.id
         FROM public.company dco
         JOIN public.company sco ON sco.id = sc.company_id
         WHERE dco.workspace_id = p_destination_workspace_id
           AND (
             (sco.domain IS NOT NULL AND dco.domain = sco.domain)
             OR lower(dco.name) = lower(sco.name)
           )
         ORDER BY (dco.domain IS NOT DISTINCT FROM sco.domain) DESC, dco.created_at ASC
         LIMIT 1),
        -- Attribute the copy to the mover: the visibility gate above means
        -- they could already read everything being copied.
        (SELECT dm.id FROM public.member dm
         WHERE dm.workspace_id = p_destination_workspace_id
           AND dm.user_id = v_user_id
         LIMIT 1),
        sc.first_name, sc.last_name, sc.full_name, sc.email,
        sc.secondary_emails, sc.phone, sc.avatar_url, sc.job_title,
        sc.department, sc.linkedin_url, sc.relationship_type,
        sc.relationship_strength, sc.visibility, sc.source,
        sc.source_provider, sc.notes, sc.tags, sc.metadata
      FROM src_contacts sc
      WHERE NOT EXISTS (
        SELECT 1 FROM public.contact dc
        WHERE dc.workspace_id = p_destination_workspace_id
          AND (
            dc.email = sc.email
            OR sc.email = ANY(COALESCE(dc.secondary_emails, '{}'))
          )
      )
      RETURNING 1
    )
    SELECT count(*) INTO v_copied_contacts FROM inserted;
  END IF;

  -- ── translate participant member/contact refs (v2 logic) ──
  UPDATE public.capture_participant cp
  SET member_id = public._wsmove_member_in(cp.member_id, p_destination_workspace_id)
  WHERE cp.capture_id = p_capture_id
    AND cp.member_id IS NOT NULL;

  UPDATE public.capture_participant cp
  SET contact_id = (
    SELECT dc.id
    FROM public.contact dc
    JOIN public.contact sc ON sc.id = cp.contact_id
    WHERE dc.workspace_id = p_destination_workspace_id
      AND sc.email IS NOT NULL
      AND (
        dc.email = sc.email
        OR sc.email = ANY(COALESCE(dc.secondary_emails, '{}'))
      )
    ORDER BY (dc.email = sc.email) DESC NULLS LAST, dc.created_at ASC
    LIMIT 1
  )
  WHERE cp.capture_id = p_capture_id
    AND cp.contact_id IS NOT NULL;

  -- ── residue on both sides (decisions included in the moving set so their
  --    notifications/pins clean up) ──
  v_residue := public._wsmove_residue(
    v_source_workspace_id, p_destination_workspace_id,
    v_moving || COALESCE((SELECT jsonb_agg(jsonb_build_object('t', 'decision', 'i', d.id))
                          FROM public.decision d
                          WHERE d.capture_id = p_capture_id), '[]'::jsonb)
  );

  v_counts := jsonb_build_object(
    -- v2 keys the shipped client reads
    'unlinked_actions', v_unlinked_actions,
    'moved_suggested_actions', cardinality(v_suggested_action_ids),
    'moved_confirmed_actions', cardinality(v_confirmed_ids),
    'moved_decisions', v_moved_decisions,
    'moved_proposed_changes', v_moved_proposed_changes,
    'moved_claims', v_claims->'moved',
    'shared_claims_left', v_claims->'left',
    'copied_contacts', v_copied_contacts,
    -- v3 additions
    'identifier_map', v_core->'identifier_map',
    'renumbered', v_core->'renumbered',
    'external_tasks_severed', v_core->'external_tasks_severed',
    'agent_runs_removed', v_core->'agent_runs_removed',
    'comments_translated', v_comments_translated + (v_core->>'comments_translated')::int,
    'labels_remapped', v_labels->'remapped',
    'labels_removed', v_labels->'deleted',
    'shares_deactivated', v_shares_deactivated,
    'ai_threads_unlinked', v_threads_unlinked,
    'attachments', cardinality(v_attachment_ids),
    'links_moved', v_links->'moved',
    'links_severed', v_links->'severed'
  ) || v_residue;

  INSERT INTO public.workspace_move_log
    (entity_type, entity_id, source_workspace_id, destination_workspace_id, moved_by, counts)
  VALUES ('capture', p_capture_id, v_source_workspace_id, p_destination_workspace_id, v_user_id, v_counts);

  RETURN jsonb_build_object(
    'capture_id', p_capture_id,
    'source_workspace_id', v_source_workspace_id,
    'destination_workspace_id', p_destination_workspace_id,
    'counts', v_counts
  );
END;
$$;

COMMENT ON FUNCTION public.move_capture(UUID, UUID, UUID[], BOOLEAN, BOOLEAN) IS
  'Move a capture (v3 + 223 visibility guard): v2 semantics plus — '
  'delete-parity role gate, private captures movable only by their creator, '
  'identifier preserve-or-renumber, external task links severed, '
  'claim_source evidence re-stamped, contact copies visibility-gated, AI '
  'thread unlinked, extraction ledger follows, labels remap by name, shares '
  'deactivate in place, residue cleaned. The caller no longer needs to copy '
  'storage objects.';

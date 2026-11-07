-- Migration 275: requester IDENTITY for the visibility-aware search/claims RPCs.
--
-- ============================================================
-- THE BUG (confirmed 2026-09-21)
-- ============================================================
-- Seven SECURITY DEFINER functions resolve the per-user visibility key as
--
--     v_requester := COALESCE(p_requesting_user_id, auth.uid())
--
-- and then fence rows with capture_visible_to(id, v_requester) /
-- claim_visible_to(id, v_requester). Their only authorization guard was
--
--     IF auth.uid() IS NOT NULL AND NOT is_workspace_member(ws) THEN <refuse>
--
-- which checks the SESSION's membership but never checks that the session is
-- the user it is claiming to be. All seven are GRANTed to `authenticated` and
-- reachable from a browser over PostgREST /rpc/<name>. So member A of a
-- workspace could pass member B's user id and read B's private ("Only me")
-- captures, the claims derived solely from them, and their titles/excerpts:
--
--     POST /rest/v1/rpc/claim_neighborhood
--     { "p_workspace_id": "<shared ws>", "p_entity_type": "capture",
--       "p_entity_id": "<B's private capture>", "p_requesting_user_id": "<B>" }
--
-- A's own membership guard passes (A really is a member), and every visibility
-- predicate inside then evaluates against B. Cross-workspace reads were never
-- possible; this is a WITHIN-workspace, private-capture confidentiality bug.
--
-- Affected (latest definition before this migration):
--     claim_neighborhood          (TEXT,TEXT,TEXT,INT,INT,UUID)          — 267
--     hybrid_search               (13-arg)                               — 252
--     hybrid_search_attachments   (9-arg)                                — 252
--     unified_search              (UUID,TEXT,TEXT[],INT,UUID)            — 252
--     match_claims                8-arg / 9-arg / 11-arg overloads       — 223
--
-- Migration 237's header claimed this family "already uses the correct pattern".
-- That was true of the MEMBERSHIP guard and false of IDENTITY. 237's own five
-- functions, and 238's package_row_visible_to / package_row_editable_by, do
-- carry the identity check; this family is the gap.
--
-- ============================================================
-- THE FIX, and why it is NOT _resolve_requester
-- ============================================================
-- 237's public._resolve_requester(p_user_id) RAISES when p_user_id IS NULL.
-- That is right for its five functions, where the requester is the actor and a
-- NULL actor is nonsense. It is WRONG here, because in this family NULL is a
-- deliberate, load-bearing value: unattended runs (skill-run, work-run,
-- flows/run-skill, eval live-agent) build their tools with
-- `omitPrivateCaptures: true` on a SERVICE-ROLE client, and
-- captureRequester() then passes p_requesting_user_id: NULL to mean "no
-- requester — workspace-visible rows only". Dropping _resolve_requester in
-- here would turn every unattended search into a 42501, and an unconditional
-- _is_member_of(NULL, ws) would silently return zero rows. See
-- docs/design-capture-visibility.md and src/lib/ai/tools/_shared.ts.
--
-- So: a NULL-TOLERANT sibling that keeps the one guarantee that was missing.
--
--   public._resolve_visibility_requester(p_user_id)
--     * a live session may NOT assert a different user  → RAISE 42501
--     * otherwise return COALESCE(p_user_id, auth.uid()), which MAY be NULL
--       (sessionless caller asserting no requester → workspace-visible only,
--       the existing fail-closed posture, unchanged)
--
-- and the membership gate becomes
--
--     IF v_requester IS NOT NULL AND NOT _is_member_of(v_requester, ws)
--
-- which is strictly STRONGER than what it replaces: the old gate was skipped
-- entirely whenever auth.uid() was NULL — i.e. for every service-role call,
-- even one asserting an explicit requester. The new gate binds the requester
-- to the workspace whenever a requester is known, from either source. The one
-- remaining unchecked case is "no session AND no asserted requester", which
-- reads only workspace-visible rows and is service-role — a caller that
-- already holds the whole database.
--
-- Truth table (A, B members of ws; C a non-member):
--
--   caller            p_requesting_user_id   before          after
--   ----------------  ---------------------  --------------  -----------------
--   A's browser       NULL                   A's own rows    unchanged
--   A's browser       A                      A's own rows    unchanged
--   A's browser       B                      *** B's rows ***  RAISE 42501
--   A's browser       C                      C's rows(empty) RAISE 42501
--   service role      A                      A's rows, ws    A's rows, and A's
--                                            membership NOT  membership now
--                                            checked         CHECKED
--   service role      NULL                   ws-visible only unchanged
--
-- ============================================================
-- CALLER AUDIT (every rpc() site in src/ that passes p_requesting_user_id)
-- ============================================================
--   search.ts / claims.ts       captureRequester(userId, omitPrivateCaptures)
--                               → userId for interactive runs, NULL for
--                                 unattended ones. Fan-out targets come from
--                                 getUserWorkspaces(userId), which reads the
--                                 `member` table, so the new membership check
--                                 is satisfied by construction.
--   live-agent/tools.ts         userId of the live session, in that session's
--                               workspace → member.
--   inngest/claim-extraction.ts data.userId is the capture OWNER and
--                               data.workspaceId the capture's own workspace
--                               (see index-capture-finished.ts and
--                               capture-reindex.ts) → member.
--
-- One real behavior change falls out of the stronger gate, and it is the
-- desired one: if the requester has since been REMOVED from the workspace, a
-- service-role call naming them now refuses instead of resolving their private
-- rows. For claim-extraction that means a re-index of an ex-member's capture
-- dedupes against workspace-visible claims only and may fork a duplicate, which
-- is the same call 238 made for packages ("an ex-member creator has no edit
-- rights"). Losing a dedupe is cheaper than resurfacing an ex-member's private
-- claims.
--
-- ============================================================
-- SCOPE / NON-CHANGES
-- ============================================================
-- Each function below is its LATEST body, copied verbatim, with exactly two
-- lines changed (the requester resolution and the membership gate) plus the
-- stale comment above the gate refreshed. Nothing else moves: 264's company
-- label branch and 267's campaign label branch and LEFT JOIN both survive,
-- 252's `NOT c.is_eval` fences survive, 181's event_at window survives.
-- SECURITY DEFINER, SET search_path = public, pg_temp and the REVOKE/GRANT
-- pairs are all preserved. (252 redefined hybrid_search,
-- hybrid_search_attachments and unified_search without re-stating their grants,
-- relying on CREATE OR REPLACE keeping them; this migration re-states them so
-- the file is self-sufficient.)
--
-- NOT changed here, deliberately:
--   * capture_visible_to / claim_visible_to — they take the requester as an
--     argument and are already NULL-fail-closed; the caller is what was wrong.
--   * rag_search / attachment_rag_search — no p_requesting_user_id parameter;
--     search.ts post-filters their rows on parent-capture visibility instead.
--   * public.claim_visible_to called directly from claims.ts with
--     p_user_id: requestingUserId — a boolean probe of ONE id the caller
--     already supplies; worth revisiting but not a read amplifier.
--
-- Numbered 275, not 274: DEV's migration log already carries a
-- `274_voice_embedding_model` that has no file in this repo. Duplicate numbers
-- exist here (258, 263, 270) and Supabase keys on its own version timestamp
-- rather than on this filename, so a second 274 would have applied cleanly —
-- it would just have made "the latest definition" ambiguous to read, which is
-- the exact confusion this migration exists to clean up.
--
-- Idempotent: CREATE OR REPLACE throughout, no DROP, no signature change, so
-- every existing caller keeps working and re-running is a no-op.


-- ---------------------------------------------------------------------------
-- The helper. Sibling to 237's _resolve_requester; differs ONLY in tolerating
-- a NULL result, which in this family means "no requester" rather than
-- "not authenticated".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._resolve_visibility_requester(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session uuid := auth.uid();
BEGIN
  -- The whole point of this migration: a caller on a real user session may not
  -- assert somebody else's identity as the visibility key.
  IF v_session IS NOT NULL AND p_user_id IS NOT NULL AND v_session <> p_user_id THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  -- May be NULL — a sessionless caller asserting no requester sees only
  -- visibility = 'workspace' rows. That is the documented fail-closed posture
  -- of the unattended run paths, not an error.
  RETURN COALESCE(p_user_id, v_session);
END
$$;
REVOKE EXECUTE ON FUNCTION public._resolve_visibility_requester(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public._resolve_visibility_requester(uuid) TO authenticated, service_role;

-- --------------------------------------------------------------------------
-- match_claims (8-arg, from 223 §8)
-- --------------------------------------------------------------------------
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
    v_requester UUID := public._resolve_visibility_requester(p_requesting_user_id);
BEGIN
    -- Membership gate (275): enforced whenever the requester is KNOWN — whether
    -- it came from the JWT or from an explicit p_requesting_user_id — not only
    -- when a JWT happens to be present. A sessionless caller that asserts no
    -- requester at all sees workspace-visible rows only, and is trusted to
    -- scope itself (service-role already has the whole database).
    IF v_requester IS NOT NULL AND NOT public._is_member_of(v_requester, v_workspace_id) THEN
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


-- --------------------------------------------------------------------------
-- match_claims (9-arg, from 223 §8)
-- --------------------------------------------------------------------------
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
    v_requester UUID := public._resolve_visibility_requester(p_requesting_user_id);
BEGIN
    -- Membership gate (275): enforced whenever the requester is KNOWN — whether
    -- it came from the JWT or from an explicit p_requesting_user_id — not only
    -- when a JWT happens to be present. A sessionless caller that asserts no
    -- requester at all sees workspace-visible rows only, and is trusted to
    -- scope itself (service-role already has the whole database).
    IF v_requester IS NOT NULL AND NOT public._is_member_of(v_requester, v_workspace_id) THEN
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


-- --------------------------------------------------------------------------
-- match_claims (11-arg, from 223 §8)
-- --------------------------------------------------------------------------
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
    v_requester UUID := public._resolve_visibility_requester(p_requesting_user_id);
BEGIN
    -- Membership gate (275): enforced whenever the requester is KNOWN — whether
    -- it came from the JWT or from an explicit p_requesting_user_id — not only
    -- when a JWT happens to be present. A sessionless caller that asserts no
    -- requester at all sees workspace-visible rows only, and is trusted to
    -- scope itself (service-role already has the whole database).
    IF v_requester IS NOT NULL AND NOT public._is_member_of(v_requester, v_workspace_id) THEN
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


-- --------------------------------------------------------------------------
-- hybrid_search (from 252)
-- --------------------------------------------------------------------------
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


-- --------------------------------------------------------------------------
-- hybrid_search_attachments (from 252)
-- --------------------------------------------------------------------------
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
                        AND NOT c.is_eval
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


-- --------------------------------------------------------------------------
-- unified_search (from 252)
-- --------------------------------------------------------------------------
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
BEGIN
  -- Membership gate (275): enforced whenever the requester is KNOWN — whether
  -- it came from the JWT or from an explicit p_requesting_user_id — not only
  -- when a JWT happens to be present. A sessionless caller that asserts no
  -- requester at all sees workspace-visible rows only, and is trusted to
  -- scope itself (service-role already has the whole database).
  IF v_requester IS NOT NULL AND NOT public._is_member_of(v_requester, p_workspace_id) THEN
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


-- --------------------------------------------------------------------------
-- claim_neighborhood (from 267)
-- --------------------------------------------------------------------------
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

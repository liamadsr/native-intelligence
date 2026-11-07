-- Migration 181: match_claims — 10-arg overload adding event-time range filters.
--
-- WHY: the knowledge-recall plan's "bridge fix" (item 6). match_claims does pure
-- semantic (vector) claim search but had NO way to constrain by when the fact
-- actually happened, so `deep_search`'s claims runner ignored its `since` param
-- and `search_claims` couldn't answer "what came up last week about X" at all.
-- Migration 180 added claim.event_at (the real-world event time); this overload
-- filters on it so the temporal-recall queries work through the existing
-- match_claims path (kept alive for MCP even after `find` becomes the front door).
--
-- Shape: the 8-arg overload from 126, plus two trailing TIMESTAMPTZ args
-- (p_event_after / p_event_before). A NEW overload — the 8-arg and 7-arg stay
-- untouched so claim-extraction's dedup and every other existing caller are
-- unaffected. NULL bounds = unbounded (the default), so passing neither behaves
-- exactly like the 8-arg function.
--
-- SECURITY: SECURITY DEFINER + the 125/126 in-function member gate (service-role
-- passes through) + REVOKE FROM PUBLIC, anon + explicit GRANT + pinned
-- search_path. Postgres default-grants EXECUTE to PUBLIC on new functions and
-- this repo has re-opened that hole three times (111→117→126) — do NOT omit the
-- REVOKE.

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
    p_event_before   TIMESTAMPTZ
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
    ORDER BY cc.embedding <=> v_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT, DOUBLE PRECISION, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, DOUBLE PRECISION, TEXT, TEXT, TEXT, DOUBLE PRECISION, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;

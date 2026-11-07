-- ============================================================
-- Migration 111: Lock down match_claims authorization
--
-- 109 granted EXECUTE to `anon`, copying the older rag_search /
-- attachment_rag_search pattern. match_claims is SECURITY DEFINER and only
-- filters by workspace_id (which is enumerable), so the anon grant let an
-- unauthenticated caller read any workspace's claims through the REST RPC
-- endpoint. Revoke it.
--
-- Why no in-function auth.uid() / is_workspace_member() gate: the two
-- legitimate callers (the in-app AI chat route and the MCP server) reach
-- this RPC through a SERVICE-ROLE Supabase client, under which auth.uid()
-- is NULL. A membership gate would therefore break agent/MCP search_claims
-- entirely. Those callers already constrain workspace_id in application
-- code (the MCP server scopes every tool to the authenticated member's
-- active workspace). Removing the anon grant closes the unauthenticated
-- hole without breaking the service-role path — same posture as the
-- existing rag_search / attachment_rag_search functions.
-- ============================================================

-- Note: revoking `anon` alone is insufficient — Postgres grants EXECUTE to
-- PUBLIC by default, and PUBLIC includes anon. Revoke PUBLIC, then re-grant
-- only the roles that should call this.
REVOKE EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, FLOAT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, FLOAT, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, FLOAT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_claims(TEXT, TEXT, INTEGER, FLOAT, TEXT, TEXT, TEXT) TO service_role;

-- ============================================================
-- claim_source dedupe: make the unique key treat NULLs as equal.
--
-- 109 declared UNIQUE (claim_id, source_type, source_id, source_uri). For
-- internal sources source_uri is NULL (and for manual sources source_id is
-- NULL). Postgres treats NULLs as DISTINCT by default, so the constraint
-- fails to dedupe exactly the common case — duplicate evidence rows pile up
-- and ON CONFLICT can't fire. NULLS NOT DISTINCT makes the constraint behave
-- as intended so the ingestion upsert dedupes correctly.
-- ============================================================

ALTER TABLE public.claim_source
  DROP CONSTRAINT IF EXISTS claim_source_claim_id_source_type_source_id_source_uri_key;

ALTER TABLE public.claim_source
  ADD CONSTRAINT claim_source_dedupe_key
  UNIQUE NULLS NOT DISTINCT (claim_id, source_type, source_id, source_uri);

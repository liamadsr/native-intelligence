-- 115_claim_provenance_backfill.sql
--
-- GEN-105 / GEN-106 / GEN-108: reconcile the two claim-provenance stores for
-- claims created before the unified `attachClaimProvenance` helper. The two
-- stores are:
--   claim_source  — evidence (excerpt-bearing), keyed (claim_id, source_type, source_id, source_uri)
--   entity_link   — graph edge, a claim --cites/about--> entity
--
-- Going forward both are written together. This one-time, idempotent backfill
-- cross-populates existing rows so verification logic has a single place to
-- look and `traverse` stops returning empty for already-extracted claims.
--
-- Idempotent: ON CONFLICT DO NOTHING against the existing unique constraints
-- (claim_source_dedupe_key, entity_link_..._key). Safe to re-run.

BEGIN;

-- 1. For every outbound cites/about edge from a claim to an internal entity
--    that has NO matching claim_source row, create the source row (no excerpt
--    — the edge carried none). source_type mirrors the edge target_type.
INSERT INTO public.claim_source (claim_id, source_type, source_id, source_uri, excerpt)
SELECT DISTINCT el.source_id, el.target_type, el.target_id, NULL, NULL
FROM public.entity_link el
JOIN public.claim c ON c.id = el.source_id
WHERE el.source_type = 'claim'
  AND el.relation IN ('cites', 'about')
  AND el.target_type IN ('capture', 'attachment', 'document', 'email', 'project', 'contact', 'action')
  AND NOT EXISTS (
    SELECT 1 FROM public.claim_source cs
    WHERE cs.claim_id = el.source_id
      AND cs.source_type = el.target_type
      AND cs.source_id = el.target_id
  )
ON CONFLICT ON CONSTRAINT claim_source_dedupe_key DO NOTHING;

-- 2. For every claim_source that points at an internal entity (has a source_id)
--    but has NO matching graph edge, create the `cites` edge so the graph
--    round-trips. workspace_id/created_by are pulled from the claim row.
INSERT INTO public.entity_link (workspace_id, source_type, source_id, target_type, target_id, relation, created_by)
SELECT DISTINCT c.workspace_id, 'claim', cs.claim_id,
       CASE WHEN cs.source_type = 'external_url' THEN 'document' ELSE cs.source_type END,
       cs.source_id, 'cites', c.created_by
FROM public.claim_source cs
JOIN public.claim c ON c.id = cs.claim_id
WHERE cs.source_id IS NOT NULL
  AND cs.source_type IN ('capture', 'attachment', 'document', 'email', 'project', 'contact', 'action', 'external_url')
  AND NOT EXISTS (
    SELECT 1 FROM public.entity_link el
    WHERE el.workspace_id = c.workspace_id
      AND el.source_type = 'claim'
      AND el.source_id = cs.claim_id
      AND el.target_type = CASE WHEN cs.source_type = 'external_url' THEN 'document' ELSE cs.source_type END
      AND el.target_id = cs.source_id
      AND el.relation IN ('cites', 'about')
  )
ON CONFLICT ON CONSTRAINT entity_link_workspace_id_source_type_source_id_target_type__key DO NOTHING;

COMMIT;

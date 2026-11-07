-- 190: one-time cleanup of claims evidence-orphaned by the bulk-delete bypass.
--
-- /api/account/bulk's 'delete' action raw-deleted captures without calling
-- delete_capture_with_knowledge (migration 178) — fixed in code on 2026-07-16
-- (f72ca904: bulk capture/document deletes now route through the RPCs). Before
-- the fix landed, a bulk delete of 2 captures left 10 sole-sourced claims
-- (mic-test junk from a deleted 2026-07-12 capture) evidence-orphaned: their
-- claim_source rows and entity_link edges point at a capture that no longer
-- exists, yet their embeddings keep surfacing in RAG with dead provenance.
--
-- Mirrors migration 179's semantics, derived not hardcoded:
--   1. Claims whose ENTIRE evidence set is capture sources pointing at
--      nonexistent captures are hard-deleted (claim_source / claim_chunks
--      cascade via the claim_id FK) along with their entity_link edges —
--      matching what delete_capture_with_knowledge would have done.
--   2. Surviving (shared-evidence) claims get their dead capture sources
--      pruned.
--   3. Stray entity_link edges pointing at nonexistent captures are removed.
-- Idempotent — a second run matches nothing.

CREATE TEMP TABLE _orphan_claims ON COMMIT DROP AS
SELECT c.id AS claim_id
FROM public.claim c
WHERE EXISTS (SELECT 1 FROM public.claim_source cs WHERE cs.claim_id = c.id)
  AND NOT EXISTS (
    SELECT 1
    FROM public.claim_source cs
    WHERE cs.claim_id = c.id
      AND NOT (
        cs.source_type = 'capture'
        AND NOT EXISTS (SELECT 1 FROM public.captures cap WHERE cap.id = cs.source_id)
      )
  );

DELETE FROM public.entity_link el
WHERE (el.source_type = 'claim' AND el.source_id IN (SELECT claim_id FROM _orphan_claims))
   OR (el.target_type = 'claim' AND el.target_id IN (SELECT claim_id FROM _orphan_claims));

DELETE FROM public.claim c
WHERE c.id IN (SELECT claim_id FROM _orphan_claims);

DELETE FROM public.claim_source cs
WHERE cs.source_type = 'capture'
  AND NOT EXISTS (SELECT 1 FROM public.captures cap WHERE cap.id = cs.source_id);

DELETE FROM public.entity_link el
WHERE (el.target_type = 'capture'
       AND NOT EXISTS (SELECT 1 FROM public.captures cap WHERE cap.id = el.target_id))
   OR (el.source_type = 'capture'
       AND NOT EXISTS (SELECT 1 FROM public.captures cap WHERE cap.id = el.source_id));

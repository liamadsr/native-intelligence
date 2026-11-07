-- 179: one-time cleanup of the orphaned knowledge provenance that migration
-- 178 prevents going forward.
--
-- Before 178, permanently deleting a capture (or document / attachment) left
-- its polymorphic provenance behind: claim_source rows and entity_link edges
-- point at bare UUIDs with no FK (migration 109), so nothing cascaded. On PROD
-- this stranded ~49 claims (48 confirmed + active) as 100%% evidence-orphaned —
-- every claim_source row of the claim points at a source row that no longer
-- exists — yet their claim_chunks embeddings survive and keep surfacing via
-- match_claims / RAG / briefs as if grounded.
--
-- This migration reproduces 178's policy for the EXISTING mess:
--   1. Delete claims whose ENTIRE claim_source set points at a NONEXISTENT
--      source (verified per source_type against its own table). claim_source +
--      claim_chunks cascade via claim_id; we delete their entity_link edges
--      first. A claim with at least one live source is NOT deleted here.
--   2. Prune dangling claim_source rows (dead source) that belong to SHARED
--      claims — the claim keeps its live evidence, we just drop the dead rows.
--   3. Delete dangling entity_link edges whose non-claim endpoint points at a
--      nonexistent capture/document/attachment/etc., and any edge touching a
--      claim id deleted in step 1.
--
-- Idempotent + safe to re-run on DEV and PROD: it only ever removes rows whose
-- referenced source genuinely does not exist, so a second run is a no-op.
--
-- NOT run automatically by anyone but the operator — this file is applied by
-- hand like every migration in this repo.

-- A claim_source row is "dead" when its referenced source no longer exists.
-- external_url / manual rows anchor to a URI (or nothing) and are NEVER dead —
-- they have no owning table to check against. Every id-bearing source_type is
-- verified against its table. An UNKNOWN source_type (shouldn't happen given
-- the CHECK constraint) is treated as LIVE (conservative — never delete on a
-- type we don't understand).
--
-- We wrap the whole thing in a transaction so a partial failure rolls back.
BEGIN;

-- ── Step 0: compute the set of dead claim_source rows once, into a temp table.
CREATE TEMP TABLE _dead_claim_sources ON COMMIT DROP AS
SELECT cs.id AS claim_source_id, cs.claim_id
FROM public.claim_source cs
WHERE
  -- only id-bearing internal sources can be "dead"
  cs.source_id IS NOT NULL
  AND cs.source_type IN ('capture', 'attachment', 'document')
  AND (
    (cs.source_type = 'capture'
      AND NOT EXISTS (SELECT 1 FROM public.captures t WHERE t.id = cs.source_id))
    OR (cs.source_type = 'attachment'
      AND NOT EXISTS (SELECT 1 FROM public.attachments t WHERE t.id = cs.source_id))
    OR (cs.source_type = 'document'
      AND NOT EXISTS (SELECT 1 FROM public.document t WHERE t.id = cs.source_id))
  );

-- ── Step 1: claims that are FULLY orphaned — every one of their claim_source
--    rows is dead. (A claim with zero claim_source rows at all is left alone;
--    it was never evidence-backed to begin with and isn't in scope here.)
CREATE TEMP TABLE _orphan_claims ON COMMIT DROP AS
SELECT c.id AS claim_id
FROM public.claim c
WHERE EXISTS (SELECT 1 FROM public.claim_source cs WHERE cs.claim_id = c.id)
  AND NOT EXISTS (
    SELECT 1
    FROM public.claim_source cs
    WHERE cs.claim_id = c.id
      AND cs.id NOT IN (SELECT claim_source_id FROM _dead_claim_sources)
  );

-- Delete entity_link edges touching a fully-orphaned claim (either endpoint).
DELETE FROM public.entity_link el
WHERE (el.source_type = 'claim' AND el.source_id IN (SELECT claim_id FROM _orphan_claims))
   OR (el.target_type = 'claim' AND el.target_id IN (SELECT claim_id FROM _orphan_claims));

-- Hard-delete the orphaned claims. claim_source + claim_chunks cascade.
DELETE FROM public.claim c
WHERE c.id IN (SELECT claim_id FROM _orphan_claims);

-- ── Step 2: prune the remaining dead claim_source rows. After step 1 these
--    all belong to SHARED claims (claims with at least one live source), so the
--    claim survives on its remaining evidence.
DELETE FROM public.claim_source cs
WHERE cs.id IN (SELECT claim_source_id FROM _dead_claim_sources)
  AND EXISTS (SELECT 1 FROM public.claim c WHERE c.id = cs.claim_id);

-- ── Step 3: delete dangling entity_link edges whose NON-claim endpoint points
--    at a nonexistent capture / document / attachment. (Claim-vs-deleted-claim
--    edges were already handled in step 1.) We check both directions.
DELETE FROM public.entity_link el
WHERE
  (el.source_type = 'capture'
     AND NOT EXISTS (SELECT 1 FROM public.captures t WHERE t.id = el.source_id))
  OR (el.target_type = 'capture'
     AND NOT EXISTS (SELECT 1 FROM public.captures t WHERE t.id = el.target_id))
  OR (el.source_type = 'attachment'
     AND NOT EXISTS (SELECT 1 FROM public.attachments t WHERE t.id = el.source_id))
  OR (el.target_type = 'attachment'
     AND NOT EXISTS (SELECT 1 FROM public.attachments t WHERE t.id = el.target_id))
  OR (el.source_type = 'document'
     AND NOT EXISTS (SELECT 1 FROM public.document t WHERE t.id = el.source_id))
  OR (el.target_type = 'document'
     AND NOT EXISTS (SELECT 1 FROM public.document t WHERE t.id = el.target_id));

COMMIT;

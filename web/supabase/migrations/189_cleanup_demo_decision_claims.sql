-- 189: one-time cleanup of demo-sourced decision claims.
--
-- emitDecisionClaim (the decision → decision_summary claim mirror) had no
-- demo-capture gate — unlike index-content and capture-ingest, the other two
-- extraction triggers — so every onboarding-tutorial completion mirrored the
-- demo capture's scripted decision ("Ship the onboarding tour to dev first,
-- then production after a soak") into the REAL workspace knowledge graph as a
-- confirmed claim. Each onboarding run creates a fresh demo capture, so the
-- mirror's per-capture text dedupe never caught the repeats: 17 demo-only
-- claims existed on PROD as of 2026-07-19 (15 copies of the scripted decision
-- spanning Jun 19-Jul 10, plus 2 scripted "Alex/Sarah" facts from other demo
-- extraction paths). The code gate shipped 2026-07-16 (34d0c4de); this cleans
-- up the rows that already leaked.
--
-- Deletes claims whose ENTIRE claim_source evidence set cites demo captures
-- (captures.metadata->>'demo' = 'true'), plus their entity_link edges.
-- claim_source and claim_chunks cascade via the claim_id FK. A claim with any
-- non-demo evidence survives untouched. Idempotent — a second run matches
-- nothing.

CREATE TEMP TABLE _demo_claims ON COMMIT DROP AS
SELECT c.id AS claim_id
FROM public.claim c
WHERE EXISTS (SELECT 1 FROM public.claim_source cs WHERE cs.claim_id = c.id)
  AND NOT EXISTS (
    SELECT 1
    FROM public.claim_source cs
    WHERE cs.claim_id = c.id
      AND NOT (
        cs.source_type = 'capture'
        AND EXISTS (
          SELECT 1 FROM public.captures cap
          WHERE cap.id = cs.source_id
            AND cap.metadata->>'demo' = 'true'
        )
      )
  );

DELETE FROM public.entity_link el
WHERE (el.source_type = 'claim' AND el.source_id IN (SELECT claim_id FROM _demo_claims))
   OR (el.target_type = 'claim' AND el.target_id IN (SELECT claim_id FROM _demo_claims));

DELETE FROM public.claim c
WHERE c.id IN (SELECT claim_id FROM _demo_claims);

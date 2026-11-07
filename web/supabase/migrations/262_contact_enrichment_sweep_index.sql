-- 262 — the enrichment sweep no longer requires an email
--
-- Migration 239 gave the contact sweep a partial index whose predicate
-- included `email IS NOT NULL`, because at the time an email was the only
-- identity anchor the enricher would search on. It no longer is: a LinkedIn
-- profile URL identifies a person at least as precisely (it is what the search
-- query quotes and what the citation gate anchors on), and a name plus a job
-- title, notes or a linked company is enough as well.
--
-- Keeping the old predicate would have quietly excluded every contact without
-- an email — 163 of them on production, nearly all published there by a
-- prospecting list, each with a job title and most with a LinkedIn URL — from
-- automatic enrichment forever, because the sweep's WHERE clause and this
-- index agreed on the wrong thing.
--
-- The index is otherwise unchanged: still partial on the un-attempted rows, so
-- it stays proportional to the backlog rather than to the whole CRM.

DROP INDEX IF EXISTS contact_enrichment_pending_idx;

CREATE INDEX IF NOT EXISTS contact_enrichment_pending_idx
  ON public.contact (workspace_id, created_at DESC)
  WHERE enrichment_status IS NULL
    AND member_id IS NULL
    AND merged_into_contact_id IS NULL;

-- The sweep's third pool: rows it skipped for `insufficient_identity_signal`,
-- re-checked oldest first once their identity signals may have changed.
CREATE INDEX IF NOT EXISTS contact_enrichment_skipped_idx
  ON public.contact (enriched_at)
  WHERE enrichment_status = 'skipped'
    AND member_id IS NULL
    AND merged_into_contact_id IS NULL;

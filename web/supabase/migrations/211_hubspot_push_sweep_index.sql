-- ============================================================
-- 211: Index for the HubSpot contact-push retroactive sweep
-- ============================================================
-- hubspot-push-sweep (src/lib/inngest/hubspot-push-sweep.ts) pages a
-- workspace's not-yet-pushed contacts with a keyset cursor:
--
--   SELECT id, created_at FROM contact
--    WHERE workspace_id = $1
--      AND source_provider IS NULL
--      AND merged_into_contact_id IS NULL
--      AND email IS NOT NULL
--      AND (<scope filter on source>)
--      AND (created_at, id) > (<cursor>)
--    ORDER BY created_at, id
--    LIMIT 100;
--
-- No existing index serves that shape: contact_workspace_idx (workspace_id) has
-- no ordering columns, so every page degenerates to a scan + sort of the
-- workspace's whole contact set — and the sweep runs that query up to 20 times
-- per invocation, on every opted-in workspace, on a 15-minute cron.
--
-- This partial index matches the sweep's invariant predicate exactly, so it
-- covers both the filter and the (created_at, id) keyset ordering, and each page
-- becomes a bounded index range scan. Partial keeps it small: it indexes only
-- unlinked, unmerged, emailed contacts — the sweep's candidate pool — not the
-- whole table, and rows drop out of it the moment a push claims them
-- (source_provider set). The scope filter on `source` and the permanent-failure
-- filter on `metadata->hubspot_push_error` are deliberately NOT in the predicate:
-- they vary per workspace / per fire, and applying them as a filter over an
-- already-narrow index range is cheap.
-- ============================================================

CREATE INDEX IF NOT EXISTS contact_hubspot_unlinked_idx
  ON public.contact (workspace_id, created_at, id)
  WHERE source_provider IS NULL
    AND merged_into_contact_id IS NULL
    AND email IS NOT NULL;

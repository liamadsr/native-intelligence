-- ============================================================
-- 239: CRM enrichment status columns
-- ============================================================
-- Web-search enrichment (src/lib/crm/enrichment.ts) fills empty CRM columns
-- from public sources via the Exa search tool on the AI Gateway. Two columns
-- per entity track the lifecycle so the cron sweep can find un-attempted rows
-- cheaply and never re-pick a row it already dispatched:
--
--   enrichment_status:
--     NULL       — never attempted. The ONLY state the sweep picks up.
--     'pending'  — dispatched to Inngest (or queued by a manual trigger).
--     'enriched' — a run completed and wrote its result blob.
--     'failed'   — a run errored. `metadata.enrichment.permanent = true`
--                  additionally marks it as never-retry (see the lib guard).
--     'skipped'  — a guard rejected the row (member self-contact, merge
--                  tombstone, too little identity signal to search on).
--   enriched_at: when the terminal write happened. Also the per-workspace
--     daily-cap counter's clock (cron counts rows with enriched_at >= today).
--
-- The full extraction result — every field the model found, including
-- low-confidence values and fields with no column to land in — lives in
-- `metadata.enrichment` (jsonb). These two columns are only the index.

-- ── contact ─────────────────────────────────────────────────
ALTER TABLE public.contact
  ADD COLUMN IF NOT EXISTS enrichment_status text
    CHECK (enrichment_status IN ('pending', 'enriched', 'failed', 'skipped')),
  ADD COLUMN IF NOT EXISTS enriched_at timestamptz;

COMMENT ON COLUMN public.contact.enrichment_status IS
  'Web-enrichment lifecycle: NULL = never attempted (the sweep''s candidate '
  'set), pending | enriched | failed | skipped. Full result in '
  'metadata.enrichment.';
COMMENT ON COLUMN public.contact.enriched_at IS
  'When the last enrichment run reached a terminal state. Drives the '
  'per-workspace daily cap in /api/cron/crm-enrichment.';

-- ── company ─────────────────────────────────────────────────
ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS enrichment_status text
    CHECK (enrichment_status IN ('pending', 'enriched', 'failed', 'skipped')),
  ADD COLUMN IF NOT EXISTS enriched_at timestamptz;

COMMENT ON COLUMN public.company.enrichment_status IS
  'Web-enrichment lifecycle: NULL = never attempted (the sweep''s candidate '
  'set), pending | enriched | failed | skipped. Full result in '
  'metadata.enrichment.';
COMMENT ON COLUMN public.company.enriched_at IS
  'When the last enrichment run reached a terminal state. Drives the '
  'per-workspace daily cap in /api/cron/crm-enrichment.';

-- ── Sweep indexes ───────────────────────────────────────────
-- The cron selects `WHERE enrichment_status IS NULL` ordered by created_at
-- desc, per workspace. PARTIAL on the NULL predicate: once a row is enriched
-- it leaves the index entirely, so the index stays proportional to the
-- un-attempted backlog rather than to the whole CRM. The contact index carries
-- the same extra predicates the sweep applies in SQL (member_id /
-- merged_into_contact_id / email) so the candidate scan is index-only.
CREATE INDEX IF NOT EXISTS contact_enrichment_pending_idx
  ON public.contact (workspace_id, created_at DESC)
  WHERE enrichment_status IS NULL
    AND member_id IS NULL
    AND merged_into_contact_id IS NULL
    AND email IS NOT NULL;

CREATE INDEX IF NOT EXISTS company_enrichment_pending_idx
  ON public.company (workspace_id, created_at DESC)
  WHERE enrichment_status IS NULL;

-- The daily-cap count is `enriched_at >= <start of today>` per workspace. Not
-- partial (every terminal row is a candidate for the count) but narrow.
CREATE INDEX IF NOT EXISTS contact_enriched_at_idx
  ON public.contact (workspace_id, enriched_at)
  WHERE enriched_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS company_enriched_at_idx
  ON public.company (workspace_id, enriched_at)
  WHERE enriched_at IS NOT NULL;

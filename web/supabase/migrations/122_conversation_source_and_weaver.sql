-- Migration 122: Conversations as a knowledge source + weaver bookkeeping.
--
-- 1. claim_source.source_type gains 'conversation' — chat conversations are
--    now extracted into claims by the background job (the richest signal in
--    the product previously evaporated when a chat ended). Same widen-the-
--    CHECK pattern as migration 117.
--
-- 2. claim.woven_at — stamp set by the nightly knowledge-weaver job after a
--    claim has been related to the rest of the graph (near-dupe merge +
--    claim↔claim edge pass). NULL means "not yet woven"; the weaver drains
--    the backlog newest-first, so the column doubles as the job's queue.

DO $$
DECLARE
  conname_var TEXT;
BEGIN
  SELECT con.conname INTO conname_var
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'claim_source'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%source_type %IN%'
  ORDER BY con.conname
  LIMIT 1;

  IF conname_var IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.claim_source DROP CONSTRAINT %I', conname_var);
  END IF;

  ALTER TABLE public.claim_source DROP CONSTRAINT IF EXISTS claim_source_source_type_check;

  ALTER TABLE public.claim_source
    ADD CONSTRAINT claim_source_source_type_check CHECK (source_type IN (
      'capture', 'attachment', 'document', 'email', 'external_url', 'manual',
      'project', 'contact', 'action', 'conversation'
    ));
END $$;

ALTER TABLE public.claim
  ADD COLUMN IF NOT EXISTS woven_at TIMESTAMPTZ;

-- The weaver's work queue: active claims not yet woven, newest first.
CREATE INDEX IF NOT EXISTS idx_claim_unwoven
  ON public.claim (workspace_id, created_at DESC)
  WHERE woven_at IS NULL AND status = 'active';

-- Migration 118: Live-mode toggle for meeting capture
--
-- Captures used to ALWAYS run the live agent on every silence window, which
-- re-processes growing context and burns tokens. This adds an opt-in "live
-- mode": when ON, today's incremental behavior is unchanged; when OFF, nothing
-- is processed during the meeting and a single batch extraction runs over the
-- full transcript at the end (and on-demand via a "Reprocess" button).
--
-- The actual extraction is unchanged — the same /api/ai/live-agent pipeline,
-- the same proposed_change table, the same confidence auto-accept logic. This
-- migration only adds the bookkeeping needed to (a) record per-capture intent
-- and (b) mark when a batch run has happened.
--
-- The per-workspace DEFAULT for new recordings lives in workspace.settings
-- jsonb (settings.live_mode_default, defaults false = OFF), alongside
-- auto_accept_policy — no column needed for it.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

-- Per-capture intent. Default true so EXISTING captures are unaffected (their
-- behavior was live). New recordings set this explicitly from the workspace
-- default (which is OFF). Column drives the end-of-meeting batch decision.
ALTER TABLE public.captures
  ADD COLUMN IF NOT EXISTS live_mode boolean NOT NULL DEFAULT true;

-- Marks when a batch (end-of-meeting or Reprocess) run last completed. Distinct
-- from ai_processed, which is set by multiple code paths and is NOT a reliable
-- "batch ran" marker. NULL = no batch run yet (e.g. a live-mode-OFF capture
-- whose app crashed before stop — the user can hit Reprocess).
ALTER TABLE public.captures
  ADD COLUMN IF NOT EXISTS batch_processed_at timestamptz;

-- Verification (uncomment to run by hand):
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='captures'
--   AND column_name IN ('live_mode','batch_processed_at');

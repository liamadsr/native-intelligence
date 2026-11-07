-- Migration 134: Disable live agents (live mode) — graceful prod switch-off
--
-- Live agents are being temporarily HIDDEN from the UI (see the
-- LIVE_AGENT_UI_ENABLED kill switch in src/hooks/recording-context.tsx). The
-- entire pipeline (/api/ai/live-agent, the transcript gate, the proposed_change
-- flow) stays in the codebase and on the normal capture path so it does not go
-- stale — only the toggle and the live processing are turned off.
--
-- The client kill switch is the PRIMARY mechanism: while it's false, every
-- recording (new or resumed) runs with live mode pinned OFF regardless of what
-- the DB says, and never PATCHes live_mode:true. This migration is the
-- belt-and-suspenders + cleanup so the database itself reflects the new reality:
--
--   1. Flip the captures.live_mode column DEFAULT from true → false. Migration
--      118 defaulted it true so existing captures kept their (then live)
--      behavior. New captures should now default to batch-at-end.
--
--   2. Reset live_mode to false on any capture that could still be acted on as
--      "live": in-progress recordings (ended_at IS NULL) and any capture that
--      hasn't had a batch run yet (batch_processed_at IS NULL). This guarantees
--      a recording in flight when the deploy lands — or one resumed afterward —
--      doesn't re-enter the live path. Finished, already-batched captures are
--      left untouched: their live_mode value is inert (it only gates active
--      recording + the end-of-meeting batch decision).
--
--   3. Belt-and-suspenders: clear any workspace-level live_mode_default so no
--      workspace can seed new recordings into live mode. (Currently none are
--      set in prod, but this makes the off-state authoritative.)
--
-- To re-enable later: flip LIVE_AGENT_UI_ENABLED back to true. This migration
-- does not need to be reverted — the column default can stay false and users
-- opt in per-recording via the (restored) toggle.
--
-- Idempotent: re-running is safe (SET DEFAULT and the UPDATEs are convergent).

-- 1. New captures default to batch-at-end.
ALTER TABLE public.captures
  ALTER COLUMN live_mode SET DEFAULT false;

-- 2. Reset any capture that could still be treated as live.
UPDATE public.captures
  SET live_mode = false
  WHERE live_mode = true
    AND (ended_at IS NULL OR batch_processed_at IS NULL);

-- 3. Strip any workspace default so nothing seeds live mode on for new captures.
UPDATE public.workspace
  SET settings = settings - 'live_mode_default'
  WHERE settings ? 'live_mode_default';

-- Verification (uncomment to run by hand):
-- SELECT column_default FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='captures' AND column_name='live_mode';
-- SELECT count(*) FROM public.captures WHERE live_mode = true AND (ended_at IS NULL OR batch_processed_at IS NULL);
-- SELECT count(*) FROM public.workspace WHERE settings ? 'live_mode_default';

-- ============================================================
-- 255: eval_suite summary columns + realtime, for the views system
-- ============================================================
-- The Evals index is now a views-system list (entityType="eval_suite"), and a
-- view filters, groups and sorts on REAL columns (PostgREST predicates). The
-- three things the index shows next to a suite — how many cases it has, what
-- its last run concluded, and when — used to be computed at read time from
-- eval_case / eval_run (src/lib/evals/queries.ts listSuites). A derived value
-- can be displayed but never grouped on, and "group suites by outcome" is the
-- whole point of putting Evals on the views system. So the summary is
-- DENORMALIZED onto eval_suite and kept current by triggers on the two child
-- tables. Backfilled below for every existing suite.
--
-- Semantics:
--   case_count    — rows in eval_case for the suite.
--   last_run_at / last_run_mode — the most recent eval_run by started_at,
--                   ANY status (a queued run counts as "last run at").
--   last_outcome  — the most recent SETTLED run's verdict: its `outcome` when
--                   completed, 'errored' when the run itself failed or was
--                   cancelled (a harness failure is not a prompt regression —
--                   the same distinction OutcomeChip draws), NULL while no run
--                   has settled. A run in flight does not clear the previous
--                   verdict.
--
-- eval_suite joins the realtime publication (with REPLICA IDENTITY FULL, per
-- 187) so the list refreshes when a run settles; eval_run/eval_case stay OUT of
-- the publication — every change that matters to the list lands on eval_suite
-- through the triggers.

ALTER TABLE public.eval_suite
  ADD COLUMN IF NOT EXISTS case_count    integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_run_at   timestamptz,
  ADD COLUMN IF NOT EXISTS last_run_mode text
    CHECK (last_run_mode IS NULL OR last_run_mode IN ('batch', 'live')),
  ADD COLUMN IF NOT EXISTS last_outcome  text
    CHECK (last_outcome IS NULL OR last_outcome IN ('passed', 'scored', 'failed', 'errored'));

CREATE INDEX IF NOT EXISTS idx_eval_suite_last_outcome
  ON public.eval_suite (workspace_id, last_outcome);

-- SECURITY DEFINER: the triggers fire under whichever role wrote the child row
-- (a member's session, the Inngest runner's service role) and must be able to
-- update the parent regardless of that role's eval_suite UPDATE policy.
CREATE OR REPLACE FUNCTION public.eval_suite_refresh_summary(p_suite_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_case_count    integer;
  v_last_run_at   timestamptz;
  v_last_run_mode text;
  v_last_outcome  text;
BEGIN
  IF p_suite_id IS NULL THEN RETURN; END IF;

  SELECT count(*) INTO v_case_count
  FROM public.eval_case
  WHERE suite_id = p_suite_id;

  SELECT r.started_at, r.mode INTO v_last_run_at, v_last_run_mode
  FROM public.eval_run r
  WHERE r.suite_id = p_suite_id
  ORDER BY r.started_at DESC, r.id DESC
  LIMIT 1;

  SELECT CASE
           WHEN r.status IN ('failed', 'cancelled') THEN 'errored'
           ELSE r.outcome
         END
  INTO v_last_outcome
  FROM public.eval_run r
  WHERE r.suite_id = p_suite_id
    AND r.status IN ('completed', 'failed', 'cancelled')
  ORDER BY r.started_at DESC, r.id DESC
  LIMIT 1;

  -- 0 rows while the suite itself is mid-cascade-delete is fine: nothing to
  -- keep current for a row that is going away.
  UPDATE public.eval_suite
  SET case_count    = COALESCE(v_case_count, 0),
      last_run_at   = v_last_run_at,
      last_run_mode = v_last_run_mode,
      last_outcome  = v_last_outcome
  WHERE id = p_suite_id;
END;
$$;

REVOKE ALL ON FUNCTION public.eval_suite_refresh_summary(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.eval_case_refresh_suite_summary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.eval_suite_refresh_summary(OLD.suite_id);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.suite_id IS DISTINCT FROM OLD.suite_id THEN
    PERFORM public.eval_suite_refresh_summary(OLD.suite_id);
  END IF;
  PERFORM public.eval_suite_refresh_summary(NEW.suite_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS eval_case_suite_summary ON public.eval_case;
CREATE TRIGGER eval_case_suite_summary
  AFTER INSERT OR DELETE OR UPDATE OF suite_id ON public.eval_case
  FOR EACH ROW EXECUTE FUNCTION public.eval_case_refresh_suite_summary();

CREATE OR REPLACE FUNCTION public.eval_run_refresh_suite_summary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.eval_suite_refresh_summary(OLD.suite_id);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.suite_id IS DISTINCT FROM OLD.suite_id THEN
    PERFORM public.eval_suite_refresh_summary(OLD.suite_id);
  END IF;
  PERFORM public.eval_suite_refresh_summary(NEW.suite_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS eval_run_suite_summary ON public.eval_run;
CREATE TRIGGER eval_run_suite_summary
  AFTER INSERT OR DELETE OR UPDATE OF status, outcome, mode, started_at, suite_id ON public.eval_run
  FOR EACH ROW EXECUTE FUNCTION public.eval_run_refresh_suite_summary();

-- Backfill every existing suite once.
SELECT public.eval_suite_refresh_summary(s.id) FROM public.eval_suite s;

-- Realtime (187's idiom): idempotent ADD TABLE + REPLICA IDENTITY FULL so
-- UPDATE events carry the whole row.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.eval_suite;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
ALTER TABLE public.eval_suite REPLICA IDENTITY FULL;

-- ============================================================
-- 257: 'eval_suite' as a saved-view scope, eval_case summary, realtime
-- ============================================================
-- 1. The suite detail page embeds UnifiedViewLayout for eval_case and eval_run
--    with viewScope { type: 'eval_suite' }, so saved views created inside one
--    suite persist under (scope_type='eval_suite', scope_id=<suite>) and stay
--    out of the next suite's picker. Mirrors 250 (prospect_list). The
--    constraint list is CUMULATIVE: keep every value 250 allowed.
ALTER TABLE public.view
  DROP CONSTRAINT view_scope_type_check;

ALTER TABLE public.view
  ADD CONSTRAINT view_scope_type_check
  CHECK (scope_type IS NULL OR scope_type IN ('project', 'initiative', 'contact', 'company', 'prospect_list', 'eval_suite'));

-- 2. A case's last verdict, denormalized the way 255 did for suites, so the
--    Cases view can filter and group on it (PostgREST predicates need a real
--    column). Semantics: the most recent SETTLED trial of the case, by
--    started_at — its outcome when completed, 'errored' when the trial itself
--    errored or was cancelled. NULL while no trial has settled; an in-flight
--    trial does not clear the previous verdict.
ALTER TABLE public.eval_case
  ADD COLUMN IF NOT EXISTS last_outcome text
    CHECK (last_outcome IS NULL OR last_outcome IN ('passed', 'scored', 'failed', 'errored')),
  ADD COLUMN IF NOT EXISTS last_run_at timestamptz;

CREATE OR REPLACE FUNCTION public.eval_case_refresh_summary(p_case_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last_outcome text;
  v_last_run_at  timestamptz;
BEGIN
  IF p_case_id IS NULL THEN RETURN; END IF;

  SELECT t.started_at INTO v_last_run_at
  FROM public.eval_trial t
  WHERE t.case_id = p_case_id
  ORDER BY t.started_at DESC, t.id DESC
  LIMIT 1;

  SELECT CASE
           WHEN t.status IN ('errored', 'cancelled') THEN 'errored'
           ELSE t.outcome
         END
  INTO v_last_outcome
  FROM public.eval_trial t
  WHERE t.case_id = p_case_id
    AND t.status IN ('completed', 'errored', 'cancelled')
  ORDER BY t.started_at DESC, t.id DESC
  LIMIT 1;

  UPDATE public.eval_case
  SET last_outcome = v_last_outcome,
      last_run_at  = v_last_run_at
  WHERE id = p_case_id;
END;
$$;

REVOKE ALL ON FUNCTION public.eval_case_refresh_summary(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.eval_trial_refresh_case_summary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.eval_case_refresh_summary(OLD.case_id);
    RETURN OLD;
  END IF;
  PERFORM public.eval_case_refresh_summary(NEW.case_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS eval_trial_case_summary ON public.eval_trial;
CREATE TRIGGER eval_trial_case_summary
  AFTER INSERT OR DELETE OR UPDATE OF status, outcome, started_at ON public.eval_trial
  FOR EACH ROW EXECUTE FUNCTION public.eval_trial_refresh_case_summary();

SELECT public.eval_case_refresh_summary(c.id) FROM public.eval_case c;

-- 3. Realtime (187's idiom) for both child tables, so the scoped lists refresh
--    as a run progresses and as cases are authored.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.eval_case;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.eval_run;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
ALTER TABLE public.eval_case REPLICA IDENTITY FULL;
ALTER TABLE public.eval_run  REPLICA IDENTITY FULL;

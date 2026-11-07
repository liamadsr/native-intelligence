-- ============================================================
-- 258: column-scoped eval grants, and a cascade guard on the summary triggers
-- ============================================================
-- Two corrections to 252/255/257, neither of which changes any application
-- code: every write these revoke is already made on the service client.
--
-- 1. THE GRANTS ARE THE BOUNDARY, NOT THE POLICIES. 252 wrote
--    `GRANT SELECT, UPDATE ON public.eval_check TO authenticated` with no
--    column list, and its own header one line above says UPDATE "exists solely
--    so a member can record a thumbs-up/down (human_override / human_note).
--    Everything else on the row is grader-written service-role." The policy
--    cannot enforce that: `eval_check_member_update`'s USING/WITH CHECK assert
--    only `is_workspace_member(workspace_id)` and that workspace_id is
--    unchanged, and Postgres column privileges are opt-in, so the grant covers
--    every column. Any member holding an `authenticated` JWT could PATCH
--    /rest/v1/eval_check?id=eq.<id> with {"outcome":"pass","score":1} straight
--    from the browser and turn a failing regression suite green, with no audit
--    trail. The fix is the grant, not the policy: UPDATE is re-granted on the
--    two columns the contract actually names.
--
--    eval_run goes further and loses client INSERT/UPDATE outright. Its own
--    252 header claims members "may create a run and cancel one", but neither
--    write has ever gone through a member client: `startEvalRun` inserts on
--    `getServiceClient()` (src/app/api/account/evals/runs/route.ts), so does
--    `cancelEvalRun` (runs/[id]/cancel/route.ts) and so do both chat/MCP
--    start_eval_run tools; the Inngest lane is service-role throughout. What
--    the grant bought instead was a member's ability to rewrite `status`,
--    `outcome`, `scores` and `cost_usd` on a finished run.
--
-- 2. THE SUMMARY TRIGGERS RE-COMPUTE A PARENT THAT IS ALREADY GONE. 255 and
--    257 attach FOR EACH ROW AFTER DELETE triggers to eval_case, eval_run and
--    eval_trial, all of which cascade from eval_suite / eval_run / eval_case.
--    So one `DELETE FROM eval_suite` runs a count(*), two ordered scans and a
--    zero-row UPDATE per cascaded child: a suite with 20 cases and 200 runs
--    pays 220 refresh cycles inside a single statement, and a bulk delete of
--    ten such suites pays 2200. 255 acknowledged the zero-row UPDATE as
--    harmless; it is, but the three reads in front of it are not free. Each
--    function now returns early when its parent row no longer exists.
--
-- Idempotent, and safe to run against a database where 252/255/257 are already
-- applied: every statement is REVOKE/GRANT or CREATE OR REPLACE.

-- ------------------------------------------------------------
-- 1. Grants
-- ------------------------------------------------------------

-- eval_check: read for members, and the thumbs-up/down columns ONLY.
-- The table-wide UPDATE has to be revoked before the column grant, or the
-- broader privilege simply remains in place alongside it.
REVOKE UPDATE ON public.eval_check FROM authenticated;
GRANT UPDATE (human_override, human_note) ON public.eval_check TO authenticated;

-- eval_run: read only. Every insert and update is service-role (see the header).
REVOKE INSERT, UPDATE ON public.eval_run FROM authenticated;

DROP POLICY IF EXISTS eval_run_member_insert ON public.eval_run;
DROP POLICY IF EXISTS eval_run_member_update ON public.eval_run;

COMMENT ON TABLE public.eval_run IS
  'One execution of a suite. Client-read-only: every write is service-role '
  '(startEvalRun, cancelEvalRun, the Inngest lane). See migration 258.';

-- ------------------------------------------------------------
-- 2. Cascade guard on the summary triggers
-- ------------------------------------------------------------
-- Only the DELETE branches change. The INSERT/UPDATE paths are untouched:
-- their parent always exists, and an early return there would be a behaviour
-- change rather than a saving.

CREATE OR REPLACE FUNCTION public.eval_case_refresh_suite_summary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The suite is mid-cascade: refreshing it would read three indexes to
    -- UPDATE zero rows, once per cascaded case.
    IF NOT EXISTS (SELECT 1 FROM public.eval_suite WHERE id = OLD.suite_id) THEN
      RETURN OLD;
    END IF;
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

CREATE OR REPLACE FUNCTION public.eval_run_refresh_suite_summary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.eval_suite WHERE id = OLD.suite_id) THEN
      RETURN OLD;
    END IF;
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

CREATE OR REPLACE FUNCTION public.eval_trial_refresh_case_summary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Same shape as above: eval_trial cascades from eval_run and eval_case, so
    -- a suite delete drags every trial through here too.
    IF NOT EXISTS (SELECT 1 FROM public.eval_case WHERE id = OLD.case_id) THEN
      RETURN OLD;
    END IF;
    PERFORM public.eval_case_refresh_summary(OLD.case_id);
    RETURN OLD;
  END IF;
  PERFORM public.eval_case_refresh_summary(NEW.case_id);
  RETURN NEW;
END;
$$;

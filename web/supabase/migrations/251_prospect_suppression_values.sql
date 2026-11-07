-- ============================================================
-- 251: Two honest suppression reasons — 'over_cap' and 'noise_host'
-- ============================================================
-- `prospect_run_candidate.suppressed_by` records WHY a candidate the run saw
-- never became an entry. 248 shipped eight values, and two real situations had
-- no honest one to use:
--
--   1. A PERSON TURNED AWAY BY `people_per_company`. The people stage caps
--      rows per company but records every person it saw (§6: nothing is
--      silently dropped). With no value for it, `people-run.ts` wrote
--      `this_list` — true only in the loosest sense ("this list's run
--      accounted for them") and indistinguishable in the audit trail from a
--      genuine duplicate. The user's obvious next question, "show me the other
--      four", could not be answered from the ledger.
--
--   2. A PLATFORM / AGGREGATOR HOST — linkedin.com, crunchbase.com, a
--      recruiter site. `exclusions.ts:isNoiseHost` refuses these, and with no
--      value for them they were reported as `personal_domain`, which says
--      "we skipped a webmail provider". A run that reports "6 personal
--      domains" when it actually skipped six LinkedIn pages is lying about
--      what the search returned.
--
-- Both were called out in the code as deliberate approximations awaiting this
-- migration (the comments in `admitCandidates` and `PeopleRun`), rather than
-- smuggled in as a value the CHECK would 23514 on at insert.
--
-- CUMULATIVE, like 250: every value 248 allowed stays allowed. Existing rows
-- are NOT rewritten — an old `personal_domain` row genuinely might have been a
-- webmail host, and re-labelling history on a guess is worse than a mixed
-- column. The split takes effect for runs from here on.
--
-- The constraint is unnamed in 248 (an inline column CHECK), so Postgres
-- generated `prospect_run_candidate_suppressed_by_check`. Dropped by that name
-- with IF EXISTS and re-added under an explicit name so a future widening does
-- not have to guess again.

ALTER TABLE public.prospect_run_candidate
  DROP CONSTRAINT IF EXISTS prospect_run_candidate_suppressed_by_check;

ALTER TABLE public.prospect_run_candidate
  DROP CONSTRAINT IF EXISTS prospect_run_candidate_suppressed_by_chk;

ALTER TABLE public.prospect_run_candidate
  ADD CONSTRAINT prospect_run_candidate_suppressed_by_chk
  CHECK (suppressed_by IN
    ('this_list','crm','other_list','dismissed_global','contacted',
     'opted_out','personal_domain','self','over_cap','noise_host'));

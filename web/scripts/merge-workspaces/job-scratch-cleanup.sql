-- DEV only: removes what job-scratch-fixtures.sql and cron-timeout-probe.sql left (the scratch workspaces, their
-- merge records and jobs, the probe objects, finished cron run details). Ends with the counts, all zero.
-- DEV only: refuses anywhere else (the deal table exists only on DEV).
DO $$ BEGIN IF to_regclass('public.deal') IS NULL THEN RAISE EXCEPTION 'this script writes; run it on DEV only'; END IF; END $$;
DELETE FROM cron.job_run_details WHERE command LIKE '%_wsmerge_cron_probe_%' OR command LIKE '%_wsmerge_claim_next_job%';
DROP FUNCTION IF EXISTS public._wsmerge_cron_probe_long();
DROP FUNCTION IF EXISTS public._wsmerge_cron_probe_default();
DROP TABLE IF EXISTS public._wsmerge_cron_probe;
DELETE FROM public.workspace_merge WHERE source_name LIKE 'Scratch % 417';
DELETE FROM public.workspace_merge_job
WHERE destination_workspace_id IN (SELECT id FROM public.workspace WHERE name LIKE 'Scratch % 417');
DELETE FROM public.workspace WHERE name LIKE 'Scratch % 417';
SELECT (SELECT count(*) FROM public.workspace WHERE name LIKE 'Scratch % 417') AS scratch_workspaces,
       (SELECT count(*) FROM public.contact WHERE email = 'scratch-417@example.com') AS scratch_contacts,
       (SELECT count(*) FROM cron.job) AS cron_jobs,
       to_regclass('public._wsmerge_cron_probe') IS NULL AS probe_gone;

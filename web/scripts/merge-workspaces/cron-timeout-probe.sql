-- DEV only, temporary (migration 417): does a pg_cron job run past 120 s with the runner's command, and what is
-- a cron session's default statement_timeout? Schedules two one-shot probes; read public._wsmerge_cron_probe after
-- ~2.5 min, then run job-scratch-cleanup.sql. Measured on DEV 2026-10-22: default '2min'; with the SET, 0 and 130 s.
-- DEV only: refuses anywhere else (the deal table exists only on DEV).
DO $$ BEGIN IF to_regclass('public.deal') IS NULL THEN RAISE EXCEPTION 'this script writes; run it on DEV only'; END IF; END $$;
CREATE TABLE IF NOT EXISTS public._wsmerge_cron_probe (k text, v text, pid int DEFAULT pg_backend_pid(), at timestamptz DEFAULT clock_timestamp());
CREATE OR REPLACE FUNCTION public._wsmerge_cron_probe_long() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM cron.unschedule('wsmerge-cron-probe-long');
  INSERT INTO public._wsmerge_cron_probe (k, v) VALUES ('long.start.statement_timeout', current_setting('statement_timeout')), ('long.user', current_user);
  PERFORM pg_sleep(130);
  INSERT INTO public._wsmerge_cron_probe (k, v) VALUES ('long.end', 'slept 130 s');
END $$;
CREATE OR REPLACE FUNCTION public._wsmerge_cron_probe_default() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM cron.unschedule('wsmerge-cron-probe-default');
  INSERT INTO public._wsmerge_cron_probe (k, v) VALUES ('default.statement_timeout', current_setting('statement_timeout'));
END $$;
SELECT cron.schedule('wsmerge-cron-probe-long', '2 seconds', 'SET statement_timeout = 0; SELECT public._wsmerge_cron_probe_long()');
SELECT cron.schedule('wsmerge-cron-probe-default', '2 seconds', 'SELECT public._wsmerge_cron_probe_default()');

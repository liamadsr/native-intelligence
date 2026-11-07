DROP FUNCTION IF EXISTS public._wsmerge_probe_sleep(int);
NOTIFY pgrst, 'reload schema';
SELECT count(*) AS probe_left FROM pg_proc WHERE proname = '_wsmerge_probe_sleep';

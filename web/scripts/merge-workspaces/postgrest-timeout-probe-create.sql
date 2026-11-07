-- temporary: a sleep the service role can call through PostgREST, to measure its statement_timeout
CREATE OR REPLACE FUNCTION public._wsmerge_probe_sleep(p_seconds int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_sleep(p_seconds);
  RETURN p_seconds;
END $$;
REVOKE ALL ON FUNCTION public._wsmerge_probe_sleep(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._wsmerge_probe_sleep(int) TO service_role;
NOTIFY pgrst, 'reload schema';
SELECT (SELECT rolconfig FROM pg_roles WHERE rolname = 'service_role') AS service_role_config,
       (SELECT rolconfig FROM pg_roles WHERE rolname = 'authenticator') AS authenticator_config,
       (SELECT public FROM storage.buckets WHERE id = 'workspace-merges') AS bucket_public,
       (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'notification_type_check') AS notice_check;

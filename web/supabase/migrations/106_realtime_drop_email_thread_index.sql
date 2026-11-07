-- Remove email_thread_index from the realtime publication.
--
-- During development we considered adding email_thread_index alongside the
-- other list-entity tables in migration 105, but pulled it back before
-- merge because the table churns heavily during email sync (every fetched
-- thread = an UPDATE) and would flood every connected client. This
-- migration exists so any environment that DID add it earlier (e.g. an
-- in-flight branch / staging DB) gets it removed. On a clean install
-- where the table was never published, this is a no-op.
--
-- Wrapped in a DO block to catch the "table not a member of publication"
-- error path gracefully.

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime DROP TABLE public.email_thread_index;
EXCEPTION
  -- Table not in the publication — nothing to do.
  WHEN undefined_object THEN NULL;
  -- Older PG versions raise a different sqlstate for the same condition.
  WHEN invalid_parameter_value THEN NULL;
END $$;

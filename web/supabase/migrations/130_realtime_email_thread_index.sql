-- Migration 130: Re-enable Supabase Realtime for email_thread_index
--
-- Migrations 105/106 deliberately kept email_thread_index OUT of the realtime
-- publication out of a fear it would "flood every client" during sync. In
-- practice that fear was overstated:
--   * RLS on email_thread_index is user-scoped (auth.uid() = user_id), so
--     postgres_changes events are delivered only to the owning user's client,
--     never broadcast to "every client".
--   * The real-time path (webhook -> incremental sync) only updates the handful
--     of threads that actually changed via updateThreadIndexFromMessages(),
--     not the whole mailbox.
--
-- The web inbox (email-layout.tsx) has always subscribed to this table, so
-- without it in the publication the subscription was silently dead and new
-- mail never appeared until a manual refresh / "Sync". This migration makes
-- that subscription actually work.
--
-- REPLICA IDENTITY FULL is required so UPDATE and DELETE events carry the row
-- columns the client matches on (provider_thread_id) rather than just the PK.

ALTER TABLE public.email_thread_index REPLICA IDENTITY FULL;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.email_thread_index;
EXCEPTION
  -- Already a member of the publication — nothing to do.
  WHEN duplicate_object THEN NULL;
END $$;

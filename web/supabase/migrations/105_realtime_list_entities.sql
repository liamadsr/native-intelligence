-- Add the remaining list-rendered tables to Supabase Realtime so the web
-- client can subscribe to teammate-driven changes and update lists in place
-- without polling. RLS still applies — users only receive events for rows
-- they're authorized to see.
--
-- Tables already in the publication (do not re-add):
--   - public.actions    (migration 022)
--   - public.captures   (migration 052)
--   - public.document   (migration 052)
--   - public.notification, public.comment, public.in_app_messages, etc.

-- Wrap each ADD in a DO block so the migration is idempotent — re-applying
-- against a database where the table is already published is a no-op rather
-- than an error. The duplicate_object exception path is what supabase_realtime
-- raises when a table is already a member.

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.projects;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.initiative;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.contact;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.company;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- email_thread_index is intentionally NOT in the publication: it churns
-- heavily during email sync (every fetched thread = an UPDATE). Publishing
-- it would flood every client. Inbox live-sync can be revisited if needed,
-- likely with a debounced server-side coalescing layer rather than raw
-- per-row events.

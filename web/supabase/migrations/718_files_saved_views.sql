-- Migration 718: saved views for the Files page (docs/plans/views-everywhere.md).
--
-- Files lists every file the person may see through the shared views system,
-- as the view-only kind `file` (rows read by the page from its own sources,
-- components/chat-cards/pages/files-card.tsx). A saved view stores its kind in
-- the `view_entity_type` enum (039, widened by 045 … 529 and 717), so the kind
-- needs its value here before a person can save a view of it.
--
-- Without this migration the page still works (its list, filters, search and
-- display settings need no saved-view row); listing and saving its saved views
-- fails on the enum. Apply it before rolling out the code that uses it.
--
-- It is only one `ALTER TYPE view_entity_type ADD VALUE IF NOT EXISTS`
-- statement and the schema reload: nothing in this file uses the new value
-- (no check, default or seed), and nothing needs to. It has no begin/commit of
-- its own.
--
-- How to apply: on the server, in the database container, with
-- `psql --single-transaction -v ON_ERROR_STOP=1 -f 718_files_saved_views.sql`,
-- as deploy/README.md says under "Day to day", "Apply a database migration",
-- before the roll-out and on the owner's word. One transaction is fine on
-- Postgres 12 and later, because no statement in it uses the value it adds.
-- Re-running it is harmless (IF NOT EXISTS).

alter type public.view_entity_type add value if not exists 'file';

notify pgrst, 'reload schema';

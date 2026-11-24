-- Migration 717: saved views for the Drive pages (docs/plans/views-everywhere.md).
--
-- Canvases, Spreadsheets and Tables are now lists of the shared views system,
-- each a view kind of its own (`canvas`, `spreadsheet`, `data_table`), as Docs
-- is (`document`). Folders lists a folder's subfolders and filed records
-- (`drive_item`, rows read by the page from the folder routes). A saved view
-- stores its kind in the `view_entity_type` enum (039, widened by 045 … 529),
-- so each kind needs its value here before a person can save a view of it.
--
-- Without this migration the pages still work (their lists, filters, search
-- and display settings need no saved-view row); listing and saving their saved
-- views fails on the enum. Apply it before rolling out the code that uses it.
--
-- The values are added and never used in this file. It has no begin/commit:
-- `ALTER TYPE … ADD VALUE` may not run inside a transaction block on an older
-- Postgres, and the new values are not used here in any case.
--
-- How to apply: on the server, in the database container, with psql, as
-- deploy/README.md says under "Day to day", "Apply a database migration",
-- before the roll-out and on the owner's word. Re-running it is harmless (IF
-- NOT EXISTS).

alter type public.view_entity_type add value if not exists 'canvas';
alter type public.view_entity_type add value if not exists 'spreadsheet';
alter type public.view_entity_type add value if not exists 'data_table';
alter type public.view_entity_type add value if not exists 'drive_item';

notify pgrst, 'reload schema';

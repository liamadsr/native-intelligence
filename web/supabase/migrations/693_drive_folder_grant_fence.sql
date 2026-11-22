-- ============================================================
-- 693: a grant never moves a record into, between or out of folders.
-- ============================================================
-- 690 (Drive folders) files a record (a document, a table, a spreadsheet or a
-- canvas) in at most one folder, and lets whoever can open the record file it,
-- move it or take it out (drive_folder_item_readable, under the caller's own
-- row security). A per-person grant (entity_access, 492; 'edit', 512) opens a
-- private record to read, so a person who sees someone else's private record
-- ONLY through a grant, even a view grant, could file it in their own folder,
-- move it, or unfile it, and the owner's record would sit where the grantee
-- put it. 512's rule is that a grant changes what a record says, never where
-- it lives, who owns it or who sees it (its column guard keeps a document's
-- folder and project to its own rule). This holds folders to the same rule.
--
-- Three RESTRICTIVE policies on drive_folder_item, beside 690's permissive
-- ones (a write must pass 690's AND these): insert, update and delete refuse a
-- caller who sees the record only through a grant, 494's entity_grant_only.
-- An update is checked on the row as it was (the record never changes on an
-- update: 690's trigger refuses that). Reading filings is not touched: a
-- grantee still sees where the owner filed it.
--
-- entity_grant_only takes the same words item_type holds ('document',
-- 'data_table', 'spreadsheet', 'canvas'). Before 688 (record sharing) it has
-- no arm for a spreadsheet or a canvas and answers false (its `else false`),
-- so these policies restrict nothing for them; no grant on either kind exists
-- before 688 in any case. With 688, its arms answer for them. So this file
-- runs, and is right, with or without 688 applied. The service role (no
-- auth.uid()) gets false too, and passes.
--
-- After 690. Redefines no existing function or policy. Re-runnable. No
-- transaction of its own (production applies a file with
-- psql --single-transaction, as 675). No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

drop policy if exists drive_folder_item_insert_not_by_grant on public.drive_folder_item;
create policy drive_folder_item_insert_not_by_grant on public.drive_folder_item
  as restrictive for insert to public
  with check (not public.entity_grant_only(item_type, item_id));

drop policy if exists drive_folder_item_update_not_by_grant on public.drive_folder_item;
create policy drive_folder_item_update_not_by_grant on public.drive_folder_item
  as restrictive for update to public
  using (not public.entity_grant_only(item_type, item_id));

drop policy if exists drive_folder_item_delete_not_by_grant on public.drive_folder_item;
create policy drive_folder_item_delete_not_by_grant on public.drive_folder_item
  as restrictive for delete to public
  using (not public.entity_grant_only(item_type, item_id));

notify pgrst, 'reload schema';

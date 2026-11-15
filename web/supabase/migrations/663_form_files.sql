-- ============================================================
-- 663: Forms take files; a table's row has files.
-- ============================================================
-- A form (660, 661) may now ask for files: a photo of the rug, a PDF. Each
-- file a submission carries becomes an ordinary attachment of the new row,
-- shown wherever the app shows a record's files (src/lib/forms/files.ts says
-- what is taken and how it is checked).
--
--   1. attachments.data_row_id  a file can belong to a table's row. Read
--                               access follows the row's table (520's
--                               data_table_visible_to, through
--                               my_data_table_ids as data_row's own read
--                               policy uses it): one restrictive policy per
--                               action, so the rules for a capture's, an
--                               action's and a project's files are untouched.
--                               A file on a row is changed or deleted only by
--                               someone who can change the table.
--                               on delete cascade, as an action's files are
--                               (an archived row keeps its files, as an
--                               archived action or capture does). A deleted
--                               row's (or table's) attachment rows go with
--                               it, and their storage objects are left in the
--                               bucket, as a deleted action's and capture's
--                               are today: nothing in the app reclaims a
--                               parent's objects when the parent is deleted
--                               (only deleting one file, or the whole
--                               workspace, removes objects), so no queue is
--                               invented for rows here. The daily quota (6)
--                               bounds what forms can leave there.
--   2. attachments.from_form    true on a file a stranger sent through a form;
--      attachments.form_id      the form it came through. Such a file has no
--      user_id nullable         uploader (user_id is null): nobody's own-file
--                               rule reads it, and no member's client may
--                               write one (the restrictive insert and update
--                               refuse from_form). Only the service role
--                               writes them, after the submission's row.
--   3. storage.objects          a row's file's bytes follow its table too, for
--                               its uploader as well. The attachments bucket's
--                               read and delete rules gain the same row arm:
--                               "attachments workspace read" is restated from
--                               223_capture_visibility (its newest
--                               definition), "attachments workspace delete"
--                               from
--                               128_attachments_project_parent_workspace_share
--                               (its newest), each with only the row arm
--                               added. Three restrictive rules (read, update,
--                               delete) then narrow every permissive one, the
--                               baseline's own-folder rules ("Users can view /
--                               update / delete their own files") included: an
--                               object a row's file names (its storage_path or
--                               its thumbnail_path) is read only by someone who
--                               can read every table such a file of it is on,
--                               and changed or deleted only by someone who can
--                               change them, whoever uploaded it. An object no
--                               row's file names passes them untouched.
--                               attachment_object_row_tables(name) answers
--                               which tables those are, as security definer:
--                               the restrictive attachments_row_select hides
--                               the very attachments row from a reader who has
--                               lost the table, so a plain subquery would find
--                               nothing and let them through. One index probe
--                               per column (idx_attachments_storage_path,
--                               idx_attachments_thumbnail_path).
--   4. data_form_attempt.upload_bytes
--                               the bytes of files a try carried, for the byte
--                               caps (per sender and per form, an hour).
--   5. data_form: a form with a files field ("$files" in its fields) must have
--                               the bot check on: a public upload link without
--                               it is an abuse magnet.
--   6. data_form_workspace_upload_bytes(workspace, since)
--                               the bytes of files all of one workspace's
--                               forms took since then, summed in one query
--                               over the try ledger (no new table): the
--                               intake's daily quota per workspace
--                               (src/lib/forms/types.ts
--                               FORM_FILE_LIMITS.workspaceBytesPerDay). The
--                               service role's alone. A partial index on the
--                               tries that carried files serves it (and the
--                               per-form byte cap) from the index.
--
-- Re-runnable. No backslash anywhere in this file.
--
-- Must run on PROD before the app code that reads it deploys: the form intake
-- writes data_form_attempt.upload_bytes and calls
-- data_form_workspace_upload_bytes, and every read of a record's files
-- selects attachments.data_row_id and from_form.
--
-- Apply in a quiet moment. The new columns, the nullable user_id and the
-- checks take a brief exclusive lock on attachments and data_form_attempt,
-- and the indexes are built under a SHARE lock on their table (its writes
-- wait while they build: data_form_attempt is small, pruned after two days,
-- and attachments is not large; reads pass); the policies on storage.objects
-- take a brief exclusive lock on it, which holds the bucket's reads for that
-- instant; the
-- checks are added without a scan and validated on their own (a read of
-- attachments, which is not large). The foreign keys take a brief SHARE ROW
-- EXCLUSIVE lock on data_row and data_form (reads pass, writes wait). Each
-- statement waits at most 5 s for its lock; one that waits longer rolls the
-- whole file back, and it can simply be applied again.

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1 and 2. attachments: a row's files, and a form's
-- ------------------------------------------------------------

alter table public.attachments add column if not exists data_row_id uuid null references public.data_row(id) on delete cascade;
alter table public.attachments add column if not exists from_form boolean not null default false;
alter table public.attachments add column if not exists form_id uuid null references public.data_form(id) on delete set null;
alter table public.attachments alter column user_id drop not null;

comment on column public.attachments.data_row_id is
  'The table row this file belongs to (663). Read as the row''s table is.';
comment on column public.attachments.from_form is
  'A file a stranger sent through a form (663): it has no uploader, its name and text are a stranger''s, and the agents read them only inside the untrusted fence.';
comment on column public.attachments.form_id is
  'The form a from_form file came through.';
comment on column public.attachments.user_id is
  'Who uploaded it. Null only for a file sent through a form (from_form).';

create index if not exists idx_attachments_data_row on public.attachments (data_row_id) where data_row_id is not null;

-- 128's check, with the row as a parent.
alter table public.attachments drop constraint if exists attachments_has_parent;
alter table public.attachments
  add constraint attachments_has_parent check (note_id is not null or action_id is not null or project_id is not null or data_row_id is not null) not valid;
alter table public.attachments validate constraint attachments_has_parent;

alter table public.attachments drop constraint if exists attachments_uploader;
alter table public.attachments
  add constraint attachments_uploader check (user_id is not null or from_form) not valid;
alter table public.attachments validate constraint attachments_uploader;

alter table public.attachments drop constraint if exists attachments_from_form_on_row;
alter table public.attachments
  add constraint attachments_from_form_on_row check (not from_form or (data_row_id is not null and user_id is null)) not valid;
alter table public.attachments validate constraint attachments_from_form_on_row;

-- Restrictive, so every permissive rule (a member's, an uploader's own) is
-- narrowed by the row's table and nothing else changes.
drop policy if exists attachments_row_select on public.attachments;
create policy attachments_row_select on public.attachments
  as restrictive for select to public
  using (
    data_row_id is null
    or exists (
      select 1
        from public.data_row r
       where r.id = attachments.data_row_id
         and r.table_id = any ((select public.my_data_table_ids())::uuid[])
    )
  );

drop policy if exists attachments_row_insert on public.attachments;
create policy attachments_row_insert on public.attachments
  as restrictive for insert to public
  with check (
    not from_form
    and (
      data_row_id is null
      or exists (
        select 1
          from public.data_row r
         where r.id = attachments.data_row_id
           and public.data_table_editable_by(r.table_id, auth.uid())
      )
    )
  );

drop policy if exists attachments_row_update on public.attachments;
create policy attachments_row_update on public.attachments
  as restrictive for update to public
  using (not from_form)
  with check (
    not from_form
    and (
      data_row_id is null
      or exists (
        select 1
          from public.data_row r
         where r.id = attachments.data_row_id
           and public.data_table_editable_by(r.table_id, auth.uid())
      )
    )
  );

drop policy if exists attachments_row_delete on public.attachments;
create policy attachments_row_delete on public.attachments
  as restrictive for delete to public
  using (
    data_row_id is null
    or exists (
      select 1
        from public.data_row r
       where r.id = attachments.data_row_id
         and public.data_table_editable_by(r.table_id, auth.uid())
    )
  );

-- ------------------------------------------------------------
-- 3. storage.objects: the bytes follow the row's table
-- ------------------------------------------------------------

-- From 223_capture_visibility.sql, with the row arm added.
drop policy if exists "attachments workspace read" on storage.objects;
create policy "attachments workspace read" on storage.objects
  for select using (
    bucket_id = 'attachments' and exists (
      select 1 from public.attachments a
      where (a.storage_path = storage.objects.name or a.thumbnail_path = storage.objects.name)
        and public.is_workspace_member(a.workspace_id)
        and (
          a.note_id is null
          or exists (
            select 1 from public.captures c
            where c.id = a.note_id
              and (c.visibility = 'workspace' or c.user_id = auth.uid())
          )
        )
        and (
          a.data_row_id is null
          or exists (
            select 1 from public.data_row r
            where r.id = a.data_row_id
              and r.table_id = any ((select public.my_data_table_ids())::uuid[])
          )
        )
    )
  );

-- From 128_attachments_project_parent_workspace_share.sql, with the row arm added.
drop policy if exists "attachments workspace delete" on storage.objects;
create policy "attachments workspace delete" on storage.objects
  for delete using (
    bucket_id = 'attachments' and exists (
      select 1 from public.attachments a
      where (a.storage_path = storage.objects.name or a.thumbnail_path = storage.objects.name)
        and public.is_workspace_member(a.workspace_id)
        and (
          a.data_row_id is null
          or exists (
            select 1 from public.data_row r
            where r.id = a.data_row_id
              and public.data_table_editable_by(r.table_id, auth.uid())
          )
        )
    )
  );

-- The two rules above are permissive, so the baseline's own-folder rules
-- ("Users can view / update / delete their own files": the first folder is
-- the uploader's id, and a member's upload lives there, see
-- src/app/api/account/attachments/route.ts) still let an uploader read,
-- overwrite or delete a row's file's bytes after losing its table. The
-- restrictive rules below close that for every permissive rule at once.

-- An object's name is matched where the app writes it: attachments.storage_path
-- (the route registers the client's own-folder path; a form's file is
-- forms/<workspace>/<form>/<id>.<ext>, src/lib/forms/file-store.ts) and
-- attachments.thumbnail_path (a second object, removed with its file by
-- src/app/api/account/attachments/[id]/route.ts). Neither had an index; the
-- bucket's permissive rules read them too.
create index if not exists idx_attachments_storage_path on public.attachments (storage_path);
create index if not exists idx_attachments_thumbnail_path on public.attachments (thumbnail_path) where thumbnail_path is not null;

-- The tables whose rows have a file naming this object; null when none does.
-- Security definer: the caller's own attachments_row_select hides a row's
-- file from a reader who has lost its table, and that reader is exactly the
-- one to stop. Every such table, not one: a member may register a second
-- attachments row naming an object (the insert rule does not read
-- storage_path), and a lone answer could then be the table they edit.
create or replace function public.attachment_object_row_tables(p_name text)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_agg(distinct r.table_id)
    from (
      select a.data_row_id from public.attachments a
       where a.storage_path = p_name and a.data_row_id is not null
      union all
      select a.data_row_id from public.attachments a
       where a.thumbnail_path = p_name and a.data_row_id is not null
    ) f
    join public.data_row r on r.id = f.data_row_id;
$$;

comment on function public.attachment_object_row_tables(text) is
  'The tables whose rows have an attachment naming this storage object (663); null when none does. Read by the attachments bucket''s restrictive storage rules.';

revoke all on function public.attachment_object_row_tables(text) from public, anon;
grant execute on function public.attachment_object_row_tables(text) to authenticated, service_role;

-- Restrictive: an object no row's file names passes (unnest of null is no
-- table, and coalesce answers true); one that a row's file names passes only
-- when the caller can read (or change) every such table.
drop policy if exists "attachments row files read" on storage.objects;
create policy "attachments row files read" on storage.objects
  as restrictive for select to authenticated
  using (
    bucket_id <> 'attachments'
    or coalesce((
      select bool_and(coalesce(public.data_table_visible_to(t.id, auth.uid()), false))
        from unnest(public.attachment_object_row_tables(storage.objects.name)) as t(id)
    ), true)
  );

drop policy if exists "attachments row files update" on storage.objects;
create policy "attachments row files update" on storage.objects
  as restrictive for update to authenticated
  using (
    bucket_id <> 'attachments'
    or coalesce((
      select bool_and(coalesce(public.data_table_editable_by(t.id, auth.uid()), false))
        from unnest(public.attachment_object_row_tables(storage.objects.name)) as t(id)
    ), true)
  )
  with check (
    bucket_id <> 'attachments'
    or coalesce((
      select bool_and(coalesce(public.data_table_editable_by(t.id, auth.uid()), false))
        from unnest(public.attachment_object_row_tables(storage.objects.name)) as t(id)
    ), true)
  );

drop policy if exists "attachments row files delete" on storage.objects;
create policy "attachments row files delete" on storage.objects
  as restrictive for delete to authenticated
  using (
    bucket_id <> 'attachments'
    or coalesce((
      select bool_and(coalesce(public.data_table_editable_by(t.id, auth.uid()), false))
        from unnest(public.attachment_object_row_tables(storage.objects.name)) as t(id)
    ), true)
  );

-- ------------------------------------------------------------
-- 4. data_form_attempt.upload_bytes
-- ------------------------------------------------------------

alter table public.data_form_attempt add column if not exists upload_bytes bigint not null default 0;

comment on column public.data_form_attempt.upload_bytes is
  'The bytes of files this try carried (663), counted by the byte caps: per sender and per form, an hour.';

alter table public.data_form_attempt drop constraint if exists data_form_attempt_upload_bytes_range;
alter table public.data_form_attempt
  add constraint data_form_attempt_upload_bytes_range check (upload_bytes >= 0) not valid;
alter table public.data_form_attempt validate constraint data_form_attempt_upload_bytes_range;

-- ------------------------------------------------------------
-- 5. data_form: files need the bot check
-- ------------------------------------------------------------

comment on column public.data_form.fields is
  'What a submission may fill, in order: [{key, label, required}]. key is a column''s key, "$title" for the row''s name, or "$files" for the files it takes (at most one, 663). Anything else posted is dropped.';

alter table public.data_form drop constraint if exists data_form_files_need_bot_check;
alter table public.data_form
  add constraint data_form_files_need_bot_check check (bot_check or not (fields @> '[{"key": "$files"}]'::jsonb)) not valid;
alter table public.data_form validate constraint data_form_files_need_bot_check;

-- ------------------------------------------------------------
-- 6. a workspace's upload bytes, for its daily quota
-- ------------------------------------------------------------

create index if not exists data_form_attempt_upload_idx
  on public.data_form_attempt (form_id, created_at) include (upload_bytes)
  where upload_bytes > 0;

create or replace function public.data_form_workspace_upload_bytes(p_workspace_id uuid, p_since timestamptz)
returns bigint
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(a.upload_bytes), 0)::bigint
    from public.data_form_attempt a
    join public.data_form f on f.id = a.form_id
   where f.workspace_id = p_workspace_id
     and a.created_at >= p_since
     and a.upload_bytes > 0;
$$;

comment on function public.data_form_workspace_upload_bytes(uuid, timestamptz) is
  'The bytes of files all of a workspace''s forms took since p_since (663): the form intake''s daily quota per workspace.';

revoke all on function public.data_form_workspace_upload_bytes(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.data_form_workspace_upload_bytes(uuid, timestamptz) to service_role;

notify pgrst, 'reload schema';

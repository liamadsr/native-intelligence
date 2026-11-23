-- ============================================================
-- 709: Drive uploads, a file's place in a folder, and when a file was opened.
-- ============================================================
-- Why: Drive files (docs/plans/drive-files.md, phase 2). A file can now be
-- dropped on a Drive folder, filed and moved there like a doc, and Drive's
-- Recent tab and "sort by opened" need to know when the person last opened
-- a file. Team chat files are listed in Drive, newest first.
--
-- What lands:
--   attachments.drive_upload   true on a file uploaded to Drive itself: a
--                              file on no record. Set when it is made and
--                              never changed. Such a file has no other parent
--                              (no capture, action, project or row), is never
--                              a form's, and always has its uploader.
--                              attachments_has_parent is restated so an
--                              ordinary file still needs a parent, exactly as
--                              663 left it, or is a Drive upload.
--   drive_upload_visible_to    the read rule for a Drive upload, in one place
--                              (security definer, it answers for the caller
--                              or an explicit person):
--                                - its uploader, always;
--                                - while it is filed in a folder, every
--                                  non-guest member of the workspace, who are
--                                  exactly the folder's readers (690: folders
--                                  are the workspace's, guests have none);
--                                - an unfiled upload, its uploader only;
--                                - no person (an unattended run), no one.
--                              Never more people than its folder has.
--   attachments policies       four RESTRICTIVE policies, so every permissive
--                              rule on the table (493's member read, the
--                              baseline's member delete, the uploader's own)
--                              is narrowed for a Drive upload only:
--                                - read: drive_upload_visible_to;
--                                - add: as oneself, by a non-guest member of
--                                  the workspace;
--                                - change or delete: its uploader only.
--                              The attachments bucket's read rule (663) reads
--                              this table as the caller, so a Drive upload's
--                              bytes follow the same rule.
--   drive_folder_item          takes 'attachment' (its type check widened, and
--                              drive_folder_item_readable restated from 690
--                              with one arm, still under the reader's own row
--                              security). Three RESTRICTIVE policies, beside
--                              690's and 693's: an 'attachment' is filed,
--                              moved or unfiled only by its uploader, and only
--                              when it is a Drive upload. Filing is what
--                              shares it with the folder's readers, so only
--                              the person who may share it does it; a grant
--                              never reaches it (693's fence asks
--                              entity_grant_only, which answers false here:
--                              no grant names an attachment). Deleting a
--                              folder unfiles it (690's cascade), which makes
--                              it its uploader's again: narrower, never wider.
--   entity_visible_to (both)   restated from 664 (the newest; nothing since
--                              restates either) with the Drive upload arm
--                              only: the graph and the agents' fences read it.
--   attachment_readable_by     restated from 708 (the attachments table's
--                              read rule for an explicit person, which
--                              hybrid_search_attachments and
--                              attachment_rag_search ask) with one AND, so
--                              an agent's search finds a Drive upload's
--                              text only for those who may read it; the two
--                              searches are not restated.
--                              src/lib/drive/__tests__/migration-709.test.ts
--                              holds each restated body equal to its source
--                              with only these lines added.
--   drive_file_open            when a person last opened a file in Drive: one
--                              row a person, workspace and file (an upload,
--                              'upload:<attachment id>', or a team chat file,
--                              'team_chat:<its object path>'). A mail
--                              attachment is never recorded: that would keep
--                              something of the mail (344). Each person reads
--                              and writes their own rows only, in a workspace
--                              they belong to.
--   team_chat_message index    a partial index on the live messages that carry
--                              files, for Drive's newest-first list.
--
-- The guards are in the 359/369/675 style: a before-write trigger holds a
-- client's own token; the service role (whose callers check the person
-- first) and a database owner are not held to them.
--
-- No realtime publication. Re-runnable. Its own transaction (begin ...
-- commit), so it is all or nothing however it is applied. No backslashes
-- anywhere in this file. After 690, 693, 664 and 708. Each statement waits at most
-- 5 s for a lock; one that waits longer rolls the file back, to be applied
-- again.
-- ============================================================

begin;

SET LOCAL lock_timeout = '5s';

-- ── A. Drive uploads ────────────────────────────────────────────────────────

alter table public.attachments add column if not exists drive_upload boolean not null default false;

comment on column public.attachments.drive_upload is
  'A file uploaded to Drive itself, on no record (709). Read by its uploader, and by the workspace''s non-guest members while it is filed in a folder: drive_upload_visible_to.';

-- 663's rule, with a Drive upload as the one file that needs no other parent.
alter table public.attachments drop constraint if exists attachments_has_parent;
alter table public.attachments
  add constraint attachments_has_parent
  check (note_id is not null or action_id is not null or project_id is not null or data_row_id is not null or drive_upload) not valid;
alter table public.attachments validate constraint attachments_has_parent;

-- A Drive upload is on nothing else, never a form's, and always has its uploader.
alter table public.attachments drop constraint if exists attachments_drive_upload_alone;
alter table public.attachments
  add constraint attachments_drive_upload_alone
  check (not drive_upload or (note_id is null and action_id is null and project_id is null and data_row_id is null and not from_form and user_id is not null)) not valid;
alter table public.attachments validate constraint attachments_drive_upload_alone;

create index if not exists idx_attachments_drive_upload
  on public.attachments (workspace_id, user_id, created_at desc)
  where drive_upload;

-- Set when it is made, never changed; and its uploader never changes either.
create or replace function public.attachments_drive_upload_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.drive_upload is distinct from old.drive_upload then
    raise exception 'Whether a file is a Drive upload is set when it is made.' using errcode = '42501';
  end if;
  if old.drive_upload and new.user_id is distinct from old.user_id then
    raise exception 'A Drive upload keeps its uploader.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists attachments_drive_upload_guard on public.attachments;
create trigger attachments_drive_upload_guard
  before update on public.attachments
  for each row execute function public.attachments_drive_upload_guard();

-- The read rule (see the header). Definer: it reads the folder's filing
-- without the folder tables' own policies, which ask this table back (no
-- loop). A signed-in caller asks only about themself.
create or replace function public.drive_upload_visible_to(p_id uuid, p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ws uuid;
  v_owner uuid;
  v_drive boolean;
begin
  if p_id is null or p_user is null then return false; end if;
  if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;
  select a.workspace_id, a.user_id, a.drive_upload into v_ws, v_owner, v_drive
    from public.attachments a where a.id = p_id;
  if v_ws is null or v_drive is not true then return false; end if;
  if v_owner = p_user then return true; end if;
  return exists (
      select 1
        from public.drive_folder_item i
        join public.drive_folder f on f.id = i.folder_id and f.workspace_id = v_ws
       where i.item_type = 'attachment' and i.item_id = p_id and i.workspace_id = v_ws
    )
    and exists (
      select 1 from public.member m
       where m.workspace_id = v_ws and m.user_id = p_user and m.role is distinct from 'guest'
    );
end;
$$;

comment on function public.drive_upload_visible_to(uuid, uuid) is
  'May this person read this Drive upload (709)? Its uploader, or a non-guest member while it is filed in a folder; no one else, and no one with no person.';

revoke all on function public.drive_upload_visible_to(uuid, uuid) from public, anon;
grant execute on function public.drive_upload_visible_to(uuid, uuid) to authenticated, service_role;

drop policy if exists attachments_drive_upload_select on public.attachments;
create policy attachments_drive_upload_select on public.attachments
  as restrictive for select to public
  using (not drive_upload or public.drive_upload_visible_to(id, (select auth.uid())));

drop policy if exists attachments_drive_upload_insert on public.attachments;
create policy attachments_drive_upload_insert on public.attachments
  as restrictive for insert to public
  with check (
    not drive_upload
    or (user_id = (select auth.uid()) and public.drive_folder_member(workspace_id))
  );

drop policy if exists attachments_drive_upload_update on public.attachments;
create policy attachments_drive_upload_update on public.attachments
  as restrictive for update to public
  using (not drive_upload or user_id = (select auth.uid()))
  with check (not drive_upload or user_id = (select auth.uid()));

drop policy if exists attachments_drive_upload_delete on public.attachments;
create policy attachments_drive_upload_delete on public.attachments
  as restrictive for delete to public
  using (not drive_upload or user_id = (select auth.uid()));

-- ── B. A Drive upload's place in a folder ───────────────────────────────────

alter table public.drive_folder_item drop constraint if exists drive_folder_item_type_check;
alter table public.drive_folder_item
  add constraint drive_folder_item_type_check
  check (item_type in ('document', 'data_table', 'spreadsheet', 'canvas', 'attachment')) not valid;
alter table public.drive_folder_item validate constraint drive_folder_item_type_check;

-- 690's, with the 'attachment' arm: a Drive upload the caller can read, in
-- this workspace, read under their own row security (so the restrictive read
-- rule above decides it).
create or replace function public.drive_folder_item_readable(p_type text, p_id uuid, p_workspace_id uuid)
returns boolean
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if p_type = 'document' then
    return exists (select 1 from public.document d where d.id = p_id and d.workspace_id = p_workspace_id);
  elsif p_type = 'data_table' then
    return exists (select 1 from public.data_table t where t.id = p_id and t.workspace_id = p_workspace_id);
  elsif p_type = 'spreadsheet' then
    return exists (select 1 from public.spreadsheet s where s.id = p_id and s.workspace_id = p_workspace_id);
  elsif p_type = 'canvas' then
    return exists (select 1 from public.canvas c where c.id = p_id and c.workspace_id = p_workspace_id);
  elsif p_type = 'attachment' then
    return exists (select 1 from public.attachments a where a.id = p_id and a.workspace_id = p_workspace_id and a.drive_upload);
  end if;
  return false;
end;
$$;

-- Filing shares a Drive upload with the folder's readers: only its uploader
-- files, moves or unfiles it, and only a Drive upload is filed. Restrictive,
-- beside 690's permissive rules and 693's fence. Read under the caller's own
-- row security: the uploader always reads their own.
drop policy if exists drive_folder_item_attachment_insert on public.drive_folder_item;
create policy drive_folder_item_attachment_insert on public.drive_folder_item
  as restrictive for insert to authenticated
  with check (
    item_type <> 'attachment'
    or exists (
      select 1 from public.attachments a
       where a.id = drive_folder_item.item_id and a.drive_upload and a.user_id = (select auth.uid())
    )
  );

drop policy if exists drive_folder_item_attachment_update on public.drive_folder_item;
create policy drive_folder_item_attachment_update on public.drive_folder_item
  as restrictive for update to authenticated
  using (
    item_type <> 'attachment'
    or exists (
      select 1 from public.attachments a
       where a.id = drive_folder_item.item_id and a.drive_upload and a.user_id = (select auth.uid())
    )
  )
  with check (
    item_type <> 'attachment'
    or exists (
      select 1 from public.attachments a
       where a.id = drive_folder_item.item_id and a.drive_upload and a.user_id = (select auth.uid())
    )
  );

drop policy if exists drive_folder_item_attachment_delete on public.drive_folder_item;
create policy drive_folder_item_attachment_delete on public.drive_folder_item
  as restrictive for delete to authenticated
  using (
    item_type <> 'attachment'
    or exists (
      select 1 from public.attachments a
       where a.id = drive_folder_item.item_id and a.drive_upload and a.user_id = (select auth.uid())
    )
  );

-- ── C. The shared read rules, with the Drive upload arm ─────────────────────

-- entity_visible_to, from 664_row_file_visibility.sql, with the Drive upload arm.
create or replace function public.entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ws uuid;
  v_member uuid;
  v_vis text;
  v_owner uuid;
  v_created_by uuid;
  v_note uuid;
  v_kind text;
  v_team uuid;
  v_channel uuid;
  v_confirmation text;
  v_table uuid;
  v_drive boolean := false;
  v_type text := public.entity_kind_current(p_type);
begin
  if p_id is null then return false; end if;
  -- A signed-in caller asks only about themself.
  if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;

  if v_type = 'document' then
    select d.workspace_id, d.visibility, d.created_by into v_ws, v_vis, v_created_by
      from public.document d where d.id = p_id;
  elsif v_type = 'capture' then
    select c.workspace_id, c.visibility, c.user_id into v_ws, v_vis, v_owner
      from public.captures c where c.id = p_id;
  elsif v_type = 'contact' then
    select ct.workspace_id into v_ws from public.contact ct where ct.id = p_id;
  elsif v_type = 'company' then
    select co.workspace_id into v_ws from public.company co where co.id = p_id;
  elsif v_type = 'claim' then
    select cl.workspace_id into v_ws from public.claim cl where cl.id = p_id;
  elsif v_type = 'attachment' then
    -- A file on a table's row (663) carries the row's table in v_table.
    select a.workspace_id, a.user_id, a.note_id, r.table_id, a.drive_upload into v_ws, v_owner, v_note, v_table, v_drive
      from public.attachments a left join public.data_row r on r.id = a.data_row_id where a.id = p_id;
  elsif v_type = 'email_thread' then
    select e.workspace_id, e.user_id into v_ws, v_owner from public.email_thread_index e where e.id = p_id;
  elsif v_type = 'conversation' then
    select cc.workspace_id, cc.user_id into v_ws, v_owner from public.chat_conversations cc where cc.id = p_id;
  elsif v_type = 'calendar_event' then
    select ev.workspace_id, ev.user_id into v_ws, v_owner from public.local_calendar_event ev where ev.id = p_id;
  elsif v_type = 'team_chat_channel' then
    select ch.workspace_id, ch.kind, ch.team_id, ch.id into v_ws, v_kind, v_team, v_channel
      from public.team_chat_channel ch where ch.id = p_id;
  elsif v_type = 'team_chat_message' then
    select ch.workspace_id, ch.kind, ch.team_id, ch.id into v_ws, v_kind, v_team, v_channel
      from public.team_chat_message msg
      join public.team_chat_channel ch on ch.id = msg.channel_id and ch.workspace_id = msg.workspace_id
     where msg.id = p_id;
  elsif v_type = 'decision' then
    select c.workspace_id, c.visibility, c.user_id, dc.confirmation, c.id into v_ws, v_vis, v_owner, v_confirmation, v_note
      from public.decision dc join public.captures c on c.id = dc.capture_id where dc.id = p_id;
  elsif v_type = 'data_table' then
    select t.workspace_id, t.id into v_ws, v_table from public.data_table t where t.id = p_id;
  elsif v_type = 'data_row' then
    select r.workspace_id, r.table_id into v_ws, v_table from public.data_row r where r.id = p_id;
  else
    -- Every other kind is every member's: a member of the workspace reads it.
    v_ws := p_workspace;
  end if;

  -- Gone, or not in the workspace asked about: not visible.
  if v_ws is null or (p_workspace is not null and v_ws <> p_workspace) then return false; end if;

  -- No user: the service role asking for no one in particular (an unattended
  -- run, whose output the whole workspace reads). Only what every member of
  -- the workspace reads, the explicit-user twins' own null-user answers. The
  -- private graph kinds (src/lib/knowledge/entity-fences.ts) are no one's to
  -- see on such a run, as that file's fences say.
  if p_user is null then
    if v_type in ('email_thread', 'conversation', 'calendar_event', 'team_chat_channel', 'team_chat_message', 'decision', 'data_table', 'data_row') then return false;
    elsif v_type in ('document', 'capture') then return v_vis = 'workspace';
    elsif v_type = 'contact' then return public.contact_visible_to(p_id, null);
    elsif v_type = 'company' then return public.company_visible_to(p_id, null);
    elsif v_type = 'claim' then return public.claim_visible_to(p_id, null);
    elsif v_type = 'attachment' then
      -- A Drive upload (709) is its uploader's, or its folder's readers': no one's on such a run.
      if v_drive then return false; end if;
      -- A row's file is its table's: no one's on such a run, as the row is.
      if v_table is not null then return false; end if;
      return v_note is null or exists (select 1 from public.captures c where c.id = v_note and c.visibility = 'workspace');
    end if;
    return true;
  end if;

  -- A table, and a row through its table: 520's rule for p_user.
  if v_type in ('data_table', 'data_row') then return public.data_table_visible_to(v_table, p_user); end if;

  -- The kinds that are their owner's alone need no membership read.
  if v_type in ('email_thread', 'conversation', 'calendar_event') then return v_owner = p_user; end if;
  -- A row's file (663) is read as its row's table is, whoever uploaded it
  -- (the restrictive attachments_row_select's rule).
  if v_type = 'attachment' and v_table is not null and public.data_table_visible_to(v_table, p_user) is not true then return false; end if;
  -- A Drive upload (709): its uploader, or a non-guest member while it is filed in a folder.
  if v_type = 'attachment' and v_drive then return public.drive_upload_visible_to(p_id, p_user); end if;
  if v_type = 'attachment' and v_owner = p_user then return true; end if;

  select m.id into v_member from public.member m where m.workspace_id = v_ws and m.user_id = p_user limit 1;
  if v_member is null then return false; end if;

  if v_type = 'document' then
    if v_vis = 'workspace' or (v_created_by is not null and v_created_by = v_member) then return true; end if;
    return public.entity_grant_reaches('document', p_id, v_ws, p_user);
  elsif v_type = 'capture' then
    if v_vis = 'workspace' or v_owner = p_user then return true; end if;
    return public.entity_grant_reaches('capture', p_id, v_ws, p_user);
  elsif v_type = 'contact' then
    return public.contact_visible_to(p_id, p_user);
  elsif v_type = 'company' then
    return public.company_visible_to(p_id, p_user);
  elsif v_type = 'claim' then
    return public.claim_visible_to(p_id, p_user);
  elsif v_type = 'attachment' then
    if v_note is null then return true; end if;
    select c.visibility, c.user_id into v_vis, v_owner from public.captures c where c.id = v_note;
    if v_vis is null then return false; end if;
    if v_vis = 'workspace' or v_owner = p_user then return true; end if;
    return public.entity_grant_reaches('capture', v_note, v_ws, p_user);
  elsif v_type in ('team_chat_channel', 'team_chat_message') then
    -- team_chat_can_read (474) for p_user: a team channel is its team's
    -- (every member's when it has none), a DM its members'.
    if v_kind = 'channel' then
      return v_team is null or exists (select 1 from public.team_member tm where tm.team_id = v_team and tm.member_id = v_member);
    end if;
    return v_kind in ('dm', 'meeting') and exists (select 1 from public.team_chat_member cm where cm.channel_id = v_channel and cm.member_id = v_member);
  elsif v_type = 'decision' then
    -- The decision table's view policy (493), through its capture.
    if v_vis = 'workspace' or v_owner = p_user or v_confirmation = 'confirmed' then return true; end if;
    return public.entity_grant_reaches('capture', v_note, v_ws, p_user);
  end if;
  return true;
end;
$$;

-- The 5-arg entity_visible_to, from 664_row_file_visibility.sql, with the Drive upload arm.
create or replace function public.entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid, p_grants boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ws uuid;
  v_member uuid;
  v_vis text;
  v_owner uuid;
  v_created_by uuid;
  v_note uuid;
  v_kind text;
  v_team uuid;
  v_channel uuid;
  v_confirmation text;
  v_table uuid;
  v_drive boolean := false;
  v_type text := public.entity_kind_current(p_type);
begin
  if p_id is null then return false; end if;
  -- A signed-in caller asks only about themself.
  if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;

  if v_type = 'document' then
    select d.workspace_id, d.visibility, d.created_by into v_ws, v_vis, v_created_by
      from public.document d where d.id = p_id;
  elsif v_type = 'capture' then
    select c.workspace_id, c.visibility, c.user_id into v_ws, v_vis, v_owner
      from public.captures c where c.id = p_id;
  elsif v_type = 'contact' then
    select ct.workspace_id into v_ws from public.contact ct where ct.id = p_id;
  elsif v_type = 'company' then
    select co.workspace_id into v_ws from public.company co where co.id = p_id;
  elsif v_type = 'claim' then
    select cl.workspace_id into v_ws from public.claim cl where cl.id = p_id;
  elsif v_type = 'attachment' then
    -- A file on a table's row (663) carries the row's table in v_table.
    select a.workspace_id, a.user_id, a.note_id, r.table_id, a.drive_upload into v_ws, v_owner, v_note, v_table, v_drive
      from public.attachments a left join public.data_row r on r.id = a.data_row_id where a.id = p_id;
  elsif v_type = 'email_thread' then
    select e.workspace_id, e.user_id into v_ws, v_owner from public.email_thread_index e where e.id = p_id;
  elsif v_type = 'conversation' then
    select cc.workspace_id, cc.user_id into v_ws, v_owner from public.chat_conversations cc where cc.id = p_id;
  elsif v_type = 'calendar_event' then
    select ev.workspace_id, ev.user_id into v_ws, v_owner from public.local_calendar_event ev where ev.id = p_id;
  elsif v_type = 'team_chat_channel' then
    select ch.workspace_id, ch.kind, ch.team_id, ch.id into v_ws, v_kind, v_team, v_channel
      from public.team_chat_channel ch where ch.id = p_id;
  elsif v_type = 'team_chat_message' then
    select ch.workspace_id, ch.kind, ch.team_id, ch.id into v_ws, v_kind, v_team, v_channel
      from public.team_chat_message msg
      join public.team_chat_channel ch on ch.id = msg.channel_id and ch.workspace_id = msg.workspace_id
     where msg.id = p_id;
  elsif v_type = 'decision' then
    select c.workspace_id, c.visibility, c.user_id, dc.confirmation, c.id into v_ws, v_vis, v_owner, v_confirmation, v_note
      from public.decision dc join public.captures c on c.id = dc.capture_id where dc.id = p_id;
  elsif v_type = 'data_table' then
    select t.workspace_id, t.id into v_ws, v_table from public.data_table t where t.id = p_id;
  elsif v_type = 'data_row' then
    select r.workspace_id, r.table_id into v_ws, v_table from public.data_row r where r.id = p_id;
  else
    -- Every other kind is every member's: a member of the workspace reads it.
    v_ws := p_workspace;
  end if;

  -- Gone, or not in the workspace asked about: not visible.
  if v_ws is null or (p_workspace is not null and v_ws <> p_workspace) then return false; end if;

  -- No user: the service role asking for no one in particular (an unattended
  -- run, whose output the whole workspace reads). Only what every member of
  -- the workspace reads, the explicit-user twins' own null-user answers. The
  -- private graph kinds (src/lib/knowledge/entity-fences.ts) are no one's to
  -- see on such a run, as that file's fences say.
  if p_user is null then
    if v_type in ('email_thread', 'conversation', 'calendar_event', 'team_chat_channel', 'team_chat_message', 'decision', 'data_table', 'data_row') then return false;
    elsif v_type in ('document', 'capture') then return v_vis = 'workspace';
    elsif v_type = 'contact' then return public.contact_visible_to(p_id, null);
    elsif v_type = 'company' then return public.company_visible_to(p_id, null);
    elsif v_type = 'claim' then return public.claim_visible_to(p_id, null);
    elsif v_type = 'attachment' then
      -- A Drive upload (709) is its uploader's, or its folder's readers': no one's on such a run.
      if v_drive then return false; end if;
      -- A row's file is its table's: no one's on such a run, as the row is.
      if v_table is not null then return false; end if;
      return v_note is null or exists (select 1 from public.captures c where c.id = v_note and c.visibility = 'workspace');
    end if;
    return true;
  end if;

  -- A table, and a row through its table: 520's rule for p_user, its grant
  -- arm only when grants count.
  if v_type in ('data_table', 'data_row') then
    return case when p_grants is true then public.data_table_visible_to(v_table, p_user)
                else public.data_table_visible_ungranted(v_table, p_user) end;
  end if;

  -- The kinds that are their owner's alone need no membership read.
  if v_type in ('email_thread', 'conversation', 'calendar_event') then return v_owner = p_user; end if;
  -- A row's file (663) is read as its row's table is, whoever uploaded it
  -- (the restrictive attachments_row_select's rule), its grant arm only when
  -- grants count.
  if v_type = 'attachment' and v_table is not null
     and (case when p_grants is true then public.data_table_visible_to(v_table, p_user)
               else public.data_table_visible_ungranted(v_table, p_user) end) is not true then return false; end if;
  -- A Drive upload (709): its uploader, or a non-guest member while it is filed in a folder.
  if v_type = 'attachment' and v_drive then return public.drive_upload_visible_to(p_id, p_user); end if;
  if v_type = 'attachment' and v_owner = p_user then return true; end if;

  select m.id into v_member from public.member m where m.workspace_id = v_ws and m.user_id = p_user limit 1;
  if v_member is null then return false; end if;

  if v_type = 'document' then
    if v_vis = 'workspace' or (v_created_by is not null and v_created_by = v_member) then return true; end if;
    return p_grants is true and public.entity_grant_reaches('document', p_id, v_ws, p_user);
  elsif v_type = 'capture' then
    if v_vis = 'workspace' or v_owner = p_user then return true; end if;
    return p_grants is true and public.entity_grant_reaches('capture', p_id, v_ws, p_user);
  elsif v_type = 'contact' then
    return public.contact_visible_to(p_id, p_user, p_grants is true);
  elsif v_type = 'company' then
    return public.company_visible_to(p_id, p_user, p_grants is true);
  elsif v_type = 'claim' then
    return public.claim_visible_to(p_id, p_user);
  elsif v_type = 'attachment' then
    if v_note is null then return true; end if;
    select c.visibility, c.user_id into v_vis, v_owner from public.captures c where c.id = v_note;
    if v_vis is null then return false; end if;
    if v_vis = 'workspace' or v_owner = p_user then return true; end if;
    return p_grants is true and public.entity_grant_reaches('capture', v_note, v_ws, p_user);
  elsif v_type in ('team_chat_channel', 'team_chat_message') then
    -- team_chat_can_read (474) for p_user: a team channel is its team's
    -- (every member's when it has none), a DM its members'.
    if v_kind = 'channel' then
      return v_team is null or exists (select 1 from public.team_member tm where tm.team_id = v_team and tm.member_id = v_member);
    end if;
    return v_kind in ('dm', 'meeting') and exists (select 1 from public.team_chat_member cm where cm.channel_id = v_channel and cm.member_id = v_member);
  elsif v_type = 'decision' then
    -- The decision table's view policy (493), through its capture.
    if v_vis = 'workspace' or v_owner = p_user or v_confirmation = 'confirmed' then return true; end if;
    return p_grants is true and public.entity_grant_reaches('capture', v_note, v_ws, p_user);
  end if;
  return true;
end;
$$;

-- attachment_readable_by, from 708_attachment_search_fence.sql, with the Drive upload AND: the one
-- fence hybrid_search_attachments and attachment_rag_search ask (708), so find and deep_search
-- read a Drive upload by its own rule without being restated here.
create or replace function public.attachment_readable_by(p_attachment_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    -- A signed-in caller asks only about themself.
    (auth.uid() is null or p_user_id is not distinct from auth.uid())
    and coalesce((
      select
        -- restrictive attachments_row_select (663): a row's file is its table's
        -- readers' alone; with no requester, no one's.
        (a.data_row_id is null
          or (p_user_id is not null and exists (
                select 1 from public.data_row r
                 where r.id = a.data_row_id
                   and public.data_table_visible_to(r.table_id, p_user_id))))
        and (
          -- attachments_user_select (baseline): the uploader's own.
          (p_user_id is not null and a.user_id = p_user_id)
          -- attachments_workspace_select (493): a member's, through its capture.
          or (
            (p_user_id is null
              or exists (select 1 from public.member m where m.workspace_id = a.workspace_id and m.user_id = p_user_id))
            and (
              a.note_id is null
              or exists (
                select 1 from public.captures c
                 where c.id = a.note_id
                   and (c.visibility = 'workspace'
                        or (p_user_id is not null
                            and (c.user_id = p_user_id
                                 or public.entity_grant_reaches('capture', c.id, c.workspace_id, p_user_id)))))
            )
          )
        )
        -- A Drive upload (709): its uploader, or a non-guest member while it is filed in a folder.
        and (not a.drive_upload or public.drive_upload_visible_to(a.id, p_user_id))
        from public.attachments a
       where a.id = p_attachment_id
    ), false);
$$;

-- ── D. When a person last opened a file ─────────────────────────────────────

create table if not exists public.drive_file_open (
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  file_key text not null,
  opened_at timestamptz not null default now(),
  primary key (user_id, workspace_id, file_key),
  -- An upload by its id, or a team chat file by its object path; never mail (344).
  constraint drive_file_open_key_check check (
    file_key ~ '^upload:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or (file_key like 'team_chat:%' and char_length(file_key) between 11 and 400)
  )
);

create index if not exists drive_file_open_recent_idx
  on public.drive_file_open (user_id, workspace_id, opened_at desc);

-- A client's row is always its own, in a workspace it belongs to.
create or replace function public.drive_file_open_before_write()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if new.user_id is distinct from auth.uid() then
      raise exception 'Only one''s own opens are recorded.' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and (new.workspace_id is distinct from old.workspace_id or new.file_key is distinct from old.file_key) then
      raise exception 'An open names the same file.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists drive_file_open_before_write on public.drive_file_open;
create trigger drive_file_open_before_write
  before insert or update on public.drive_file_open
  for each row execute function public.drive_file_open_before_write();

alter table public.drive_file_open enable row level security;

drop policy if exists drive_file_open_select on public.drive_file_open;
create policy drive_file_open_select on public.drive_file_open
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists drive_file_open_insert on public.drive_file_open;
create policy drive_file_open_insert on public.drive_file_open
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.drive_folder_member(workspace_id));

drop policy if exists drive_file_open_update on public.drive_file_open;
create policy drive_file_open_update on public.drive_file_open
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.drive_folder_member(workspace_id));

drop policy if exists drive_file_open_delete on public.drive_file_open;
create policy drive_file_open_delete on public.drive_file_open
  for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.drive_file_open from anon;
grant select, insert, update, delete on public.drive_file_open to authenticated, service_role;

-- ── E. Team chat files, newest first ────────────────────────────────────────

create index if not exists team_chat_message_files_idx
  on public.team_chat_message (workspace_id, created_at desc, id desc)
  where deleted_at is null and attachments <> '[]'::jsonb;

notify pgrst, 'reload schema';

commit;

-- ============================================================
-- 675: spreadsheets, a new kind of record.
-- ============================================================
-- Why: a spreadsheet is a workbook of sheets with free cells and Excel
-- formulas (docs/plans/spreadsheets.md). It is not a Table (520: rows under
-- typed columns), and it is not a document, so it gets tables of its own.
--
-- What lands, all of it new (no existing policy, function, constraint or
-- trigger is restated):
--   spreadsheet            one row a workbook. workbook is the engine's own
--                          saved form (IronCalc bytes, base64): inputs,
--                          formulas, formats, layout and sheets, never a
--                          calculated value. extras holds what the engine does
--                          not (charts, dropdowns, checkboxes, tables, view
--                          options). revision is a compare-and-swap counter, as
--                          document.revision is (364): a writer sends the
--                          revision it read, and the trigger moves it on.
--                          sheet_names and digest (the cells' text, cut short)
--                          are written by the app at each save, for lists and
--                          search; fts is generated from title and digest.
--                          visibility is document's (369): 'workspace' or
--                          'private' (only its maker). status 'archived' is
--                          the archive.
--   spreadsheet_revision   version history: the workbook as it became, one row
--                          a change, written only by the trigger. One person's
--                          saves within ten minutes fold into one row (364's
--                          rule for a human's autosave), so typing does not
--                          write a row a keystroke.
--   spreadsheet_comment    threads on cells: the app's comment table names its
--                          kinds in an enum and in policies that 674's test
--                          forbids adding to, and a thread here is anchored to
--                          a sheet and a cell, which a comment row cannot say.
--   spreadsheet_entity_visible_to + four RESTRICTIVE entity_link policies:
--                          a link with a spreadsheet at either end follows the
--                          spreadsheet's own read rule (673's pattern for teams
--                          and packages; 522's policies stay exactly as they
--                          are). Without them a private spreadsheet's links
--                          would be readable by every member, because
--                          entity_visible_to (664) lets an unknown kind through.
--
-- Not here, on purpose: per-person grants (entity_access, 492) and public
-- share links (029). Both need shared checks and functions restated.
--
-- No realtime publication: a row carries the whole workbook, and a save
-- would broadcast all of it to every reader.
--
-- Re-runnable. No transaction of its own (production applies a file with
-- psql --single-transaction). No backslashes anywhere in this file.
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ── A. The workbook ─────────────────────────────────────────────────────────

create table if not exists public.spreadsheet (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  title text not null default 'Untitled spreadsheet',
  created_by uuid references public.member(id) on delete set null,
  last_edited_by uuid references public.member(id) on delete set null,
  visibility text not null default 'workspace',
  status text not null default 'active',
  workbook text,
  extras jsonb not null default '{}'::jsonb,
  revision integer not null default 1,
  edit_source text not null default 'human',
  edit_summary text,
  sheet_names text[] not null default '{}'::text[],
  digest text not null default '',
  fts tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A')
    || setweight(to_tsvector('english', left(coalesce(digest, ''), 200000)), 'B')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint spreadsheet_visibility_check check (visibility in ('workspace', 'private')),
  constraint spreadsheet_status_check check (status in ('active', 'archived')),
  constraint spreadsheet_edit_source_check check (edit_source in ('human', 'agent', 'system')),
  constraint spreadsheet_title_length_check check (char_length(title) between 1 and 300),
  -- 24 MB of base64 is about 18 MB of workbook: far past any sheet a person
  -- types, and a ceiling on what one request can store.
  constraint spreadsheet_workbook_size_check check (workbook is null or octet_length(workbook) <= 25165824),
  constraint spreadsheet_digest_size_check check (octet_length(digest) <= 1048576)
);

create index if not exists spreadsheet_workspace_updated_idx
  on public.spreadsheet (workspace_id, updated_at desc) where status <> 'archived';
create index if not exists spreadsheet_private_creator_idx
  on public.spreadsheet (workspace_id, created_by) where visibility = 'private';
create index if not exists spreadsheet_fts_idx on public.spreadsheet using gin (fts);

-- ── B. Version history ──────────────────────────────────────────────────────

create table if not exists public.spreadsheet_revision (
  id uuid primary key default gen_random_uuid(),
  spreadsheet_id uuid not null references public.spreadsheet(id) on delete cascade,
  revision integer not null,
  title text not null,
  workbook text,
  extras jsonb not null default '{}'::jsonb,
  sheet_names text[] not null default '{}'::text[],
  author_id uuid references public.member(id) on delete set null,
  author_kind text not null default 'human',
  change_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint spreadsheet_revision_author_kind_check check (author_kind in ('human', 'agent', 'system'))
);

create index if not exists spreadsheet_revision_sheet_idx
  on public.spreadsheet_revision (spreadsheet_id, revision desc);

-- Before a write: move the revision on when the workbook, its extras or its
-- title changed, and stamp updated_at. A writer never sets revision itself:
-- it filters on the one it read (where revision = N), and a second writer
-- with the same N then matches no row.
create or replace function public.spreadsheet_before_write()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    new.revision := old.revision;
    if new.workbook is distinct from old.workbook
       or new.extras is distinct from old.extras
       or new.title is distinct from old.title then
      new.revision := old.revision + 1;
    end if;
    new.workspace_id := old.workspace_id;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists spreadsheet_before_write on public.spreadsheet;
create trigger spreadsheet_before_write
  before insert or update on public.spreadsheet
  for each row execute function public.spreadsheet_before_write();

-- After a write: keep the history. Definer, because no client may write
-- spreadsheet_revision (it has no insert policy).
create or replace function public.spreadsheet_track_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_last public.spreadsheet_revision%rowtype;
begin
  if tg_op = 'UPDATE' and new.revision = old.revision then
    return new;
  end if;

  select * into v_last
    from public.spreadsheet_revision r
   where r.spreadsheet_id = new.id
   order by r.revision desc
   limit 1;

  -- One person's run of saves is one entry in the history.
  if found
     and new.edit_source = 'human'
     and v_last.author_kind = 'human'
     and v_last.author_id is not distinct from new.last_edited_by
     and v_last.created_at > now() - interval '10 minutes'
     and tg_op = 'UPDATE' then
    update public.spreadsheet_revision
       set revision = new.revision,
           title = new.title,
           workbook = new.workbook,
           extras = new.extras,
           sheet_names = new.sheet_names,
           change_summary = new.edit_summary,
           updated_at = now()
     where id = v_last.id;
    return new;
  end if;

  insert into public.spreadsheet_revision
    (spreadsheet_id, revision, title, workbook, extras, sheet_names, author_id, author_kind, change_summary)
  values
    (new.id, new.revision, new.title, new.workbook, new.extras, new.sheet_names,
     coalesce(new.last_edited_by, new.created_by), new.edit_source, new.edit_summary);
  return new;
end;
$$;

revoke all on function public.spreadsheet_track_change() from public, anon, authenticated;

drop trigger if exists spreadsheet_track_change on public.spreadsheet;
create trigger spreadsheet_track_change
  after insert or update on public.spreadsheet
  for each row execute function public.spreadsheet_track_change();

-- ── C. Threads on cells ─────────────────────────────────────────────────────

create table if not exists public.spreadsheet_comment (
  id uuid primary key default gen_random_uuid(),
  spreadsheet_id uuid not null references public.spreadsheet(id) on delete cascade,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  -- A reply names the thread's first comment; the first comment names nothing.
  parent_id uuid references public.spreadsheet_comment(id) on delete cascade,
  -- Where the thread sits: the sheet's own id in the workbook, and its range
  -- in A1 form. The app moves the anchor when cells move.
  sheet_id integer,
  anchor text,
  body text not null,
  mentions jsonb not null default '[]'::jsonb,
  author_id uuid references public.member(id) on delete set null,
  resolved_at timestamptz,
  resolved_by uuid references public.member(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint spreadsheet_comment_body_check check (char_length(body) between 1 and 10000)
);

create index if not exists spreadsheet_comment_sheet_idx
  on public.spreadsheet_comment (spreadsheet_id, created_at);
create index if not exists spreadsheet_comment_parent_idx
  on public.spreadsheet_comment (parent_id) where parent_id is not null;

drop trigger if exists spreadsheet_comment_updated_at on public.spreadsheet_comment;
create trigger spreadsheet_comment_updated_at
  before update on public.spreadsheet_comment
  for each row execute function public.update_updated_at();

-- ── D. Who reads and writes ─────────────────────────────────────────────────

alter table public.spreadsheet enable row level security;
alter table public.spreadsheet_revision enable row level security;
alter table public.spreadsheet_comment enable row level security;

-- A member of the workspace reads a workspace spreadsheet; only its maker
-- reads a private one (document_select's first two arms, 493).
drop policy if exists spreadsheet_select on public.spreadsheet;
create policy spreadsheet_select on public.spreadsheet
  for select to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (visibility = 'workspace' or created_by = public.current_member_id(workspace_id))
  );

-- Made as oneself.
drop policy if exists spreadsheet_insert on public.spreadsheet;
create policy spreadsheet_insert on public.spreadsheet
  for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and created_by is not distinct from public.current_member_id(workspace_id)
    and created_by is not null
  );

-- Whoever reads it edits it. The row must still be one they could read
-- afterwards, so nobody makes another person's spreadsheet private.
drop policy if exists spreadsheet_update on public.spreadsheet;
create policy spreadsheet_update on public.spreadsheet
  for update to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (visibility = 'workspace' or created_by = public.current_member_id(workspace_id))
  )
  with check (
    public.is_workspace_member(workspace_id)
    and (visibility = 'workspace' or created_by = public.current_member_id(workspace_id))
  );

-- Its maker, or the workspace's owner or an admin (document_delete).
drop policy if exists spreadsheet_delete on public.spreadsheet;
create policy spreadsheet_delete on public.spreadsheet
  for delete to authenticated
  using (
    created_by = public.current_member_id(workspace_id)
    or (visibility = 'workspace' and public.get_member_role(workspace_id) in ('owner', 'admin'))
  );

-- The history is read by whoever reads the spreadsheet (the subquery runs
-- as the caller, under spreadsheet_select). Nobody writes it but the trigger.
drop policy if exists spreadsheet_revision_select on public.spreadsheet_revision;
create policy spreadsheet_revision_select on public.spreadsheet_revision
  for select to authenticated
  using (exists (select 1 from public.spreadsheet s where s.id = spreadsheet_revision.spreadsheet_id));

drop policy if exists spreadsheet_comment_select on public.spreadsheet_comment;
create policy spreadsheet_comment_select on public.spreadsheet_comment
  for select to authenticated
  using (exists (select 1 from public.spreadsheet s where s.id = spreadsheet_comment.spreadsheet_id));

-- A comment is written as the caller's own member of the spreadsheet's
-- workspace, on a spreadsheet they can read.
drop policy if exists spreadsheet_comment_insert on public.spreadsheet_comment;
create policy spreadsheet_comment_insert on public.spreadsheet_comment
  for insert to authenticated
  with check (
    author_id is not null
    and author_id = public.current_member_id(workspace_id)
    and exists (
      select 1 from public.spreadsheet s
       where s.id = spreadsheet_comment.spreadsheet_id
         and s.workspace_id = spreadsheet_comment.workspace_id
    )
  );

-- Anyone who reads the spreadsheet resolves a thread and moves its anchor;
-- the app's routes keep a comment's words to its author.
drop policy if exists spreadsheet_comment_update on public.spreadsheet_comment;
create policy spreadsheet_comment_update on public.spreadsheet_comment
  for update to authenticated
  using (exists (select 1 from public.spreadsheet s where s.id = spreadsheet_comment.spreadsheet_id))
  with check (exists (
    select 1 from public.spreadsheet s
     where s.id = spreadsheet_comment.spreadsheet_id
       and s.workspace_id = spreadsheet_comment.workspace_id
  ));

drop policy if exists spreadsheet_comment_delete on public.spreadsheet_comment;
create policy spreadsheet_comment_delete on public.spreadsheet_comment
  for delete to authenticated
  using (
    author_id = public.current_member_id(workspace_id)
    and exists (select 1 from public.spreadsheet s where s.id = spreadsheet_comment.spreadsheet_id)
  );

revoke all on table public.spreadsheet, public.spreadsheet_revision, public.spreadsheet_comment from anon;
revoke all on table public.spreadsheet_revision from authenticated;
grant select, insert, update, delete on table public.spreadsheet to authenticated;
grant select on table public.spreadsheet_revision to authenticated;
grant select, insert, update, delete on table public.spreadsheet_comment to authenticated;
grant all on table public.spreadsheet, public.spreadsheet_revision, public.spreadsheet_comment to service_role;

-- ── E. Links in the graph follow the spreadsheet's read rule ────────────────

-- One spreadsheet's read rule for an explicit user (as 673's
-- team_package_entity_visible_to is a team's). No user: no.
create or replace function public.spreadsheet_entity_visible_to(p_id uuid, p_workspace uuid, p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ws uuid;
  v_visibility text;
  v_creator uuid;
  v_member uuid;
begin
  if p_id is null or p_user is null then return false; end if;
  -- A signed-in caller asks only about themself.
  if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;

  select s.workspace_id, s.visibility, s.created_by into v_ws, v_visibility, v_creator
    from public.spreadsheet s where s.id = p_id;
  -- Gone, or not in the workspace asked about: not visible.
  if v_ws is null or (p_workspace is not null and v_ws <> p_workspace) then return false; end if;
  select m.id into v_member from public.member m where m.workspace_id = v_ws and m.user_id = p_user limit 1;
  if v_member is null then return false; end if;
  return v_visibility = 'workspace' or v_creator = v_member;
end;
$$;

comment on function public.spreadsheet_entity_visible_to(uuid, uuid, uuid) is
  'A spreadsheet''s read rule for one user (675): what the restrictive entity_link policies beside it ask.';

revoke all on function public.spreadsheet_entity_visible_to(uuid, uuid, uuid) from public, anon;
grant execute on function public.spreadsheet_entity_visible_to(uuid, uuid, uuid) to authenticated, service_role;

-- RESTRICTIVE, beside 522's entity_link policies and 673's: a row must pass
-- those AND these.
drop policy if exists entity_link_spreadsheet_select on public.entity_link;
create policy entity_link_spreadsheet_select on public.entity_link
  as restrictive
  for select
  using (
    (source_type <> 'spreadsheet'
     or public.spreadsheet_entity_visible_to(source_id, workspace_id, (select auth.uid())))
    and (target_type <> 'spreadsheet'
     or public.spreadsheet_entity_visible_to(target_id, workspace_id, (select auth.uid())))
  );

drop policy if exists entity_link_spreadsheet_insert on public.entity_link;
create policy entity_link_spreadsheet_insert on public.entity_link
  as restrictive
  for insert
  with check (
    (source_type <> 'spreadsheet'
     or public.spreadsheet_entity_visible_to(source_id, workspace_id, (select auth.uid())))
    and (target_type <> 'spreadsheet'
     or public.spreadsheet_entity_visible_to(target_id, workspace_id, (select auth.uid())))
  );

drop policy if exists entity_link_spreadsheet_update on public.entity_link;
create policy entity_link_spreadsheet_update on public.entity_link
  as restrictive
  for update
  using (
    (source_type <> 'spreadsheet'
     or public.spreadsheet_entity_visible_to(source_id, workspace_id, (select auth.uid())))
    and (target_type <> 'spreadsheet'
     or public.spreadsheet_entity_visible_to(target_id, workspace_id, (select auth.uid())))
  )
  with check (
    (source_type <> 'spreadsheet'
     or public.spreadsheet_entity_visible_to(source_id, workspace_id, (select auth.uid())))
    and (target_type <> 'spreadsheet'
     or public.spreadsheet_entity_visible_to(target_id, workspace_id, (select auth.uid())))
  );

drop policy if exists entity_link_spreadsheet_delete on public.entity_link;
create policy entity_link_spreadsheet_delete on public.entity_link
  as restrictive
  for delete
  using (
    (source_type <> 'spreadsheet'
     or public.spreadsheet_entity_visible_to(source_id, workspace_id, (select auth.uid())))
    and (target_type <> 'spreadsheet'
     or public.spreadsheet_entity_visible_to(target_id, workspace_id, (select auth.uid())))
  );

notify pgrst, 'reload schema';

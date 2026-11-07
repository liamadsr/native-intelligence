-- ============================================================
-- 364: every document change is versioned, and writes can't overwrite
-- something newer (documents phase 1, items 1 and 2;
-- docs/plans/documents-as-ground-truth.md).
-- ============================================================
-- Until now:
--   * every write was a blind update by id, so two edits at once silently
--     lost one (an agent's edit could be undone by the editor's next
--     autosave of an older copy);
--   * document_revision was written only on publish and before an agent
--     overwrote the product doc or a prep. PROD had 1 revision ever.
--
-- This adds:
--   document.revision      a counter that goes up by one on every change to
--                          the body or the title. A writer names the revision
--                          it read (update ... where revision = <read>): if
--                          the document moved on, 0 rows change and the
--                          writer reports "changed since you read it". The
--                          trigger sets it, so a writer that doesn't use it
--                          still bumps it and is still caught by those that do.
--   document.edit_source   write-only: who this write is for, 'human',
--   document.edit_summary  'agent' or 'system', and a one-line summary. The
--                          trigger reads them into the history row and clears
--                          them, so they are always null at rest and a writer
--                          that doesn't set them is recorded as 'system'.
--                          A signed-in caller (auth.uid() set: the app's
--                          session client, or PostgREST directly) can't file
--                          a change as an agent or as someone else: it is
--                          recorded as 'human', by their own member row. A
--                          'system' write that doesn't name a new editor
--                          (last_edited_by unchanged) records no author,
--                          rather than the previous editor's.
--   document_revision      one row per change, holding the document AS IT
--                          became, numbered by the document's revision. The
--                          latest row's number always equals document.revision.
--     .author_kind         'human', 'agent' or 'system' (null: a baseline).
--     .updated_at          when the row last took a change (see coalescing).
--   document_draft.base_revision
--                          the document revision a draft started from, so
--                          publishing a draft older than the document refuses
--                          or asks (the app checks it).
--
-- The trigger (BEFORE INSERT OR UPDATE, SECURITY DEFINER so it can write
-- history past RLS on any client):
--   * insert: revision 1, no history row (a document's first state is its
--     creation; the first change keeps it, below).
--   * update, body and title unchanged: revision kept, nothing written.
--   * update that changes the body or the title:
--       - revision := the next number;
--       - if the state being replaced isn't in history (a document from
--         before 364, or one only ever written at insert), it is kept first
--         as a baseline row, so the change can be undone;
--       - a human autosave (a save with no summary; a publish or a restore
--         carries one) by the same person within 10 minutes of their last
--         history row, with nothing else in between, folds into that row (at
--         most one row per 10 minutes per person); any other change is a new
--         row.
--
-- History is written only by the trigger now: the member INSERT policy on
-- document_revision (110) is dropped, so a client can't forge it. Restoring
-- a revision is an ordinary write of that revision's title and body.
--
-- Rollout: DEV, then PROD BEFORE the app PR merges (the app sends
-- edit_source / edit_summary and reads revision). Old app on this schema:
-- its writes still bump revision and are recorded as 'system'; its publish
-- route's own revision insert is refused by RLS (it already treats that as
-- an error), so apply it with the app.
--
-- Idempotent. No backslash anywhere in this file (the MCP apply tool decodes them).

-- ------------------------------------------------------------
-- 1. Columns
-- ------------------------------------------------------------

alter table public.document
  add column if not exists revision integer not null default 1,
  add column if not exists edit_source text,
  add column if not exists edit_summary text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'document_edit_source_check') then
    alter table public.document
      add constraint document_edit_source_check
      check (edit_source is null or edit_source in ('human', 'agent', 'system'));
  end if;
end $$;

alter table public.document_revision
  add column if not exists author_kind text,
  add column if not exists updated_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'document_revision_author_kind_check') then
    alter table public.document_revision
      add constraint document_revision_author_kind_check
      check (author_kind is null or author_kind in ('human', 'agent', 'system'));
  end if;
end $$;

update public.document_revision set updated_at = created_at where updated_at is null;
alter table public.document_revision alter column updated_at set default now();

alter table public.document_draft
  add column if not exists base_revision integer;

-- A document with older history rows (written before 364 as "the state
-- before this publish") starts past them, so its current state is kept as a
-- baseline by its next change instead of colliding with a number in use.
update public.document d
   set revision = r.max_rev + 1
  from (
    select document_id, max(revision_number) as max_rev
      from public.document_revision
     group by document_id
  ) r
 where r.document_id = d.id
   and d.revision <= r.max_rev;

-- ------------------------------------------------------------
-- 2. The change trigger
-- ------------------------------------------------------------

create or replace function public.document_track_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source    text;
  v_summary   text;
  v_author    uuid;
  v_latest_id uuid;
  v_latest_no integer;
  v_latest_kind text;
  v_latest_author uuid;
  v_latest_at timestamptz;
  v_coalesce  boolean := false;
begin
  if tg_op = 'INSERT' then
    new.revision := 1;
    new.edit_source := null;
    new.edit_summary := null;
    return new;
  end if;

  v_source := new.edit_source;
  v_summary := nullif(btrim(coalesce(new.edit_summary, '')), '');
  new.edit_source := null;
  new.edit_summary := null;

  if new.content is not distinct from old.content and new.title is not distinct from old.title then
    -- Not a change to the text: the revision is the trigger's to set.
    new.revision := old.revision;
    return new;
  end if;

  if auth.uid() is not null then
    -- A signed-in caller writes as themselves: a human edit, by their own
    -- member row, whatever edit_source and last_edited_by they sent.
    v_source := 'human';
    v_author := public.current_member_id(new.workspace_id);
    new.last_edited_by := v_author;
  elsif coalesce(v_source, 'system') = 'system' and new.last_edited_by is not distinct from old.last_edited_by then
    -- A server write that names no new editor has no author (not the last one's).
    v_author := null;
  else
    v_author := new.last_edited_by;
  end if;

  select r.id, r.revision_number, r.author_kind, r.author_id, r.created_at
    into v_latest_id, v_latest_no, v_latest_kind, v_latest_author, v_latest_at
    from public.document_revision r
   where r.document_id = old.id
   order by r.revision_number desc
   limit 1;

  new.revision := greatest(old.revision, coalesce(v_latest_no, 0)) + 1;

  if v_latest_id is null or v_latest_no <> old.revision then
    -- The state being replaced isn't in history yet: keep it as a baseline,
    -- so this change can be undone. An empty untitled body has nothing to
    -- go back to.
    if coalesce(old.content, '') <> '' or coalesce(old.title, '') <> '' then
      insert into public.document_revision (
        document_id, workspace_id, revision_number, title, content, content_json,
        frontmatter, tags, author_id, author_kind, change_summary, created_at, updated_at
      ) values (
        old.id, old.workspace_id, old.revision, old.title, old.content, old.content_json,
        old.frontmatter, old.tags, coalesce(old.last_edited_by, old.created_by), null, null,
        old.updated_at, old.updated_at
      )
      on conflict (document_id, revision_number) do nothing;
    end if;
  else
    -- The latest row is the state being replaced: a human autosave by the
    -- same person within 10 minutes of that row folds into it.
    v_coalesce := v_source = 'human'
      and v_author is not null
      and v_latest_kind = 'human'
      and v_latest_author = v_author
      and v_summary is null
      and v_latest_at > now() - interval '10 minutes';
  end if;

  if v_coalesce then
    update public.document_revision
       set revision_number = new.revision,
           title = new.title,
           content = new.content,
           content_json = new.content_json,
           frontmatter = new.frontmatter,
           tags = new.tags,
           change_summary = coalesce(v_summary, change_summary),
           updated_at = now()
     where id = v_latest_id;
  else
    insert into public.document_revision (
      document_id, workspace_id, revision_number, title, content, content_json,
      frontmatter, tags, author_id, author_kind, change_summary, created_at, updated_at
    ) values (
      new.id, new.workspace_id, new.revision, new.title, new.content, new.content_json,
      new.frontmatter, new.tags, v_author, coalesce(v_source, 'system'), v_summary,
      now(), now()
    );
  end if;

  return new;
end
$$;
revoke execute on function public.document_track_change() from public, anon, authenticated;

drop trigger if exists document_track_change on public.document;
create trigger document_track_change
  before insert or update on public.document
  for each row
  execute function public.document_track_change();

-- ------------------------------------------------------------
-- 3. History is the trigger's alone
-- ------------------------------------------------------------

drop policy if exists "Workspace members can write document revisions" on public.document_revision;

-- The history list reads newest first per document; 110's index covers it.

-- ============================================================
-- 376: what a section edit was, kept on its revision, and one log line
-- for it (canon documents D2; documents-as-ground-truth.md §3.3-3.4,
-- eve-alignment.md §6 decision 16).
-- ============================================================
-- Decision 16: an agent's edit to a canon document applies at once, lands in
-- the document's history with who made it and its sources, shows as one line
-- in the daily digest, and can be undone, the whole document or JUST THAT
-- EDIT. This adds:
--
--   document.edit_meta            write-only, like edit_source/edit_summary
--   document_revision.edit_meta   (364): the trigger reads it into the
--                                 history row and clears it, so it is always
--                                 null at rest. One JSON object (at most
--                                 8 KB, anything else is dropped):
--                                   { section, op, reason, sources[],
--                                     reverts?, held? }
--                                 the section the edit touched (its heading
--                                 path), what it did (replace / append /
--                                 remove / revert), why, and what it came
--                                 from (a call, a chat, a doc, a claim,
--                                 shipped work, an email, a web page). What
--                                 "revert just this edit" reads back
--                                 (src/lib/documents/canon-edit.ts).
--                                 A signed-in caller (auth.uid() set) can't
--                                 file one: its write is a person's, as 364
--                                 records it. An edit carrying edit_meta never
--                                 folds into a person's autosave row.
--   agent_log kind 'doc_updated'  the digest line ("Dial8 updated
--                                 Positioning in the product doc",
--                                 src/lib/log/agent-log.ts).
--
-- The trigger is 364's document_track_change, redefined whole with the three
-- edit_meta lines; everything else is 364's, unchanged.
--
-- Rollout: DEV, then PROD BEFORE the app PR merges (the app writes
-- edit_meta and logs 'doc_updated'). Idempotent. No backslash anywhere in
-- this file (the MCP apply tool decodes them).

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. Columns
-- ------------------------------------------------------------

alter table public.document
  add column if not exists edit_meta jsonb;

alter table public.document_revision
  add column if not exists edit_meta jsonb;

comment on column public.document_revision.edit_meta is
  'What a section edit was (376): { section, op, reason, sources[], reverts?, held? }. Written by document_track_change from document.edit_meta; null for a person''s edit.';

-- ------------------------------------------------------------
-- 2. The change trigger (364's, with edit_meta)
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
  v_meta      jsonb;
begin
  if tg_op = 'INSERT' then
    new.revision := 1;
    new.edit_source := null;
    new.edit_summary := null;
    new.edit_meta := null;
    return new;
  end if;

  v_source := new.edit_source;
  v_summary := nullif(btrim(coalesce(new.edit_summary, '')), '');
  -- What a section edit was (376): only an object, at most 8 KB, else nothing.
  v_meta := case
    when jsonb_typeof(new.edit_meta) = 'object' and octet_length(new.edit_meta::text) <= 8192 then new.edit_meta
    else null
  end;
  new.edit_source := null;
  new.edit_summary := null;
  new.edit_meta := null;

  if new.content is not distinct from old.content and new.title is not distinct from old.title then
    -- Not a change to the text: the revision is the trigger's to set.
    new.revision := old.revision;
    return new;
  end if;

  if auth.uid() is not null then
    -- A signed-in caller writes as themselves: a human edit, by their own
    -- member row, whatever edit_source and last_edited_by they sent.
    v_source := 'human';
    v_meta := null;
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
      and v_meta is null
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
      frontmatter, tags, author_id, author_kind, change_summary, edit_meta, created_at, updated_at
    ) values (
      new.id, new.workspace_id, new.revision, new.title, new.content, new.content_json,
      new.frontmatter, new.tags, v_author, coalesce(v_source, 'system'), v_summary, v_meta,
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
-- 3. The digest line's kind
-- ------------------------------------------------------------

alter table public.agent_log drop constraint if exists agent_log_kind_check;
alter table public.agent_log
  add constraint agent_log_kind_check
  check (kind in ('work_started', 'work_waiting', 'work_finished', 'work_failed', 'work_canceled', 'capture_processed', 'chat_checkpoint', 'doc_updated'));

-- ============================================================
-- 440: the Now file, the main agent's sketchpad (Slice 1;
-- docs/plans/now-file.md "Where it lives").
-- ============================================================
-- One short private document per person per workspace that the main chat
-- agent keeps as its running notes on what's going on (Focus, In flight,
-- Waiting on you, Waiting on others, Coming up, Keep in mind). It is an
-- ordinary private document ("Only me", 369), so revisions, Restore and the
-- editor come free. The server marks it with frontmatter.now (the stamp, like
-- meeting_prep's), and only update_now changes it
-- (src/lib/now/now-file.ts).
--
--   document.kind          gains 'now' (frontmatter ? 'now'), after 'prep'
--                          and before 'report' (skill_id is no stamp a
--                          client is kept from writing, so it must not turn
--                          a Now file into a report), so the note is out of the Docs view
--                          and list_documents' default with no code change.
--                          The stored generated column (367) is changed in
--                          place: Postgres 17 (DEV and PROD) has
--                          ALTER COLUMN ... SET EXPRESSION, which rewrites
--                          the column and rebuilds idx_document_workspace_kind
--                          (367) itself. No view or function names kind.
--   one per person         a partial unique index on (workspace_id,
--                          created_by) for a Now file that isn't archived:
--                          deleting the note (an archive) lets update_now
--                          start a fresh one. update_now retries on 23505,
--                          as canon-create.ts does.
--   always private         document_visibility_guard (379's body) also
--                          refuses a Now file that isn't private or that has
--                          a canon_key (P0016). Canon can't be private (369,
--                          P0014), and personal canon shows to teammates.
--   the stamp is server's  359's update guard and insert policy treat 'now'
--                          exactly as they treat 'meeting_prep': no client
--                          write sets, changes or drops it, and no client
--                          insert carries one. The guard now also compares
--                          whether each key is there (? key), for both
--                          stamps: an array frontmatter ('["now"]') passes
--                          ? 'now' while -> 'now' reads NULL. The app keeps the stored stamp
--                          on a client frontmatter write
--                          (prep-ref.ts withServerFrontmatter).
--   agent writes coalesce  document_track_change (376's body): an agent write
--                          to a Now file within 10 minutes of the agent row it
--                          replaces folds into that row, but only when both
--                          carry the same edit_meta.writer ('chat' today,
--                          'check_in' from Slice 2) for the same person, so an
--                          attended edit never folds into an unattended one.
--                          Unlike a person's autosave, a summary doesn't stop
--                          it (update_now always sends one); the folded row
--                          keeps the last summary. The window counts from the
--                          row's created_at, so a chain never spans more than
--                          10 minutes, and a person's edit in between always
--                          starts a new row.
--
-- Both triggers test new.frontmatter ? 'now', never new.kind: they are
-- BEFORE triggers, and a stored generated column isn't computed yet there.
--
-- Before applying, check nothing is stamped already (expect 0):
--   select count(*) from public.document where frontmatter ? 'now';
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word,
-- BEFORE the app ships: update_now reads and writes kind 'now'.
--
-- Safe to run twice. No backslash anywhere in this file (the MCP apply tool
-- decodes them). The column change rewrites document and takes an ACCESS
-- EXCLUSIVE lock: it waits at most 5 seconds for one rather than queue every
-- document read behind a long transaction (retry the apply if it times out).

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. kind gains 'now' (367's expression, plus the Now file before 'report')
-- ------------------------------------------------------------

alter table public.document
  alter column kind set expression as (
    case
      when frontmatter ? 'meeting_prep' then 'prep'
      when frontmatter ? 'now' then 'now'
      when frontmatter ? 'skill_id' then 'report'
      else 'doc'
    end
  );

-- ------------------------------------------------------------
-- 2. One per person per workspace
-- ------------------------------------------------------------

create unique index if not exists document_now_one_per_member_idx
  on public.document (workspace_id, created_by)
  where kind = 'now' and status <> 'archived';

-- ------------------------------------------------------------
-- 3. It stays private (379's guard, plus the Now file)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.document_visibility_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF new.visibility = 'private' THEN
    -- A private document needs its creator, except one that was already
    -- private and has lost its creator (their member row was removed).
    IF new.created_by IS NULL
       AND NOT (tg_op = 'UPDATE' AND old.visibility = 'private') THEN
      RAISE EXCEPTION 'a private document needs its creator' USING ERRCODE = 'P0015';
    END IF;
    IF private.is_system_document(new.workspace_id, new.id, new.canon_key) THEN
      RAISE EXCEPTION 'this is a system document: it can''t be private' USING ERRCODE = 'P0014';
    END IF;
  END IF;

  -- A Now file (440) is its creator's alone: always private, never canon.
  IF coalesce(new.frontmatter, '{}'::jsonb) ? 'now' THEN
    IF new.visibility IS DISTINCT FROM 'private' THEN
      RAISE EXCEPTION 'a Now file is always private' USING ERRCODE = 'P0016';
    END IF;
    IF new.canon_key IS NOT NULL THEN
      RAISE EXCEPTION 'a Now file is never a canon document' USING ERRCODE = 'P0016';
    END IF;
  END IF;

  -- From a client, only its creator says who can see a document.
  IF tg_op = 'UPDATE'
     AND new.visibility IS DISTINCT FROM old.visibility
     AND current_user IN ('authenticated', 'anon')
     AND (old.created_by IS NULL OR old.created_by IS DISTINCT FROM public.current_member_id(old.workspace_id)) THEN
    RAISE EXCEPTION 'only its creator can change who can see a document' USING ERRCODE = '42501';
  END IF;

  RETURN new;
END
$$;
REVOKE EXECUTE ON FUNCTION public.document_visibility_guard() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS document_visibility_guard ON public.document;
CREATE TRIGGER document_visibility_guard
  BEFORE INSERT OR UPDATE ON public.document
  FOR EACH ROW
  EXECUTE FUNCTION public.document_visibility_guard();

-- ------------------------------------------------------------
-- 4. The stamp is the server's (359's guard and insert policy, plus 'now')
-- ------------------------------------------------------------

drop policy if exists document_insert on public.document;
create policy document_insert
  on public.document for insert
  to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and created_by is not distinct from public.current_member_id(workspace_id)
    and not (coalesce(frontmatter, '{}'::jsonb) ? 'meeting_prep')
    and not (coalesce(frontmatter, '{}'::jsonb) ? 'now')
  );

create or replace function public.document_guard_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_role   text;
  v_member uuid;
begin
  -- The service role, postgres and SECURITY DEFINER functions (move_document,
  -- delete_document_with_knowledge, the workspace-move engine) are server
  -- paths with their own gates.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id then
    raise exception 'a document changes workspace only through move_document' using errcode = '42501';
  end if;

  -- The stamp's value, and whether the key is there at all (440): kind tests
  -- frontmatter ? key, which an array or string frontmatter can also pass
  -- while frontmatter -> key reads NULL.
  if (new.frontmatter -> 'meeting_prep') is distinct from (old.frontmatter -> 'meeting_prep')
     or (coalesce(new.frontmatter, '{}'::jsonb) ? 'meeting_prep') is distinct from (coalesce(old.frontmatter, '{}'::jsonb) ? 'meeting_prep') then
    raise exception 'a meeting prep stamp is written by the server only' using errcode = '42501';
  end if;

  -- The Now file's stamp (440), the same way.
  if (new.frontmatter -> 'now') is distinct from (old.frontmatter -> 'now')
     or (coalesce(new.frontmatter, '{}'::jsonb) ? 'now') is distinct from (coalesce(old.frontmatter, '{}'::jsonb) ? 'now') then
    raise exception 'a Now file stamp is written by the server only' using errcode = '42501';
  end if;

  v_role := public.get_member_role(old.workspace_id);
  if v_role in ('owner', 'admin') then
    return new;
  end if;

  if new.created_by is distinct from old.created_by then
    raise exception 'only an owner or admin can change who created a document' using errcode = '42501';
  end if;

  v_member := public.current_member_id(old.workspace_id);
  if old.created_by is not null and old.created_by = v_member then
    return new;
  end if;

  if new.status is distinct from old.status
     or new.published_status is distinct from old.published_status
     or new.slug is distinct from old.slug
     or new.type is distinct from old.type then
    raise exception 'only the creator or an admin can archive, unpublish, rename the slug of or retype a shared page' using errcode = '42501';
  end if;

  return new;
end
$$;
revoke execute on function public.document_guard_update() from public, anon, authenticated;

drop trigger if exists document_guard_update on public.document;
create trigger document_guard_update
  before update on public.document
  for each row
  execute function public.document_guard_update();

-- ------------------------------------------------------------
-- 5. Agent writes to a Now file coalesce (376's trigger, plus the branch)
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
  v_latest_meta jsonb;
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

  select r.id, r.revision_number, r.author_kind, r.author_id, r.created_at, r.edit_meta
    into v_latest_id, v_latest_no, v_latest_kind, v_latest_author, v_latest_at, v_latest_meta
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
    -- A Now file (440): an agent write folds into the agent row it replaces,
    -- from the same writer (edit_meta.writer) for the same person, within 10
    -- minutes of that row's created_at. A summary doesn't stop it.
    if not coalesce(v_coalesce, false)
       and coalesce(new.frontmatter, '{}'::jsonb) ? 'now'
       and v_source = 'agent'
       and v_author is not null
       and v_latest_kind = 'agent'
       and v_latest_author = v_author
       and nullif(v_meta ->> 'writer', '') is not null
       and (v_meta ->> 'writer') = (v_latest_meta ->> 'writer')
       and v_latest_at > now() - interval '10 minutes' then
      v_coalesce := true;
    end if;
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
           edit_meta = coalesce(v_meta, edit_meta),
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

-- Verify:
--   select pg_get_expr(adbin, adrelid) from pg_attrdef d
--     join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
--    where d.adrelid = 'public.document'::regclass and a.attname = 'kind';
--   -- expect the case to name 'now'
--   select indexdef from pg_indexes where indexname = 'document_now_one_per_member_idx';

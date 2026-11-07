-- ============================================================
-- 359: who may change a document.
-- ============================================================
-- Security fix (audit 2026-10-18). Until now any workspace member could edit,
-- archive or hard-delete ANY document:
--   * the UPDATE policy (025, "Workspace members can update documents") was
--     USING is_workspace_member(workspace_id), with no WITH CHECK and no
--     column guard, so a member could rewrite anyone's page, archive it
--     (soft delete is an UPDATE), restamp created_by to themselves, add or
--     drop a meeting-prep stamp, or move a document into another workspace
--     they belong to by updating workspace_id (around move_document's gate);
--   * delete_document_with_knowledge (237) checked membership only, so the
--     DELETE policy's "creator or admin" rule was bypassed by the RPC.
-- The stakes: someone's meeting prep (frontmatter.meeting_prep) feeds their
-- pre-call brief and the live sidekick, and the workspace product doc
-- (workspace.settings.product_doc.document_id) is what the live agent states
-- product facts from on every call.
--
-- The rules (decided):
--   EDIT     owner or admin: yes.
--            the creator: yes, except the product doc (owner or admin only).
--            a plain member: only a SHARED WIKI PAGE (published, not a spec,
--            no meeting_prep stamp, not in a project, and a slug or a type
--            other than note).
--            guests: never. Spec pages (type spec) are machine-written:
--            owner or admin only. Project documents follow the creator rule.
--   DELETE   owner or admin; or the creator, except the product doc. This
--            covers the hard-delete RPC; the app archives (soft delete) under
--            the same rule.
--   INSERT   a member, created_by must be their own member row, and no
--            meeting_prep stamp (the server stamps preps on the service role).
--   GUARD    a BEFORE UPDATE trigger for client writes (current_user is
--            authenticated or anon; the service role, postgres and SECURITY
--            DEFINER functions such as move_document skip it): id and
--            workspace_id never change (moves go through move_document), the
--            meeting_prep stamp never changes, created_by changes only for an
--            owner or admin, and a non-admin who is not the creator cannot
--            change status, published_status, slug or type. auth.role() is NOT
--            used: inside a SECURITY DEFINER function it still says
--            authenticated, while current_user is the definer.
--
-- PROD on 2026-10-18: 147 owners, 1 admin, 0 plain members, 190 documents,
-- all type note, and 0 edits by a non-creator, so this breaks nobody today.
--
-- Rollout: applied to DEV and then PROD BEFORE the app PR merges. The app works
-- either way: its checks (src/lib/documents/access.ts) mirror these rules and
-- are additive, so old app on new policies and new app on old policies both
-- behave.
--
-- Idempotent: create or replace, drop policy if exists, drop trigger if exists.
-- No backslash anywhere in this file (the MCP apply tool decodes them).

-- ------------------------------------------------------------
-- 1. Helpers. All SECURITY DEFINER (they read member and workspace past RLS),
--    search_path pinned, callable by authenticated and service_role only.
-- ------------------------------------------------------------

-- The caller's member row in a workspace, or null.
create or replace function public.current_member_id(ws uuid)
returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select m.id
    from public.member m
   where m.workspace_id = ws
     and m.user_id = auth.uid()
   limit 1;
$$;
revoke execute on function public.current_member_id(uuid) from public, anon;
grant execute on function public.current_member_id(uuid) to authenticated, service_role;

-- Whether a document is the workspace product doc
-- (workspace.settings.product_doc.document_id, src/lib/workspace/product-doc.ts).
create or replace function public.is_product_doc(ws uuid, doc uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select (w.settings -> 'product_doc' ->> 'document_id') = doc::text
       from public.workspace w
      where w.id = ws),
    false
  );
$$;
revoke execute on function public.is_product_doc(uuid, uuid) from public, anon;
grant execute on function public.is_product_doc(uuid, uuid) to authenticated, service_role;

-- Whether the caller may edit a document with these values (the EDIT rule
-- above). Takes the row values so the UPDATE policy can check the row as it
-- is (USING) and as it would be (WITH CHECK).
create or replace function public.can_edit_document(
  p_id               uuid,
  p_workspace_id     uuid,
  p_created_by       uuid,
  p_type             text,
  p_slug             text,
  p_published_status text,
  p_frontmatter      jsonb,
  p_project_id       uuid
)
returns boolean
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_role   text;
  v_member uuid;
begin
  select m.role, m.id
    into v_role, v_member
    from public.member m
   where m.workspace_id = p_workspace_id
     and m.user_id = auth.uid()
   limit 1;

  -- Not a member, or a guest: never.
  if v_role is null or v_role not in ('owner', 'admin', 'member') then
    return false;
  end if;
  if v_role in ('owner', 'admin') then
    return true;
  end if;
  -- The product doc and machine-written spec pages: owner or admin only.
  if public.is_product_doc(p_workspace_id, p_id) then
    return false;
  end if;
  if coalesce(p_type, 'note') = 'spec' then
    return false;
  end if;
  -- The creator.
  if p_created_by is not null and p_created_by = v_member then
    return true;
  end if;
  -- A plain member: a shared wiki page only.
  return coalesce(p_published_status, '') = 'published'
     and not (coalesce(p_frontmatter, '{}'::jsonb) ? 'meeting_prep')
     and p_project_id is null
     and (p_slug is not null or coalesce(p_type, 'note') <> 'note');
end
$$;
revoke execute on function public.can_edit_document(uuid, uuid, uuid, text, text, text, jsonb, uuid) from public, anon;
grant execute on function public.can_edit_document(uuid, uuid, uuid, text, text, text, jsonb, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 2. Policies. SELECT (025, any member) is unchanged.
-- ------------------------------------------------------------

drop policy if exists "Workspace members can update documents" on public.document;
drop policy if exists document_update on public.document;
create policy document_update
  on public.document for update
  to authenticated
  using (public.can_edit_document(id, workspace_id, created_by, type, slug, published_status, frontmatter, project_id))
  with check (public.can_edit_document(id, workspace_id, created_by, type, slug, published_status, frontmatter, project_id));

drop policy if exists "Creator and admins can delete documents" on public.document;
drop policy if exists document_delete on public.document;
create policy document_delete
  on public.document for delete
  to authenticated
  using (
    public.get_member_role(workspace_id) in ('owner', 'admin')
    or (
      created_by is not null
      and created_by = public.current_member_id(workspace_id)
      and not public.is_product_doc(workspace_id, id)
    )
  );

drop policy if exists "Workspace members can create documents" on public.document;
drop policy if exists document_insert on public.document;
create policy document_insert
  on public.document for insert
  to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and created_by is not distinct from public.current_member_id(workspace_id)
    and not (coalesce(frontmatter, '{}'::jsonb) ? 'meeting_prep')
  );

-- ------------------------------------------------------------
-- 3. Column guard for client writes. SECURITY INVOKER on purpose: current_user
--    must be the caller's role, not a definer. The role and member lookups go
--    through the definer helpers, which do not change current_user here.
-- ------------------------------------------------------------

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

  if (new.frontmatter -> 'meeting_prep') is distinct from (old.frontmatter -> 'meeting_prep') then
    raise exception 'a meeting prep stamp is written by the server only' using errcode = '42501';
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
-- 4. delete_document_with_knowledge: 237's body plus the DELETE rule. Same
--    signature, grants and return shape. The requester is the explicit uid
--    (237's pattern), not auth.uid(), so sessionless server callers work.
-- ------------------------------------------------------------

create or replace function public.delete_document_with_knowledge(
  p_document_id  uuid,
  p_workspace_id uuid,
  p_user_id      uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_uid        uuid := public._resolve_requester(p_user_id);
  v_exists     boolean;
  v_created_by uuid;
  v_member     uuid;
  v_role       text;
  v_cleanup    jsonb;
begin
  if not public._is_member_of(v_uid, p_workspace_id) then
    raise exception 'not a member of workspace' using errcode = '42501';
  end if;

  select true, d.created_by into v_exists, v_created_by
    from public.document d
   where d.id = p_document_id and d.workspace_id = p_workspace_id
     for update;

  if v_exists is null then
    raise exception 'document not found' using errcode = 'P0002';
  end if;

  -- Owner or admin; or the creator, except the product doc.
  select m.id, m.role into v_member, v_role
    from public.member m
   where m.user_id = v_uid and m.workspace_id = p_workspace_id
   limit 1;

  if not (
    v_role in ('owner', 'admin')
    or (
      v_created_by is not null
      and v_created_by = v_member
      and not public.is_product_doc(p_workspace_id, p_document_id)
    )
  ) then
    raise exception 'only the creator or an admin can delete this document' using errcode = '42501';
  end if;

  v_cleanup := public._cleanup_claim_provenance(
    p_workspace_id,
    jsonb_build_array(jsonb_build_object('t', 'document', 'id', p_document_id))
  );

  delete from public.document
   where id = p_document_id and workspace_id = p_workspace_id;

  return jsonb_build_object(
    'document_id', p_document_id,
    'cleanup',     v_cleanup
  );
end
$$;
revoke execute on function public.delete_document_with_knowledge(uuid, uuid, uuid) from public, anon;
grant execute on function public.delete_document_with_knowledge(uuid, uuid, uuid) to authenticated, service_role;

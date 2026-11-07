-- ============================================================
-- 366: system documents can be edited, never deleted or archived
-- (documents phase 1, item 6; docs/plans/documents-as-ground-truth.md).
-- ============================================================
-- Liam, 2026-10-19: "those documents should not be deletable ... this is a
-- system document." A system document is one the workspace's agents are
-- grounded in:
--   * one with a canon_key (new here): the key the canon registry (D1) will
--     address it by, e.g. 'product', 'brand', 'team-playbook'. Unique per
--     workspace. Nothing sets it yet; D1 does;
--   * or the one the workspace product-doc pointer names
--     (workspace.settings.product_doc.document_id, is_product_doc, 359).
-- Editing still follows 359/360 (src/lib/documents/access.ts).
--
-- Enforced here for every caller, the service role and SECURITY DEFINER
-- functions included (delete_document_with_knowledge, the bulk route, the
-- agent tools): a BEFORE DELETE trigger refuses deleting one, and the BEFORE
-- UPDATE guard refuses archiving one, with SQLSTATE P0013 so the app can say
-- why. Deleting the whole workspace still works: by the time a cascade
-- reaches its documents the workspace row is gone, and then nothing is
-- refused. Only an owner or admin sets or clears a canon_key from a client
-- (a member could otherwise claim a key, or clear one to delete the doc).
--
-- Which documents are system documents is private.is_system_document: the
-- guards (invoker triggers) call it, and no member can call it over RPC to
-- probe another workspace's product doc (the private schema isn't exposed,
-- 341). public.is_system_document wraps it for the service role.
--
-- Rollout: DEV, then PROD BEFORE the app PR merges (the app reads
-- canon_key). Idempotent. No backslash anywhere in this file (the MCP apply
-- tool decodes them).

-- ------------------------------------------------------------
-- 1. The key
-- ------------------------------------------------------------

alter table public.document
  add column if not exists canon_key text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'document_canon_key_format') then
    alter table public.document
      add constraint document_canon_key_format
      check (canon_key is null or canon_key ~ '^[a-z0-9][a-z0-9:._-]{0,63}$');
  end if;
end $$;

create unique index if not exists document_workspace_canon_key_idx
  on public.document (workspace_id, canon_key)
  where canon_key is not null;

-- ------------------------------------------------------------
-- 2. Which documents are system documents
-- ------------------------------------------------------------

-- Only while the workspace exists: a workspace being deleted takes its
-- documents with it (the cascade reaches them after the workspace row is gone).
-- In the private schema (341: USAGE for authenticated and service_role, not
-- exposed over the API): the guards run as the caller and need it, an RPC
-- caller can't reach it.
create schema if not exists private;
create or replace function private.is_system_document(ws uuid, doc uuid, canon text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.workspace w where w.id = ws)
     and (canon is not null or public.is_product_doc(ws, doc));
$$;
revoke execute on function private.is_system_document(uuid, uuid, text) from public, anon;
grant execute on function private.is_system_document(uuid, uuid, text) to authenticated, service_role;

-- The same answer for the service role (and SQL); not callable by members.
create or replace function public.is_system_document(ws uuid, doc uuid, canon text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select private.is_system_document(ws, doc, canon);
$$;
revoke execute on function public.is_system_document(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.is_system_document(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- 3. The guard: no delete, no archive, the key is an admin's
-- ------------------------------------------------------------

create or replace function public.document_system_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if private.is_system_document(old.workspace_id, old.id, old.canon_key) then
      raise exception 'this is a system document: it can be edited, not deleted' using errcode = 'P0013';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE'
     and new.status = 'archived'
     and old.status is distinct from 'archived'
     and private.is_system_document(old.workspace_id, old.id, coalesce(old.canon_key, new.canon_key)) then
    raise exception 'this is a system document: it can be edited, not archived' using errcode = 'P0013';
  end if;

  -- From a client, only an owner or admin sets or clears the key.
  if current_user in ('authenticated', 'anon')
     and (case when tg_op = 'INSERT' then new.canon_key is not null else new.canon_key is distinct from old.canon_key end)
     and coalesce(public.get_member_role(new.workspace_id), '') not in ('owner', 'admin') then
    raise exception 'only an owner or admin can set which documents are system documents' using errcode = '42501';
  end if;

  return new;
end
$$;
revoke execute on function public.document_system_guard() from public, anon, authenticated;

drop trigger if exists document_system_guard on public.document;
create trigger document_system_guard
  before insert or update or delete on public.document
  for each row
  execute function public.document_system_guard();

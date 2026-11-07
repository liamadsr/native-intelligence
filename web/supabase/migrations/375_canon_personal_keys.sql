-- ============================================================
-- 375: personal canon keys, one per person (canon documents D1;
-- docs/plans/documents-as-ground-truth.md §3 and §5, eve-alignment.md §4).
-- ============================================================
-- A canon document is a document with a canon_key (366): the key every agent
-- addresses it by (the registry in each agent's prompt, read_canon). Two kinds:
--   workspace canon   product, team-playbook, ...: one per workspace, owned by
--                     its admins. 366's index already makes these unique.
--   personal canon    person:voice, content-brief:<channel>: one PER PERSON,
--                     owned by its creator. 366's index made the key unique per
--                     workspace, so only one member could ever have a
--                     content brief for x. This makes a personal key unique
--                     per (workspace, creator) instead.
-- A personal key is one that starts with 'person:' or 'content-brief:'
-- (src/lib/documents/canon.ts isPersonalCanonKey, pinned by test).
--
-- And when a member is removed (or leaves), their personal canon documents
-- stop being canon: the key is cleared before the member row goes, so each
-- becomes an ordinary document (deletable, archivable) rather than an
-- undeletable system document that belongs to nobody. Its text is kept.
--
-- And the guard (366): from a client, only an owner or admin sets or clears a
-- key. A member may now also set a PERSONAL key on a document they created
-- themselves (their own content brief, their own voice notes). Everything else
-- in the guard is 366's, unchanged: no delete and no archive of a system
-- document, for every caller.
--
-- Rollout: DEV, then PROD BEFORE the app PR merges (the app creates personal
-- canon docs). Idempotent. No backslash anywhere in this file (the MCP apply
-- tool decodes them).

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. Uniqueness: workspace keys per workspace, personal keys per person
-- ------------------------------------------------------------

drop index if exists public.document_workspace_canon_key_idx;

create unique index if not exists document_workspace_canon_key_shared_idx
  on public.document (workspace_id, canon_key)
  where canon_key is not null and canon_key !~ '^(person|content-brief):';

create unique index if not exists document_workspace_canon_key_personal_idx
  on public.document (workspace_id, created_by, canon_key)
  where canon_key ~ '^(person|content-brief):';

-- No CHECK that a personal key has a creator: document.created_by is SET NULL
-- when its member is removed (025), and such a CHECK would make removing that
-- member fail. Section 3 handles that case instead.
alter table public.document drop constraint if exists document_personal_canon_creator;

-- ------------------------------------------------------------
-- 2. The guard: a member sets a personal key on their own document
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

  -- From a client, only an owner or admin sets or clears the key; a member
  -- may set (never clear) a personal key on a document they created.
  if current_user in ('authenticated', 'anon')
     and (case when tg_op = 'INSERT' then new.canon_key is not null else new.canon_key is distinct from old.canon_key end)
     and coalesce(public.get_member_role(new.workspace_id), '') not in ('owner', 'admin')
     and not (
       new.canon_key is not null
       and new.canon_key ~ '^(person|content-brief):'
       and (tg_op = 'INSERT' or old.canon_key is null)
       and new.created_by is not null
       and new.created_by = public.current_member_id(new.workspace_id)
     ) then
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

-- ------------------------------------------------------------
-- 3. A removed member's personal canon becomes ordinary documents
-- ------------------------------------------------------------
-- BEFORE DELETE on member, so it runs before the FK sets created_by to null.
-- SECURITY DEFINER: the clearing UPDATE is the server's, so the client checks
-- in the document guards (366/375, 359) don't apply to it, whoever removed the
-- member.

create or replace function public.member_release_personal_canon()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.document
     set canon_key = null
   where workspace_id = old.workspace_id
     and created_by = old.id
     and canon_key ~ '^(person|content-brief):';
  return old;
end
$$;
revoke execute on function public.member_release_personal_canon() from public, anon, authenticated;

drop trigger if exists member_release_personal_canon on public.member;
create trigger member_release_personal_canon
  before delete on public.member
  for each row
  execute function public.member_release_personal_canon();

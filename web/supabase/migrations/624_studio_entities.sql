-- ============================================================
-- 624: Studio videos and Studio projects in the knowledge graph.
-- ============================================================
-- A Studio video (studio_video, 620) and a Studio project (studio_project)
-- can now be @-mentioned and linked like any other record: an entity_link
-- edge may end at one (team chat's record mentions, a task made about a
-- video, a script's document, the agent's link_entities). entity_link has no
-- CHECK on its kinds, so nothing there widens; what changes is who may read,
-- write, change or remove such an edge.
--
-- The Studio is every member's but a guest's (requireStudio,
-- src/lib/studio/server/auth.ts), and its tables are service-role only (620:
-- RLS on, no member policies). An edge to a Studio record follows that rule,
-- as an edge to a private document follows the document's (500, 501, 503).
--
-- WHY THIS FILE RE-CREATES NOTHING SHARED. entity_visible_to and the
-- entity_link SELECT and INSERT policies are shared by more than one branch
-- in flight: another one (Tables) adds its own kinds to them in migrations of
-- its own. Re-creating them here from an older migration's text would erase
-- whichever branch applied first, depending on the order. So this file adds
-- only objects of the Studio's own, and composes with the rest:
--
--   1. public.studio_entity_visible_to(type, id, workspace, user): the
--      Studio's read rule for one record. A video or Studio project not in
--      the trash (archived_at is null), in the workspace asked about, read
--      by a member of that workspace who is not a guest. No user (an
--      unattended run): nobody, as for the other private graph kinds. A
--      signed-in caller asks only about themself. Any other kind: false (it
--      is never asked about one: the policies below ask only for the
--      Studio's kinds).
--   2. Four RESTRICTIVE policies on entity_link (select, insert, update,
--      delete): an edge with a Studio end passes only when that end is
--      readable to the caller; every other edge passes. A restrictive policy
--      is ANDed with whatever permissive ones exist, so these hold whatever
--      the shared policies say now or later, in either order of applying,
--      and never touch them. UPDATE is covered both ways (USING the row as
--      it is, WITH CHECK the row it becomes): an edge can't be retargeted at
--      a Studio record the caller can't read.
--
-- The app's mirror is src/lib/knowledge/entity-fences.ts (PRIVATE_GRAPH_KINDS,
-- studioFence): every service-role reader of the graph fences a Studio end
-- there, never through entity_visible_to (which keeps answering "every
-- member's" for kinds it does not know). src/lib/knowledge/__tests__/
-- migration-624.test.ts pins this file. Not in scope (the entity registry
-- says so too): realtime, the activity log, custom fields, claims citing a
-- video, per-record sharing grants.
--
-- Additive: before this file no edge ends at a Studio kind, so every
-- existing row reads exactly as before. Idempotent (create or replace on the
-- Studio's own function, drop policy if exists on its own policies). Safe on
-- a live database with the deployed app running. Apply after 620 (the
-- Studio's tables) and before the app code that writes Studio mentions is
-- rolled out. No backslashes anywhere in this file (one MCP transport decodes
-- escapes).
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. studio_entity_visible_to
-- ------------------------------------------------------------

create or replace function public.studio_entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ws uuid;
begin
  if p_id is null or p_user is null then return false; end if;
  -- A signed-in caller asks only about themself.
  if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;

  if p_type = 'studio_video' then
    select sv.workspace_id into v_ws from public.studio_video sv where sv.id = p_id and sv.archived_at is null;
  elsif p_type = 'studio_project' then
    select sp.workspace_id into v_ws from public.studio_project sp where sp.id = p_id and sp.archived_at is null;
  else
    return false;
  end if;

  -- Gone, in the trash, or not in the workspace asked about: not visible.
  if v_ws is null or (p_workspace is not null and v_ws <> p_workspace) then return false; end if;

  -- A member of its workspace who is not a guest.
  return exists (
    select 1 from public.member m
     where m.workspace_id = v_ws and m.user_id = p_user and m.role is distinct from 'guest'
  );
end;
$$;

comment on function public.studio_entity_visible_to(text, uuid, uuid, uuid) is
  'The Studio''s read rule for one record (624): a video or Studio project not in the trash, read by a member of its workspace who is not a guest.';

revoke all on function public.studio_entity_visible_to(text, uuid, uuid, uuid) from public, anon;
grant execute on function public.studio_entity_visible_to(text, uuid, uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 2. entity_link: an edge with a Studio end follows the Studio's rule
-- ------------------------------------------------------------

drop policy if exists entity_link_studio_select on public.entity_link;
create policy entity_link_studio_select on public.entity_link
  as restrictive
  for select
  using (
    (source_type not in ('studio_video', 'studio_project')
     or public.studio_entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type not in ('studio_video', 'studio_project')
     or public.studio_entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

drop policy if exists entity_link_studio_insert on public.entity_link;
create policy entity_link_studio_insert on public.entity_link
  as restrictive
  for insert
  with check (
    (source_type not in ('studio_video', 'studio_project')
     or public.studio_entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type not in ('studio_video', 'studio_project')
     or public.studio_entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

drop policy if exists entity_link_studio_update on public.entity_link;
create policy entity_link_studio_update on public.entity_link
  as restrictive
  for update
  using (
    (source_type not in ('studio_video', 'studio_project')
     or public.studio_entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type not in ('studio_video', 'studio_project')
     or public.studio_entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  )
  with check (
    (source_type not in ('studio_video', 'studio_project')
     or public.studio_entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type not in ('studio_video', 'studio_project')
     or public.studio_entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

drop policy if exists entity_link_studio_delete on public.entity_link;
create policy entity_link_studio_delete on public.entity_link
  as restrictive
  for delete
  using (
    (source_type not in ('studio_video', 'studio_project')
     or public.studio_entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type not in ('studio_video', 'studio_project')
     or public.studio_entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

notify pgrst, 'reload schema';

commit;

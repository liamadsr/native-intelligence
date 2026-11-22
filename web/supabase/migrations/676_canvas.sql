-- ============================================================
-- 676: canvases (whiteboards) as a record, and their items.
-- ============================================================
-- A canvas is a record like a document (docs/plans/canvas.md, "The record"):
-- workspace-scoped, 'workspace' or 'private' visibility, an owner. Its items
-- are rows, one per shape/text/connector/card on the board, so two people's
-- edits to different items never collide and a save sends only what changed.
--
--   1. public.canvas: title, workspace, project, owner, creator, visibility,
--      saved settings, a `version` the API bumps once per write batch (never a
--      per-row trigger: a 2,000-row write would be 2,000 updates), archived_at.
--   2. public.canvas_item: one row per item (canvas_id, id), its parent (a
--      group), an order key, a kind (the kinds from CANVAS_ITEM_KINDS in
--      src/lib/canvas/types.ts) and a JSON body. No per-row version bump.
--   3. Access, in 520's shape (data_table_visible_to, my_data_table_ids):
--        canvas_visible_to(canvas, user)  a member of the canvas's workspace,
--            and the canvas is workspace-wide or theirs.
--        canvas_editable_by(canvas, user) the same, and not a guest.
--        my_canvas_ids()                  every canvas the caller may read, one
--                                         lookup per query (the select policies).
--      NO grant arm: per-person grants (entity_access) would need redefining
--      the shared entity_access functions, which is out of bounds here (see the
--      report in docs/plans/canvas.md). A private canvas is its owner's alone
--      until that lands. Reads and writes go through the caller's client under
--      RLS; the API bumps canvas.version once per batch (no SECURITY DEFINER
--      RPC, unlike 520's tables, because a canvas write is item upserts +
--      deletes, not a typed op log).
--   4. The graph. A canvas is linkable (attach to a project or an action; a
--      record card on a canvas writes a link both ways). entity_link has no
--      CHECK on its kinds, so nothing there widens. Who may read/write such an
--      edge is fenced by NEW restrictive policies beside 522's / 664's shared
--      ones (the way 624 fenced the Studio's edges and 673 teams'), asking a
--      new canvas_entity_visible_to. This file REDEFINES NO existing function
--      and NO existing policy, and widens NO existing CHECK: only new tables,
--      new functions and new (restrictive, or fresh) policies.
--   5. Realtime: canvas and canvas_item are published (REPLICA IDENTITY FULL),
--      guarded like 520. A batch bumps canvas.version (one event), and item
--      rows stream so a canvas's other viewers apply the changed items.
--
-- NOT done here (reported in docs/plans/canvas.md, each would need more):
--   * Comments (commentable_type enum, validate_commentable_exists): the enum
--     and the validator are existing objects a 'canvas' value would have to
--     redefine. Out of bounds.
--   * Public share links (share_shareable_type_check): widening that CHECK is a
--     change to an existing constraint on an existing table. Not in scope.
--   * Per-person grants (entity_access): entity_access_entity_type's CHECK and
--     entity_access_guard / entity_grant_only / entity_edit_grant_* would all
--     have to be redefined. Out of bounds; canvas visibility is workspace-or-
--     private only for now.
--
-- Additive. Idempotent / re-runnable. One transaction, lock_timeout 5s. No
-- backslashes anywhere in this file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. canvas
-- ------------------------------------------------------------

create table if not exists public.canvas (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  title text not null default 'Untitled canvas',
  project_id uuid null references public.projects(id) on delete set null,
  owner_member_id uuid null references public.member(id) on delete set null,
  created_by_user_id uuid null references auth.users(id) on delete set null,
  visibility text not null default 'workspace',
  settings jsonb not null default '{}'::jsonb,
  version bigint not null default 0,
  archived_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.canvas is
  'A whiteboard record (676): workspace or private, owned by a member, its items in canvas_item. version is bumped once by every write batch (the API, not a trigger).';
comment on column public.canvas.version is
  'Bumped once by every write batch (the API). One realtime event per batch tells a canvas''s other viewers to read the changed items.';

alter table public.canvas drop constraint if exists canvas_title_length;
alter table public.canvas
  add constraint canvas_title_length check (char_length(btrim(title)) between 1 and 200);
alter table public.canvas drop constraint if exists canvas_visibility_check;
alter table public.canvas
  add constraint canvas_visibility_check check (visibility in ('workspace', 'private'));
alter table public.canvas drop constraint if exists canvas_settings_object;
alter table public.canvas
  add constraint canvas_settings_object check (jsonb_typeof(settings) = 'object');
alter table public.canvas drop constraint if exists canvas_version_nonneg;
alter table public.canvas
  add constraint canvas_version_nonneg check (version >= 0);

create index if not exists canvas_workspace_idx on public.canvas (workspace_id, updated_at desc);
create index if not exists canvas_owner_idx on public.canvas (owner_member_id) where owner_member_id is not null;
create index if not exists canvas_project_idx on public.canvas (project_id) where project_id is not null;

-- ------------------------------------------------------------
-- 2. canvas_item
-- ------------------------------------------------------------

create table if not exists public.canvas_item (
  canvas_id uuid not null references public.canvas(id) on delete cascade,
  id text not null,
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  parent_id text null,
  sort_key text not null,
  kind text not null,
  data jsonb not null default '{}'::jsonb,
  updated_by uuid null references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (canvas_id, id)
);

comment on table public.canvas_item is
  'One item on a canvas (676): a shape, text, connector, image, record card, group (CANVAS_ITEM_KINDS). data is the item without id, parentId, sortKey and kind (src/lib/canvas/types.ts itemToRow).';

alter table public.canvas_item drop constraint if exists canvas_item_id_length;
alter table public.canvas_item
  add constraint canvas_item_id_length check (char_length(id) between 1 and 64);
alter table public.canvas_item drop constraint if exists canvas_item_sort_key_length;
alter table public.canvas_item
  add constraint canvas_item_sort_key_length check (char_length(sort_key) between 1 and 200);
alter table public.canvas_item drop constraint if exists canvas_item_data_object;
alter table public.canvas_item
  add constraint canvas_item_data_object check (jsonb_typeof(data) = 'object');
-- The kinds are exactly CANVAS_ITEM_KINDS (src/lib/canvas/types.ts); the
-- migration test pins the two equal.
alter table public.canvas_item drop constraint if exists canvas_item_kind_check;
alter table public.canvas_item
  add constraint canvas_item_kind_check
  check (kind in ('rectangle', 'ellipse', 'text', 'pencil', 'connector', 'image', 'video', 'record', 'artifact', 'group'));

create index if not exists canvas_item_canvas_idx on public.canvas_item (canvas_id);

-- ------------------------------------------------------------
-- 3. Who may read and write a canvas
-- ------------------------------------------------------------
-- 520's shape (data_table_visible_to, data_table_editable_by, my_data_table_ids)
-- without the grant arm. Each answers only for the caller themself, or for the
-- service role (auth.uid() is null).

create or replace function public.canvas_visible_to(p_canvas_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null
     and (auth.uid() is null or auth.uid() = p_user_id)
     and exists (
       select 1
         from public.canvas c
         join public.member m on m.workspace_id = c.workspace_id and m.user_id = p_user_id
        where c.id = p_canvas_id
          and (c.visibility = 'workspace'
               or (c.owner_member_id is not null and c.owner_member_id = m.id))
     );
$$;

create or replace function public.canvas_editable_by(p_canvas_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null
     and (auth.uid() is null or auth.uid() = p_user_id)
     and exists (
       select 1
         from public.canvas c
         join public.member m on m.workspace_id = c.workspace_id and m.user_id = p_user_id
        where c.id = p_canvas_id
          and m.role <> 'guest'
          and (c.visibility = 'workspace'
               or (c.owner_member_id is not null and c.owner_member_id = m.id))
     );
$$;

-- Every canvas the caller may read, in every workspace they are in: the select
-- policies' one lookup per query (an InitPlan). No grant arm (see the header).
create or replace function public.my_canvas_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (
    select m.id, m.workspace_id from public.member m where m.user_id = auth.uid()
  )
  select coalesce(array_agg(c.id), '{}'::uuid[])
    from public.canvas c
    join me on me.workspace_id = c.workspace_id
   where c.visibility = 'workspace'
      or c.owner_member_id = me.id;
$$;

revoke all on function public.canvas_visible_to(uuid, uuid) from public, anon;
revoke all on function public.canvas_editable_by(uuid, uuid) from public, anon;
revoke all on function public.my_canvas_ids() from public, anon;
grant execute on function public.canvas_visible_to(uuid, uuid) to authenticated, service_role;
grant execute on function public.canvas_editable_by(uuid, uuid) to authenticated, service_role;
grant execute on function public.my_canvas_ids() to authenticated, service_role;

alter table public.canvas enable row level security;
alter table public.canvas_item enable row level security;

-- canvas: read what my_canvas_ids() allows; write only as an editor; create a
-- canvas you own in a workspace you are a non-guest member of; delete only as
-- the owner or a workspace owner/admin. Changing visibility is the owner's
-- call, enforced in the API (updateCanvas): a simple policy can't compare the
-- row's new visibility against the old one for the owner alone.
drop policy if exists canvas_select on public.canvas;
create policy canvas_select on public.canvas
  for select to authenticated
  using (id = any ((select public.my_canvas_ids())::uuid[]));

drop policy if exists canvas_insert on public.canvas;
create policy canvas_insert on public.canvas
  for insert to authenticated
  with check (
    exists (
      select 1 from public.member m
       where m.workspace_id = canvas.workspace_id
         and m.user_id = (select auth.uid())
         and m.role <> 'guest'
         and m.id = canvas.owner_member_id
    )
  );

drop policy if exists canvas_update on public.canvas;
create policy canvas_update on public.canvas
  for update to authenticated
  using (public.canvas_editable_by(id, (select auth.uid())))
  with check (public.canvas_editable_by(id, (select auth.uid())));

drop policy if exists canvas_delete on public.canvas;
create policy canvas_delete on public.canvas
  for delete to authenticated
  using (
    exists (
      select 1 from public.member m
       where m.workspace_id = canvas.workspace_id
         and m.user_id = (select auth.uid())
         and (m.id = canvas.owner_member_id or m.role in ('owner', 'admin'))
    )
  );

-- canvas_item: read with the canvas; write only as an editor of the canvas,
-- and the row's workspace must be the canvas's own.
drop policy if exists canvas_item_select on public.canvas_item;
create policy canvas_item_select on public.canvas_item
  for select to authenticated
  using (canvas_id = any ((select public.my_canvas_ids())::uuid[]));

drop policy if exists canvas_item_insert on public.canvas_item;
create policy canvas_item_insert on public.canvas_item
  for insert to authenticated
  with check (
    public.canvas_editable_by(canvas_id, (select auth.uid()))
    and exists (select 1 from public.canvas c where c.id = canvas_id and c.workspace_id = canvas_item.workspace_id)
  );

drop policy if exists canvas_item_update on public.canvas_item;
create policy canvas_item_update on public.canvas_item
  for update to authenticated
  using (public.canvas_editable_by(canvas_id, (select auth.uid())))
  with check (
    public.canvas_editable_by(canvas_id, (select auth.uid()))
    and exists (select 1 from public.canvas c where c.id = canvas_id and c.workspace_id = canvas_item.workspace_id)
  );

drop policy if exists canvas_item_delete on public.canvas_item;
create policy canvas_item_delete on public.canvas_item
  for delete to authenticated
  using (public.canvas_editable_by(canvas_id, (select auth.uid())));

revoke all on table public.canvas, public.canvas_item from anon, authenticated;
grant select, insert, update, delete on table public.canvas, public.canvas_item to authenticated;
grant all on table public.canvas, public.canvas_item to service_role;

-- ------------------------------------------------------------
-- 4. entity_link: an edge with a canvas end follows the canvas's rule
-- ------------------------------------------------------------
-- A NEW read-rule function and NEW restrictive policies, beside 522's /
-- 664's shared entity_link_select / entity_link_insert (left exactly as they
-- are): a row must pass those AND these. 'canvas' is not in the shared
-- policies' fenced list, so there it reads as every member's; these restrictive
-- policies fence it to whoever may read the canvas. The app's mirror is
-- src/lib/knowledge/entity-fences.ts (canvasFence). Same shape as 624 and 673.

create or replace function public.canvas_entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid)
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
  if p_type <> 'canvas' then return false; end if;
  select c.workspace_id into v_ws from public.canvas c where c.id = p_id;
  -- Gone, or not in the workspace asked about: not visible.
  if v_ws is null or (p_workspace is not null and v_ws <> p_workspace) then return false; end if;
  return public.canvas_visible_to(p_id, p_user);
end;
$$;

comment on function public.canvas_entity_visible_to(text, uuid, uuid, uuid) is
  'A canvas''s read rule for one record and one user (676): what the restrictive entity_link policies below ask. Any other kind is never the canvas''s to answer.';

revoke all on function public.canvas_entity_visible_to(text, uuid, uuid, uuid) from public, anon;
grant execute on function public.canvas_entity_visible_to(text, uuid, uuid, uuid) to authenticated, service_role;

drop policy if exists entity_link_canvas_select on public.entity_link;
create policy entity_link_canvas_select on public.entity_link
  as restrictive
  for select
  using (
    (source_type <> 'canvas'
     or public.canvas_entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type <> 'canvas'
     or public.canvas_entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

drop policy if exists entity_link_canvas_insert on public.entity_link;
create policy entity_link_canvas_insert on public.entity_link
  as restrictive
  for insert
  with check (
    (source_type <> 'canvas'
     or public.canvas_entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type <> 'canvas'
     or public.canvas_entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

drop policy if exists entity_link_canvas_update on public.entity_link;
create policy entity_link_canvas_update on public.entity_link
  as restrictive
  for update
  using (
    (source_type <> 'canvas'
     or public.canvas_entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type <> 'canvas'
     or public.canvas_entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  )
  with check (
    (source_type <> 'canvas'
     or public.canvas_entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type <> 'canvas'
     or public.canvas_entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

drop policy if exists entity_link_canvas_delete on public.entity_link;
create policy entity_link_canvas_delete on public.entity_link
  as restrictive
  for delete
  using (
    (source_type <> 'canvas'
     or public.canvas_entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))
    and (target_type <> 'canvas'
     or public.canvas_entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))
  );

-- ------------------------------------------------------------
-- 5. Realtime: one event per batch (canvas.version), and the items
-- ------------------------------------------------------------

alter table public.canvas replica identity full;
alter table public.canvas_item replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.canvas;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.canvas_item;
exception when duplicate_object then null;
end $$;

commit;

notify pgrst, 'reload schema';

-- ============================================================
-- 492: per-item access, one grant store (the shared entity layer, phase 5).
-- ============================================================
-- Today a record is readable by membership (is_workspace_member) plus a few
-- per-kind rules: a private document is its creator's (369), a private
-- capture its creator's (223), a private or team contact its creator's,
-- their teams' and the people it is shared with (058, contact_share), a
-- company an owner's or admin's or anyone's who can see one of its contacts
-- (059, 235). This adds ONE place to say "and these people, teams and
-- channels may read it too":
--
--   entity_access   one row per grant: a record (entity_type, entity_id, in
--                   workspace_id), a grantee (exactly one of a member, a
--                   team, or a team-chat channel, whose readers are the
--                   grantees: team_chat_can_read, 474), a level, who granted
--                   it and why (source: 'manual' from the share dialog,
--                   'mention' from an @-mention in team chat, 'channel_share'
--                   from the Share to a channel action).
--
-- ADDITIVE ONLY. A grant can only add access; nothing here (nor in 493,
-- which wires grants into the read policies) removes or narrows a rule.
--
-- Kinds: document, capture, contact, company: the four whose rows only some
-- members may read and that can be shared to a channel. Calendar events and
-- team-chat DMs stay their owner's and participants' (no grants on them).
--
-- Level: 'view' only, for now. The column takes 'edit' so a later phase can
-- add it without a table change, but the insert policy refuses it: no kind
-- here has a per-person editor concept a grant could map onto (a document's
-- editing is by role, a capture's by its owner; a contact's per-person edit
-- already lives in contact_share).
--
-- Who may share a record (insert a grant on it, or remove one):
-- entity_access_can_share, from each kind's EXISTING rule:
--   document  its creator (the only member who can read a private one);
--   capture   its creator (likewise; never an eval capture);
--   contact   its creator, or a workspace owner or admin (contact_share's
--             own insert rule);
--   company   a workspace owner or admin (the only members who can read
--             every company).
-- A grant's author may also remove it (Undo).
--
-- Who may read grants: whoever may share the record, and each grantee (a
-- member their own, a team's members the team's, a channel's readers the
-- channel's).
--
-- The read helpers (pinned search_path, SECURITY DEFINER, as 474's):
--   has_entity_grant(type, id, workspace)  does a grant on this record, in
--        this workspace, reach auth.uid(): as the member, through a team
--        they are in, or through a channel they can read?
--   my_entity_grant_ids(type)  every id of that kind a grant reaches
--        auth.uid() for, in one array: the read policies (493) compare a row
--        against it before asking has_entity_grant, so a list costs one
--        lookup per query, not one per row.
--   entity_grant_reaches(type, id, workspace, user)  has_entity_grant for an
--        explicit user (the service-role visibility twins in 493:
--        contact_visible_to, company_visible_to). Service role only.
--
-- Integrity (a trigger, so it holds for every writer, service role too): the
-- grantee and the record both belong to the grant's workspace. A grant can
-- therefore never reach across workspaces; the helpers also re-check the
-- workspace on read, so even a forged row (written with triggers off) does
-- nothing.
--
-- A grant on a record that is later deleted is inert (ids are never
-- reused); a workspace's grants go with it (on delete cascade), and so do a
-- member's, a team's and a channel's.
--
-- Idempotent (if not exists, create or replace, drop … if exists). No
-- backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

create table if not exists public.entity_access (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  grantee_kind text not null,
  grantee_member_id uuid references public.member(id) on delete cascade,
  grantee_team_id uuid references public.team(id) on delete cascade,
  grantee_channel_id uuid references public.team_chat_channel(id) on delete cascade,
  grantee_id uuid generated always as (coalesce(grantee_member_id, grantee_team_id, grantee_channel_id)) stored,
  level text not null default 'view',
  granted_by uuid references public.member(id) on delete set null,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  constraint entity_access_entity_type check (entity_type in ('document', 'capture', 'contact', 'company')),
  constraint entity_access_level check (level in ('view', 'edit')),
  constraint entity_access_source check (source in ('manual', 'mention', 'channel_share')),
  constraint entity_access_one_grantee check (
    (grantee_kind = 'member' and grantee_member_id is not null and grantee_team_id is null and grantee_channel_id is null)
    or (grantee_kind = 'team' and grantee_team_id is not null and grantee_member_id is null and grantee_channel_id is null)
    or (grantee_kind = 'channel' and grantee_channel_id is not null and grantee_member_id is null and grantee_team_id is null)
  ),
  constraint entity_access_unique unique (workspace_id, entity_type, entity_id, grantee_kind, grantee_id)
);

-- The unique key leads with (workspace_id, entity_type, entity_id): it is
-- has_entity_grant's lookup. These serve my_entity_grant_ids (from the
-- grantee side) and the cascades.
create index if not exists entity_access_member_idx on public.entity_access (grantee_member_id, entity_type) where grantee_member_id is not null;
create index if not exists entity_access_team_idx on public.entity_access (grantee_team_id, entity_type) where grantee_team_id is not null;
create index if not exists entity_access_channel_idx on public.entity_access (grantee_channel_id, entity_type) where grantee_channel_id is not null;
create index if not exists entity_access_granted_by_idx on public.entity_access (granted_by) where granted_by is not null;

-- ── Integrity: the grantee and the record live in the grant's workspace ──────
create or replace function public.entity_access_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A workspace merge (402) re-stamps every workspace_id by catalogue, table
  -- by table; the grantee's and the record's own tables may not have moved
  -- yet, so the check would refuse a sound merge. The merge asserts the
  -- whole destination itself.
  if coalesce(current_setting('dial8.workspace_merge', true), '') <> '' then
    return new;
  end if;
  -- A signed-in caller from outside the workspace learns nothing below (this
  -- runs before the insert policy, so its errors must not say what exists).
  if auth.uid() is not null and not public.is_workspace_member(new.workspace_id) then
    raise exception 'entity_access: not a member of this workspace' using errcode = '42501';
  end if;
  if new.grantee_kind = 'member' and not exists (
    select 1 from public.member m where m.id = new.grantee_member_id and m.workspace_id = new.workspace_id
  ) then
    raise exception 'entity_access: the member is not in this workspace' using errcode = '23514';
  end if;
  if new.grantee_kind = 'team' and not exists (
    select 1 from public.team t where t.id = new.grantee_team_id and t.workspace_id = new.workspace_id
  ) then
    raise exception 'entity_access: the team is not in this workspace' using errcode = '23514';
  end if;
  if new.grantee_kind = 'channel' and not exists (
    select 1 from public.team_chat_channel c where c.id = new.grantee_channel_id and c.workspace_id = new.workspace_id
  ) then
    raise exception 'entity_access: the channel is not in this workspace' using errcode = '23514';
  end if;
  if not (case new.entity_type
    when 'document' then exists (select 1 from public.document x where x.id = new.entity_id and x.workspace_id = new.workspace_id)
    when 'capture' then exists (select 1 from public.captures x where x.id = new.entity_id and x.workspace_id = new.workspace_id)
    when 'contact' then exists (select 1 from public.contact x where x.id = new.entity_id and x.workspace_id = new.workspace_id)
    when 'company' then exists (select 1 from public.company x where x.id = new.entity_id and x.workspace_id = new.workspace_id)
    else false
  end) then
    raise exception 'entity_access: the record is not in this workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.entity_access_guard() from public, anon, authenticated;

drop trigger if exists entity_access_guard on public.entity_access;
-- Not on granted_by: a member's removal sets it null and must never be
-- refused because the record has since gone.
create trigger entity_access_guard
  before insert or update of workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, grantee_team_id, grantee_channel_id
  on public.entity_access
  for each row execute function public.entity_access_guard();

-- ── Does a grant on this record reach the caller? ─────────────────────────────
create or replace function public.has_entity_grant(p_type text, p_id uuid, p_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1
      from public.entity_access g
     where g.workspace_id = p_workspace
       and g.entity_type = p_type
       and g.entity_id = p_id
       and (
         (g.grantee_kind = 'member'
            and g.grantee_member_id = public.current_member_id(p_workspace))
         or (g.grantee_kind = 'team'
            and exists (select 1 from public.team t where t.id = g.grantee_team_id and t.workspace_id = p_workspace)
            and public.is_team_member(g.grantee_team_id))
         or (g.grantee_kind = 'channel'
            and exists (select 1 from public.team_chat_channel c where c.id = g.grantee_channel_id and c.workspace_id = p_workspace)
            and public.team_chat_can_read(g.grantee_channel_id))
       )
  );
$$;

-- ── Every id of a kind a grant reaches the caller for (the policies' pre-check) ─
create or replace function public.my_entity_grant_ids(p_type text)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct g.entity_id), '{}'::uuid[])
    from public.member me
    join public.entity_access g
      on g.workspace_id = me.workspace_id
     and g.entity_type = p_type
   where me.user_id = auth.uid()
     and (
       (g.grantee_kind = 'member' and g.grantee_member_id = me.id)
       or (g.grantee_kind = 'team' and exists (
             select 1 from public.team_member tm
              where tm.team_id = g.grantee_team_id and tm.member_id = me.id))
       or (g.grantee_kind = 'channel' and public.team_chat_can_read(g.grantee_channel_id))
     );
$$;

-- ── has_entity_grant for an explicit user (service-role twins only) ──────────
-- The channel arm restates 474's team_chat_can_read for p_user: a member of
-- the channel's workspace and, for a team channel, of its team; for a DM,
-- one of its members.
create or replace function public.entity_grant_reaches(p_type text, p_id uuid, p_workspace uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user is not null and exists (
    select 1
      from public.member me
      join public.entity_access g
        on g.workspace_id = me.workspace_id
     where me.user_id = p_user
       and me.workspace_id = p_workspace
       and g.entity_type = p_type
       and g.entity_id = p_id
       and (
         (g.grantee_kind = 'member' and g.grantee_member_id = me.id)
         or (g.grantee_kind = 'team' and exists (
               select 1 from public.team t
                 join public.team_member tm on tm.team_id = t.id
                where t.id = g.grantee_team_id and t.workspace_id = p_workspace and tm.member_id = me.id))
         or (g.grantee_kind = 'channel' and exists (
               select 1 from public.team_chat_channel c
                where c.id = g.grantee_channel_id
                  and c.workspace_id = p_workspace
                  and (
                    (c.kind = 'channel' and (c.team_id is null or exists (
                       select 1 from public.team_member tm where tm.team_id = c.team_id and tm.member_id = me.id)))
                    or (c.kind = 'dm' and exists (
                       select 1 from public.team_chat_member cm where cm.channel_id = c.id and cm.member_id = me.id))
                  )))
       )
  );
$$;

-- ── May the caller share this record? (each kind's existing rule) ────────────
create or replace function public.entity_access_can_share(p_type text, p_id uuid, p_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and public.is_workspace_member(p_workspace)
    and case p_type
      when 'document' then exists (
        select 1 from public.document d
         where d.id = p_id and d.workspace_id = p_workspace
           and d.created_by is not null
           and d.created_by = public.current_member_id(p_workspace))
      when 'capture' then exists (
        select 1 from public.captures c
         where c.id = p_id and c.workspace_id = p_workspace
           and c.user_id = auth.uid()
           and not c.is_eval)
      when 'contact' then exists (
        select 1 from public.contact ct
         where ct.id = p_id and ct.workspace_id = p_workspace
           and ((ct.created_by_member_id is not null and ct.created_by_member_id = public.current_member_id(p_workspace))
                or public.get_member_role(p_workspace) in ('owner', 'admin')))
      when 'company' then exists (
        select 1 from public.company co
         where co.id = p_id and co.workspace_id = p_workspace
           and public.get_member_role(p_workspace) in ('owner', 'admin'))
      else false
    end;
$$;

revoke all on function public.has_entity_grant(text, uuid, uuid) from public, anon;
revoke all on function public.my_entity_grant_ids(text) from public, anon;
revoke all on function public.entity_access_can_share(text, uuid, uuid) from public, anon;
revoke all on function public.entity_grant_reaches(text, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.has_entity_grant(text, uuid, uuid) to authenticated, service_role;
grant execute on function public.my_entity_grant_ids(text) to authenticated, service_role;
grant execute on function public.entity_access_can_share(text, uuid, uuid) to authenticated, service_role;
grant execute on function public.entity_grant_reaches(text, uuid, uuid, uuid) to service_role;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.entity_access enable row level security;

revoke all on table public.entity_access from anon, authenticated;
grant select, insert, delete on table public.entity_access to authenticated;
grant all on table public.entity_access to service_role;

drop policy if exists entity_access_select on public.entity_access;
create policy entity_access_select on public.entity_access
  for select to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (
      (grantee_kind = 'member' and grantee_member_id = public.current_member_id(workspace_id))
      or (grantee_kind = 'team' and public.is_team_member(grantee_team_id))
      or (grantee_kind = 'channel' and public.team_chat_can_read(grantee_channel_id))
      or public.entity_access_can_share(entity_type, entity_id, workspace_id)
    )
  );

-- Only someone who may share the record, as themselves, view level, to a
-- team they can see or a channel they can read.
drop policy if exists entity_access_insert on public.entity_access;
create policy entity_access_insert on public.entity_access
  for insert to authenticated
  with check (
    granted_by = public.current_member_id(workspace_id)
    and level = 'view'
    and public.entity_access_can_share(entity_type, entity_id, workspace_id)
    and (grantee_kind <> 'team' or exists (
          select 1 from public.team t
           where t.id = grantee_team_id and t.workspace_id = entity_access.workspace_id
             and (not t.is_private or public.is_team_member(t.id))))
    and (grantee_kind <> 'channel' or public.team_chat_can_read(grantee_channel_id))
  );

-- Whoever may share the record, or the grant's own author (Undo).
drop policy if exists entity_access_delete on public.entity_access;
create policy entity_access_delete on public.entity_access
  for delete to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (
      public.entity_access_can_share(entity_type, entity_id, workspace_id)
      or (granted_by is not null and granted_by = public.current_member_id(workspace_id))
    )
  );
-- No update policy: a grant is added or removed, never changed.
